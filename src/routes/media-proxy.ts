import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { Semaphore, TtlLruCache } from "../cache/memory-cache.ts";
import { ipv4Fetch, ipv4FetchRaw, type FetchLike } from "../net/ipv4-fetch.ts";

interface CachedBinary {
  status: number;
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
}

interface CachedFeed {
  status: number;
  contentType: string;
  body: string;
}

const VALID_VI_PATH = /^\/vi\/[A-Za-z0-9_-]{6,20}\/[A-Za-z0-9_.-]+\.(jpg|jpeg|webp|png)$/i;
const VALID_FEED_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class MediaProxyRoutes {
  private readonly thumbCache: TtlLruCache<string, CachedBinary>;
  private readonly feedCache: TtlLruCache<string, CachedFeed>;
  private readonly feedSemaphore: Semaphore;
  private readonly thumbSemaphore = new Semaphore(48);

  constructor(
    private readonly config: AppConfig,
    private readonly fetchFn: FetchLike = ipv4Fetch,
    private readonly fetchRawFn: FetchLike = ipv4FetchRaw,
    private readonly logger: Logger = noopLogger,
  ) {
    this.thumbCache = new TtlLruCache<string, CachedBinary>(
      config.thumbnails.maxEntries,
      config.thumbnails.cacheTtlSec * 1000,
    );
    this.feedCache = new TtlLruCache<string, CachedFeed>(
      2000,
      config.rss.cacheTtlSec * 1000,
    );
    this.feedSemaphore = new Semaphore(config.rss.maxConcurrentUpstream);
  }

  /**
   * GET /vi/<videoId>/<file>.jpg -> https://i.ytimg.com/vi/<videoId>/<file>.jpg (IPv4 + LRU cache)
   */
  async handleVideoThumbnail(pathname: string, method: string): Promise<Response> {
    if (!VALID_VI_PATH.test(pathname)) {
      return Response.json({ error: "Invalid thumbnail path" }, { status: 400 });
    }

    const upstreamUrl = `https://i.ytimg.com${pathname}`;
    return await this.serveCachedImage(`vi:${pathname}`, [upstreamUrl], method);
  }

  /**
   * GET /ggpht/<rest> -> https://yt3.ggpht.com/<rest> (fallback yt3.googleusercontent.com or i.ytimg.com)
   */
  async handleGgphtProxy(pathname: string, search: string, method: string): Promise<Response> {
    const rest = pathname.slice("/ggpht".length);
    if (!rest || !rest.startsWith("/") || rest.includes("..") || rest.includes("@")) {
      return Response.json({ error: "Invalid image proxy path" }, { status: 400 });
    }

    const pathWithQuery = `${rest}${search}`;
    const candidates = rest.startsWith("/vi/") || rest.startsWith("/sb/")
      ? [`https://i.ytimg.com${pathWithQuery}`]
      : [
          `https://yt3.ggpht.com${pathWithQuery}`,
          `https://yt3.googleusercontent.com${pathWithQuery}`,
        ];

    return await this.serveCachedImage(`ggpht:${pathWithQuery}`, candidates, method);
  }

  /**
   * GET/HEAD /feed/playlist/:id and /feed/channel/:id
   * Concurrency-safe for 200+ simultaneous FreeTube subscription refreshes.
   */
  async handleFeed(kind: "playlist" | "channel", id: string, method: string): Promise<Response> {
    if (!VALID_FEED_ID.test(id)) {
      return Response.json({ error: `Invalid ${kind} feed id` }, { status: 400 });
    }

    const paramKey = kind === "playlist" ? "playlist_id" : "channel_id";
    const upstreamUrl = `https://www.youtube.com/feeds/videos.xml?${paramKey}=${encodeURIComponent(id)}`;
    const cacheKey = `feed:${kind}:${id}`;

    try {
      const entry = await this.feedCache.getOrCompute(cacheKey, async () => {
        return await this.feedSemaphore.run(async () => {
          let lastStatus = 502;
          let lastBody = "";
          let lastContentType = "application/atom+xml; charset=utf-8";

          // Up to 2 attempts for transient network/5xx errors during 200-feed bursts
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const res = await this.fetchFn(upstreamUrl, {
                method: "GET",
                headers: {
                  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                  Accept: "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
                },
              });
              lastStatus = res.status;
              lastContentType = res.headers.get("content-type") || "application/atom+xml; charset=utf-8";
              lastBody = await res.text();

              if (res.status === 200 || res.status === 404) {
                break;
              }
              if (res.status >= 500 && attempt === 0) {
                await new Promise((r) => setTimeout(r, 250));
                continue;
              }
              break;
            } catch (err) {
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 250));
                continue;
              }
              throw err;
            }
          }

          if (lastStatus === 200) {
            return {
              value: { status: 200, contentType: lastContentType, body: lastBody },
              ttlMs: this.config.rss.cacheTtlSec * 1000,
              cache: true,
            };
          }
          if (lastStatus === 404) {
            return {
              value: { status: 404, contentType: "text/plain; charset=utf-8", body: "Not Found" },
              ttlMs: this.config.rss.negativeCacheTtlSec * 1000,
              cache: true,
            };
          }
          return {
            value: { status: lastStatus, contentType: lastContentType, body: lastBody },
            cache: false,
          };
        });
      });

      return new Response(method === "HEAD" ? null : entry.body, {
        status: entry.status,
        headers: {
          "Content-Type": entry.contentType,
          "Cache-Control": entry.status === 200 ? `public, max-age=${this.config.rss.cacheTtlSec}` : "no-store",
        },
      });
    } catch (err) {
      this.logger.warn("RSS feed IPv4 proxy error", {
        kind,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response("Upstream feed fetch failed", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  private async serveCachedImage(
    cacheKey: string,
    candidateUrls: string[],
    method: string,
  ): Promise<Response> {
    try {
      const entry = await this.thumbCache.getOrCompute(cacheKey, async () => {
        return await this.thumbSemaphore.run(async () => {
          let lastStatus = 404;
          let lastType = "image/jpeg";
          let lastBytes = new Uint8Array(0);

          for (const url of candidateUrls) {
            const res = await this.fetchRawFn(url, {
              method: "GET",
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
              },
            });
            lastStatus = res.status;
            lastType = res.headers.get("content-type") || "image/jpeg";
            if (res.ok) {
              lastBytes = new Uint8Array(await res.arrayBuffer());
              const shouldCache = lastBytes.byteLength <= this.config.thumbnails.maxEntryBytes;
              return {
                value: { status: 200, contentType: lastType, body: lastBytes },
                ttlMs: this.config.thumbnails.cacheTtlSec * 1000,
                cache: shouldCache,
              };
            }
            await res.body?.cancel().catch(() => {});
            if (res.status !== 404) break;
          }

          return {
            value: { status: lastStatus, contentType: lastType, body: new Uint8Array(0) },
            ttlMs: 60_000,
            cache: lastStatus === 404,
          };
        });
      });

      if (entry.status !== 200) {
        return new Response(null, { status: entry.status });
      }

      return new Response(method === "HEAD" ? null : entry.body, {
        status: 200,
        headers: {
          "Content-Type": entry.contentType,
          "Content-Length": String(entry.body.byteLength),
          "Cache-Control": `public, max-age=${this.config.thumbnails.cacheTtlSec}`,
        },
      });
    } catch (err) {
      this.logger.warn("Image IPv4 proxy error", {
        cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 502 });
    }
  }
}

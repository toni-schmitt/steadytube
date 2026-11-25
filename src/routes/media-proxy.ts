import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { Semaphore, TtlLruCache } from "../cache/memory-cache.ts";
import {
  ipv4Fetch,
  ipv4FetchRaw,
  readBoundedResponseBytes,
  type FetchLike,
} from "../net/ipv4-fetch.ts";

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
const ALLOWED_IMAGE_HOST = /^(?:i\d*\.ytimg\.com|yt\d+\.ggpht\.com|yt\d+\.googleusercontent\.com|lh\d+\.googleusercontent\.com)$/i;
const ALLOWED_FEED_HOST = /^(?:www\.)?youtube\.com$/i;
const UPSTREAM_PROXY_TIMEOUT_MS = 20_000;
const MAX_FEED_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB cap for Atom/XML RSS feeds
const MIN_MAX_IMAGE_PROXY_BYTES = 10 * 1024 * 1024; // 10 MiB hard cap for uncached image proxying
const MAX_THUMB_CACHE_BYTES = 64 * 1024 * 1024; // 64 MiB total RAM cap for thumbnail cache
const MAX_FEED_CACHE_BYTES = 32 * 1024 * 1024; // 32 MiB total RAM cap for RSS feed cache
const MAX_SEMAPHORE_QUEUE_SIZE = 256;
const SEMAPHORE_WAIT_TIMEOUT_MS = 15_000;

interface SharedInflightEntry<T> {
  promise: Promise<T>;
  waiters: number;
  controller: AbortController;
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(getAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(getAbortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(getAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(getAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// Requests within one refresh arrive ~70 ms apart; a feed family idle this long starts a new refresh.
const FEED_REFRESH_GAP_MS = 60_000;
// Feeds no refresh has asked for in this long (e.g. unsubscribed channels) stop being prefetched.
const FEED_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const FEED_REMEMBER_MAX = 2000;

type FeedKind = "playlist" | "channel";

export class MediaProxyRoutes {
  private readonly thumbCache: TtlLruCache<string, CachedBinary>;
  private readonly feedCache: TtlLruCache<string, CachedFeed>;
  private readonly feedInflight = new Map<string, SharedInflightEntry<CachedFeed>>();
  private readonly thumbInflight = new Map<string, SharedInflightEntry<CachedBinary>>();
  private readonly feedSemaphore: Semaphore;
  private readonly thumbSemaphore = new Semaphore(48, MAX_SEMAPHORE_QUEUE_SIZE);
  // shortcut: in memory only, so the first refresh after a daemon restart is still slow; persist to cacheDir if restarts become frequent.
  private readonly feedFamilies = new Map<string, { lastRequestAt: number; ids: Map<string, number> }>();
  private readonly prefetchQueue: Array<{ kind: FeedKind; id: string }> = [];
  private prefetchWorkers = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchFn: FetchLike = ipv4Fetch,
    private readonly fetchRawFn: FetchLike = ipv4FetchRaw,
    private readonly logger: Logger = noopLogger,
  ) {
    this.thumbCache = new TtlLruCache<string, CachedBinary>(
      config.thumbnails.maxEntries,
      config.thumbnails.cacheTtlSec * 1000,
      {
        maxTotalBytes: MAX_THUMB_CACHE_BYTES,
        sizeOf: (v) => v.body.byteLength,
      },
    );
    this.feedCache = new TtlLruCache<string, CachedFeed>(
      2000,
      config.rss.cacheTtlSec * 1000,
      {
        maxTotalBytes: MAX_FEED_CACHE_BYTES,
        sizeOf: (v) => v.body.length * 2,
      },
    );
    this.feedSemaphore = new Semaphore(config.rss.maxConcurrentUpstream, MAX_SEMAPHORE_QUEUE_SIZE);
  }

  /**
   * Single-flight cache compute with ref-counted live waiters:
   * - Concurrent callers share one upstream work item.
   * - If one caller aborts while others remain, the shared work stays alive.
   * - If the LAST caller aborts, the shared AbortController aborts immediately,
   *   cancelling queued semaphore waits and upstream fetches without starving live work.
   */
  private async runSharedCached<T>(
    cache: TtlLruCache<string, T>,
    inflightMap: Map<string, SharedInflightEntry<T>>,
    cacheKey: string,
    reqSignal: AbortSignal | undefined,
    compute: (sharedSignal: AbortSignal) => Promise<{ value: T; ttlMs?: number; cache?: boolean }>,
  ): Promise<T> {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (reqSignal?.aborted) {
      throw getAbortError(reqSignal);
    }

    let entry = inflightMap.get(cacheKey);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const created: SharedInflightEntry<T> = {
        waiters: 0,
        controller,
        promise: Promise.resolve(undefined as unknown as T),
      };
      created.promise = (async () => {
        try {
          const result = await compute(controller.signal);
          if (result.cache !== false) {
            cache.set(cacheKey, result.value, result.ttlMs);
          }
          return result.value;
        } finally {
          if (inflightMap.get(cacheKey) === created) {
            inflightMap.delete(cacheKey);
          }
        }
      })();
      // Prevent unhandled rejection if last waiter detaches before rejection settles
      created.promise.catch(() => {});
      inflightMap.set(cacheKey, created);
      entry = created;
    }

    const activeEntry = entry;
    activeEntry.waiters++;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      reqSignal?.removeEventListener("abort", detach);
      activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
      if (activeEntry.waiters === 0) {
        activeEntry.controller.abort(new DOMException("All callers aborted", "AbortError"));
        if (inflightMap.get(cacheKey) === activeEntry) {
          inflightMap.delete(cacheKey);
        }
      }
    };
    reqSignal?.addEventListener("abort", detach, { once: true });

    try {
      return await raceWithAbort(activeEntry.promise, reqSignal);
    } finally {
      detach();
    }
  }

  /**
   * GET /vi/<videoId>/<file>.jpg -> https://i.ytimg.com/vi/<videoId>/<file>.jpg (IPv4 + LRU cache)
   */
  async handleVideoThumbnail(
    pathname: string,
    method: string,
    reqSignal?: AbortSignal,
  ): Promise<Response> {
    if (!VALID_VI_PATH.test(pathname)) {
      return Response.json({ error: "Invalid thumbnail path" }, { status: 400 });
    }

    const upstreamUrl = `https://i.ytimg.com${pathname}`;
    return await this.serveCachedImage(`vi:${pathname}`, [upstreamUrl], method, reqSignal);
  }

  /**
   * GET /ggpht/<rest> -> https://yt3.ggpht.com/<rest> (fallback yt3.googleusercontent.com or i.ytimg.com)
   */
  async handleGgphtProxy(
    pathname: string,
    search: string,
    method: string,
    reqSignal?: AbortSignal,
  ): Promise<Response> {
    const rest = pathname.slice("/ggpht".length);
    if (
      !rest ||
      !rest.startsWith("/") ||
      rest.includes("..") ||
      rest.includes("@") ||
      /%2e|%2f|%5c|%00/i.test(rest)
    ) {
      return Response.json({ error: "Invalid image proxy path" }, { status: 400 });
    }

    const pathWithQuery = `${rest}${search}`;
    const candidates = rest.startsWith("/vi/") || rest.startsWith("/sb/")
      ? [`https://i.ytimg.com${pathWithQuery}`]
      : [
          `https://yt3.ggpht.com${pathWithQuery}`,
          `https://yt3.googleusercontent.com${pathWithQuery}`,
        ];

    return await this.serveCachedImage(`ggpht:${pathWithQuery}`, candidates, method, reqSignal);
  }

  /**
   * GET/HEAD /feed/playlist/:id and /feed/channel/:id
   * Concurrency-safe for 200+ simultaneous FreeTube subscription refreshes.
   */
  async handleFeed(
    kind: FeedKind,
    id: string,
    method: string,
    reqSignal?: AbortSignal,
  ): Promise<Response> {
    if (!VALID_FEED_ID.test(id)) {
      return Response.json({ error: `Invalid ${kind} feed id` }, { status: 400 });
    }
    if (reqSignal?.aborted) {
      return new Response(null, { status: 499 });
    }

    try {
      // Started before the prefetch so the triggering request is first in the semaphore queue.
      const pending = this.loadFeed(kind, id, reqSignal);
      this.prefetchFeedFamily(kind, id);
      const entry = await pending;

      return new Response(method === "HEAD" ? null : entry.body, {
        status: entry.status,
        headers: {
          "Content-Type": entry.contentType,
          "Content-Length": String(Buffer.byteLength(entry.body, "utf8")),
          "Cache-Control": entry.status === 200 ? `public, max-age=${this.config.rss.cacheTtlSec}` : "no-store",
        },
      });
    } catch (err) {
      if (reqSignal?.aborted) {
        return new Response(null, { status: 499 });
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Semaphore")) {
        return new Response("Upstream feed proxy busy", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      this.logger.warn("RSS feed IPv4 proxy error", {
        kind,
        id,
        error: errMsg,
      });
      return new Response("Upstream feed fetch failed", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  /**
   * FreeTube sends a whole subscription refresh at once, but Chromium only opens ~6 connections
   * per host, so ~300 feeds at ~370 ms upstream each take 20+ s. On the first request of a
   * refresh, fetch every feed of the same family that earlier refreshes asked for, at full
   * upstream concurrency; FreeTube's queued requests then join those fetches or hit the cache.
   */
  private prefetchFeedFamily(kind: FeedKind, id: string): void {
    // UULF/UUSH/UULV are a channel's videos/shorts/live playlists, each refreshed by its own FreeTube tab.
    const familyKey = kind === "playlist" && id.startsWith("UU") ? id.slice(0, 4) : kind;
    const now = Date.now();
    let family = this.feedFamilies.get(familyKey);
    if (!family) {
      family = { lastRequestAt: 0, ids: new Map() };
      this.feedFamilies.set(familyKey, family);
    }
    const startsRefresh = now - family.lastRequestAt > FEED_REFRESH_GAP_MS;
    family.lastRequestAt = now;
    // Re-insert so Map order stays least-recently-requested first for the size cap.
    family.ids.delete(id);
    family.ids.set(id, now);
    if (family.ids.size > FEED_REMEMBER_MAX) family.ids.delete(family.ids.keys().next().value!);
    if (!startsRefresh) return;

    for (const [knownId, requestedAt] of family.ids) {
      if (now - requestedAt > FEED_REMEMBER_MS) {
        family.ids.delete(knownId);
        continue;
      }
      if (knownId !== id) this.queuePrefetch(kind, knownId);
    }
  }

  /**
   * Prefetches run on at most `maxConcurrentUpstream` workers, so they hold at most that many
   * feed-semaphore slots. Calling loadFeed for every feed of a 300-channel refresh at once would
   * overflow the semaphore's bounded queue and turn FreeTube's own requests into 503 "proxy busy".
   */
  private queuePrefetch(kind: FeedKind, id: string): void {
    this.prefetchQueue.push({ kind, id });
    if (this.prefetchWorkers >= this.config.rss.maxConcurrentUpstream) return;
    this.prefetchWorkers++;
    void (async () => {
      for (let job = this.prefetchQueue.shift(); job; job = this.prefetchQueue.shift()) {
        // A failed prefetch is not cached, so FreeTube's own request for that feed retries it.
        await this.loadFeed(job.kind, job.id).catch(() => {});
      }
      this.prefetchWorkers--;
    })();
  }

  private async loadFeed(kind: FeedKind, id: string, reqSignal?: AbortSignal): Promise<CachedFeed> {
    const paramKey = kind === "playlist" ? "playlist_id" : "channel_id";
    const upstreamUrl = `https://www.youtube.com/feeds/videos.xml?${paramKey}=${encodeURIComponent(id)}`;

    return await this.runSharedCached(
      this.feedCache,
      this.feedInflight,
      `feed:${kind}:${id}`,
      reqSignal,
      async (sharedSignal) => {
        return await this.feedSemaphore.run(
          async () => {
            let lastStatus = 502;
            let lastBody = "";
            let lastContentType = "application/atom+xml; charset=utf-8";

            // Up to 2 attempts for transient network/5xx errors during 200-feed bursts
            for (let attempt = 0; attempt < 2; attempt++) {
              if (sharedSignal.aborted) {
                throw getAbortError(sharedSignal);
              }
              try {
                const attemptSignal = AbortSignal.any([
                  sharedSignal,
                  AbortSignal.timeout(UPSTREAM_PROXY_TIMEOUT_MS),
                ]);
                const res = await this.fetchFn(upstreamUrl, {
                  method: "GET",
                  timeoutMs: UPSTREAM_PROXY_TIMEOUT_MS,
                  signal: attemptSignal,
                  httpsOnly: true,
                  publicIpv4Only: true,
                  allowedHost: (h) => ALLOWED_FEED_HOST.test(h),
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                    Accept: "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
                  },
                });
                lastStatus = res.status;
                lastContentType = res.headers.get("content-type") || "application/atom+xml; charset=utf-8";

                if (res.status === 404) {
                  await res.body?.cancel().catch(() => {});
                  lastBody = "Not Found";
                  break;
                }
                if (res.status >= 500 && attempt === 0) {
                  await res.body?.cancel().catch(() => {});
                  await sleepWithAbort(250, sharedSignal);
                  continue;
                }

                const bodyBytes = await readBoundedResponseBytes(res, MAX_FEED_BODY_BYTES);
                lastBody = new TextDecoder("utf-8").decode(bodyBytes);
                break;
              } catch (err) {
                if (sharedSignal.aborted) throw err;
                if (attempt === 0) {
                  await sleepWithAbort(250, sharedSignal);
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
          },
          SEMAPHORE_WAIT_TIMEOUT_MS,
          sharedSignal,
        );
      },
    );
  }

  private async serveCachedImage(
    cacheKey: string,
    candidateUrls: string[],
    method: string,
    reqSignal?: AbortSignal,
  ): Promise<Response> {
    if (reqSignal?.aborted) {
      return new Response(null, { status: 499 });
    }
    try {
      const entry = await this.runSharedCached(
        this.thumbCache,
        this.thumbInflight,
        cacheKey,
        reqSignal,
        async (sharedSignal) => {
          return await this.thumbSemaphore.run(
            async () => {
              let lastStatus = 404;
              let lastType = "image/jpeg";
              let lastBytes = new Uint8Array(0);

              const maxProxyImageBytes = Math.max(
                this.config.thumbnails.maxEntryBytes,
                MIN_MAX_IMAGE_PROXY_BYTES,
              );

              for (const url of candidateUrls) {
                if (sharedSignal.aborted) {
                  throw getAbortError(sharedSignal);
                }
                const attemptSignal = AbortSignal.any([
                  sharedSignal,
                  AbortSignal.timeout(UPSTREAM_PROXY_TIMEOUT_MS),
                ]);
                const res = await this.fetchRawFn(url, {
                  method: "GET",
                  timeoutMs: UPSTREAM_PROXY_TIMEOUT_MS,
                  signal: attemptSignal,
                  httpsOnly: true,
                  publicIpv4Only: true,
                  allowedHost: (h) => ALLOWED_IMAGE_HOST.test(h),
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                    Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                  },
                });
                lastStatus = res.status;
                lastType = res.headers.get("content-type") || "image/jpeg";
                if (res.ok) {
                  lastBytes = await readBoundedResponseBytes(res, maxProxyImageBytes);
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
            },
            SEMAPHORE_WAIT_TIMEOUT_MS,
            sharedSignal,
          );
        },
      );

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
      if (reqSignal?.aborted) {
        return new Response(null, { status: 499 });
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Semaphore")) {
        return new Response("Upstream image proxy busy", { status: 503 });
      }
      this.logger.warn("Image IPv4 proxy error", {
        cacheKey,
        error: errMsg,
      });
      return new Response(null, { status: 502 });
    }
  }
}

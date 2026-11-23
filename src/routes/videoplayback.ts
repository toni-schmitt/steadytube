import fs from "node:fs";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import type { EphemeralStore } from "../cache/ephemeral-store.ts";
import type { StreamTarget, StreamTargetRemote, VideoResolver } from "../media/video-resolver.ts";
import { VALID_VIDEO_ID_RE } from "../media/ytdlp.ts";
import { ipv4FetchRaw, type FetchLike } from "../net/ipv4-fetch.ts";

const ALLOWED_GOOGLEVIDEO_HOST = /^[a-z0-9-]+\.googlevideo\.com$/i;

function isRecoverableStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 410 || status === 429 || status >= 500;
}

/**
 * Wraps an upstream ReadableStream with a per-chunk stall watchdog so that if
 * googlevideo.com stops sending bytes mid-segment, we abort cleanly and mark
 * the cached target stale for recovery on retry.
 *
 * Client-initiated aborts (`signal.aborted` or stream `cancel()`) never invoke
 * `onStall`, avoiding false stale-marking when FreeTube/Shaka cancels a seek,
 * quality switch, or timed-out segment fetch.
 */
export function withStallWatchdog(
  source: ReadableStream<Uint8Array>,
  stallTimeoutMs: number,
  signal: AbortSignal | undefined,
  onStall: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  let cancelled = false;
  let clientAborted = Boolean(signal?.aborted);
  let stallReported = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const reportStallOnce = () => {
    if (stallReported || cancelled || clientAborted || signal?.aborted) return;
    stallReported = true;
    onStall();
  };

  const getAbortError = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");

  const onSignalAbort = () => {
    clientAborted = true;
    clearTimer();
    reader.cancel(getAbortError()).catch(() => {});
  };

  const cleanup = () => {
    clearTimer();
    signal?.removeEventListener("abort", onSignalAbort);
  };

  if (signal && !signal.aborted) {
    signal.addEventListener("abort", onSignalAbort, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        cleanup();
        return;
      }
      if (clientAborted || signal?.aborted) {
        cleanup();
        await reader.cancel(getAbortError()).catch(() => {});
        try {
          controller.error(getAbortError());
        } catch {
          // Already closed
        }
        return;
      }

      clearTimer();
      timer = setTimeout(() => {
        if (cancelled || clientAborted || signal?.aborted) {
          cleanup();
          return;
        }
        stalled = true;
        cleanup();
        reportStallOnce();
        reader.cancel(new Error("Upstream stream stalled")).catch(() => {});
        try {
          controller.error(new Error(`Upstream stream stalled for ${stallTimeoutMs}ms`));
        } catch {
          // Already closed
        }
      }, stallTimeoutMs);

      try {
        const { done, value } = await reader.read();
        clearTimer();
        if (stalled || cancelled) return;
        if (clientAborted || signal?.aborted) {
          cleanup();
          try {
            controller.error(getAbortError());
          } catch {
            // Already closed
          }
          return;
        }
        if (done) {
          cleanup();
          controller.close();
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (err) {
        cleanup();
        if (!stalled && !cancelled) {
          if (!clientAborted && !signal?.aborted) {
            reportStallOnce();
          }
          try {
            controller.error(clientAborted || signal?.aborted ? getAbortError() : err);
          } catch {
            // Already closed
          }
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      cleanup();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export class VideoPlaybackRoute {
  constructor(
    private readonly config: AppConfig,
    private readonly resolver: VideoResolver,
    private readonly ephemeralStore: EphemeralStore,
    private readonly fetchRaw: FetchLike = ipv4FetchRaw,
    private readonly logger: Logger = noopLogger,
  ) {}

  async handle(req: Request, url: URL, origin: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const videoId = url.searchParams.get("v");
    const formatId = url.searchParams.get("fid");
    const itagParam = url.searchParams.get("itag");
    const itag = itagParam && /^\d+$/.test(itagParam) ? Number(itagParam) : 0;

    // Case 1: Standard daemon-issued proxy URL (?v=<id>&fid=<fid>&itag=<itag>...)
    if (videoId !== null) {
      if (!VALID_VIDEO_ID_RE.test(videoId)) {
        return Response.json({ error: "Invalid video id" }, { status: 400 });
      }

      let target = this.resolver.getStreamTarget(videoId, formatId, itag);
      if (!target) {
        try {
          const rec = await this.resolver.resolveVideo(videoId, origin);
          target =
            (formatId ? rec.targetsByFid.get(formatId) : undefined) ||
            (itag > 0 ? rec.targetsByItag.get(itag) : undefined) ||
            null;
        } catch (err) {
          this.logger.warn("Failed to re-resolve video on /videoplayback cache miss", {
            videoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!target) {
        return Response.json({ error: "Stream format not found" }, { status: 404 });
      }

      return await this.serveTarget(req, target, origin);
    }

    // Case 2: Invidious-style ?host=rrX.googlevideo.com fallback proxy (strictly validated host)
    const rawHost = url.searchParams.get("host");
    if (rawHost && ALLOWED_GOOGLEVIDEO_HOST.test(rawHost)) {
      const upstream = new URL(`https://${rawHost}/videoplayback`);
      url.searchParams.forEach((value, key) => {
        if (key !== "host" && key !== "local") {
          upstream.searchParams.append(key, value);
        }
      });
      return await this.proxyDirectUpstream(req, upstream.toString(), {}, "video/mp4", 1);
    }

    return Response.json({ error: "Missing video stream parameters" }, { status: 400 });
  }

  private async serveTarget(req: Request, target: StreamTarget, origin: string): Promise<Response> {
    // Tier 3 local ephemeral buffer file
    if (target.kind === "local") {
      return this.serveLocalTargetOr503(target, req);
    }

    // Fast path for HEAD when we already know content length
    if (req.method === "HEAD" && target.clen > 0) {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": target.mimeType,
          "Content-Length": String(target.clen),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=300",
          "X-SteadyTube-Tier": String(target.tier),
        },
      });
    }

    // If a previous body stalled on this target, immediately escalate before trying it again
    let current: StreamTargetRemote = target;
    if (current.stale) {
      const preRecovered = await this.resolver.recoverFormatMidPlayback(
        current.videoId,
        current.formatId,
        current.itag,
        origin,
        current,
      );
      if (preRecovered) {
        if (preRecovered.kind === "local") {
          return this.serveLocalTargetOr503(preRecovered, req);
        }
        current = preRecovered;
      }
    }

    // Try current remote target over IPv4; transparently recover on 403/410/429/5xx/network error
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchUpstreamSegment(req, current);
        if (res.status === 200 || res.status === 206 || res.status === 416) {
          return this.buildStreamResponse(req, res, current);
        }

        await res.body?.cancel().catch(() => {});

        if (!isRecoverableStatus(res.status) || attempt === 2) {
          return new Response(null, { status: res.status });
        }

        this.logger.warn("Upstream /videoplayback returned recoverable error", {
          videoId: current.videoId,
          formatId: current.formatId,
          status: res.status,
          tier: current.tier,
          attempt,
        });
      } catch (err) {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }
        if (attempt === 2) {
          this.logger.error("Upstream /videoplayback failed after recovery attempts", {
            videoId: current.videoId,
            formatId: current.formatId,
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response("Upstream stream error", { status: 502 });
        }
        this.logger.warn("Upstream /videoplayback network error; recovering", {
          videoId: current.videoId,
          formatId: current.formatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const recovered = await this.resolver.recoverFormatMidPlayback(
        current.videoId,
        current.formatId,
        current.itag,
        origin,
        current,
      );

      if (!recovered) {
        return new Response("Upstream stream unavailable", { status: 503 });
      }
      if (recovered.kind === "local") {
        return this.serveLocalTargetOr503(recovered, req);
      }
      current = recovered;
    }

    return new Response("Upstream stream exhausted", { status: 502 });
  }

  private serveLocalTargetOr503(
    target: Extract<StreamTarget, { kind: "local" }>,
    req: Request,
  ): Response {
    const entry = this.ephemeralStore.get(target.videoId, target.formatId);
    if (entry) {
      return this.ephemeralStore.serveFile(entry, req);
    }
    if (fs.existsSync(target.filePath)) {
      const reRegistered = this.ephemeralStore.register(
        target.videoId,
        target.formatId,
        target.filePath,
        target.mimeType,
      );
      return this.ephemeralStore.serveFile(reRegistered, req);
    }
    this.resolver.invalidateVideo(target.videoId);
    return new Response("Cached stream expired; reload required", { status: 503 });
  }

  private async fetchUpstreamSegment(req: Request, target: StreamTargetRemote): Promise<Response> {
    const headers: Record<string, string> = {
      ...target.httpHeaders,
      "Accept-Encoding": "identity",
    };
    const range = req.headers.get("range");
    if (range) {
      headers["Range"] = range;
    }
    return await this.fetchRaw(target.url, {
      method: req.method,
      headers,
      signal: req.signal,
      httpsOnly: true,
      publicIpv4Only: true,
      allowedHost: (h) => ALLOWED_GOOGLEVIDEO_HOST.test(h),
    });
  }

  private buildStreamResponse(
    req: Request,
    upstream: Response,
    target: StreamTargetRemote,
  ): Response {
    const outHeaders = new Headers();
    outHeaders.set("Content-Type", upstream.headers.get("content-type") || target.mimeType);
    outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) outHeaders.set("Content-Length", contentLength);

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) outHeaders.set("Content-Range", contentRange);

    outHeaders.set("Cache-Control", "private, max-age=300");
    outHeaders.set("X-SteadyTube-Tier", String(target.tier));

    if (req.method === "HEAD" || !upstream.body) {
      return new Response(null, { status: upstream.status, headers: outHeaders });
    }

    const guardedBody = withStallWatchdog(
      upstream.body,
      this.config.playback.streamStallTimeoutMs,
      req.signal,
      () => {
        if (req.signal.aborted) return;
        this.resolver.markTargetStale(target.videoId, target.formatId);
        this.logger.warn("Upstream stream stalled/errored mid-chunk; marked stale for recovery", {
          videoId: target.videoId,
          formatId: target.formatId,
          tier: target.tier,
        });
      },
    );

    return new Response(guardedBody, {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  private async proxyDirectUpstream(
    req: Request,
    upstreamUrl: string,
    extraHeaders: Record<string, string>,
    fallbackMime: string,
    tier: number,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      "Accept-Encoding": "identity",
    };
    const range = req.headers.get("range");
    if (range) headers["Range"] = range;

    try {
      const upstream = await this.fetchRaw(upstreamUrl, {
        method: req.method,
        headers,
        signal: req.signal,
        httpsOnly: true,
        publicIpv4Only: true,
        allowedHost: (h) => ALLOWED_GOOGLEVIDEO_HOST.test(h),
      });
      const outHeaders = new Headers();
      outHeaders.set("Content-Type", upstream.headers.get("content-type") || fallbackMime);
      outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
      const cl = upstream.headers.get("content-length");
      if (cl) outHeaders.set("Content-Length", cl);
      const cr = upstream.headers.get("content-range");
      if (cr) outHeaders.set("Content-Range", cr);
      outHeaders.set("X-SteadyTube-Tier", String(tier));

      if (req.method === "HEAD" || !upstream.body) {
        return new Response(null, { status: upstream.status, headers: outHeaders });
      }

      const guardedBody = withStallWatchdog(
        upstream.body,
        this.config.playback.streamStallTimeoutMs,
        req.signal,
        () => {
          if (req.signal.aborted) return;
          this.logger.warn("Direct ?host= upstream stream stalled mid-chunk");
        },
      );

      return new Response(guardedBody, {
        status: upstream.status,
        headers: outHeaders,
      });
    } catch {
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      return new Response("Upstream proxy error", { status: 502 });
    }
  }
}

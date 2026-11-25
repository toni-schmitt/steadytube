import crypto from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { parseHttpRangeHeader, type EphemeralStore } from "../cache/ephemeral-store.ts";
import {
  MAX_DASH_HEADER_PROBE_BYTES,
  probeLocalFileDashRanges,
} from "../media/container-probe.ts";
import {
  doesTargetMatchRequestIdentity,
  type ExpectedTargetIdentity,
  findStreamTargetInRecord,
  formatDashLayoutKey,
  MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES,
  parseRangeBounds,
  type RequestedRangeInfo,
  type StreamTarget,
  type StreamTargetRemote,
  type VideoResolver,
} from "../media/video-resolver.ts";
import { VALID_VIDEO_ID_RE } from "../media/ytdlp.ts";
import { ipv4FetchRaw, type FetchLike } from "../net/ipv4-fetch.ts";

const ALLOWED_GOOGLEVIDEO_HOST = /^[a-z0-9-]+\.googlevideo\.com$/i;
const MAX_RECOVERY_ATTEMPTS = 4;

function isRecoverableStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 410 || status === 429 || status >= 500;
}

function parseContentRangeHeader(
  header: string | null,
): { start: number; end: number; total: number | null } | { unsatisfiableTotal: number } | null {
  if (!header) return null;
  const trimmed = header.trim();
  const rangeMatch = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(trimmed);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    const total = rangeMatch[3] === "*" ? null : Number(rangeMatch[3]);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end >= start &&
      (total === null || (Number.isFinite(total) && end < total))
    ) {
      return { start, end, total };
    }
    return null;
  }
  const unsatMatch = /^bytes\s+\*\/(\d+)$/i.exec(trimmed);
  if (unsatMatch) {
    const total = Number(unsatMatch[1]);
    if (Number.isFinite(total)) return { unsatisfiableTotal: total };
  }
  return null;
}

/**
 * Compute the single byte-range header we actually forward upstream:
 * - Never forward Range on HEAD (RFC 9110 §14.2: HEAD returns full metadata 200).
 * - Never forward Range when If-Range is present (we do not validate If-Range validators).
 * - Ignore unknown range units, multi-range lists, and syntactically invalid specs so
 *   upstream cannot return multipart/byteranges or an unexpected 206.
 */
function getEffectiveOutboundRange(req: Request): string | null {
  if (req.method === "HEAD") return null;
  if (req.headers.get("if-range")) return null;
  const raw = req.headers.get("range");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes(",")) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  return trimmed;
}

function compareUintStrings(a: string, b: string): number {
  const na = a.replace(/^0+/, "") || "0";
  const nb = b.replace(/^0+/, "") || "0";
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
  return na < nb ? -1 : na > nb ? 1 : 0;
}

type UpstreamValidationResult =
  | { ok: true; expectedBodyBytes: number | null }
  | { ok: false; reason: "layout_mismatch" | "recoverable_protocol" };

/**
 * Strictly validate upstream 200 / 206 / 416 headers BEFORE forwarding headers/bytes to Shaka:
 * - Reject non-identity Content-Encoding on 200/206 so raw compressed bytes never masquerade as offsets.
 * - Reject unsolicited 206 when no single byte-range was forwarded upstream.
 * - 206 MUST carry a valid single-range Content-Range matching the requested interval,
 *   exact `expectedTotal` (rejecting `*` when exact total is known), and exact Content-Length.
 * - 200 MUST match `expectedTotal` when Content-Length is supplied.
 * - 416 MUST match `expectedTotal` when `bytes *\/total` is supplied.
 */
function validateUpstreamSegmentResponse(
  outboundRange: string | null,
  res: Response,
  expectedTotal: number,
): UpstreamValidationResult {
  const ce = (res.headers.get("content-encoding") || "").trim().toLowerCase();
  if ((res.status === 200 || res.status === 206) && ce.length > 0 && ce !== "identity") {
    return { ok: false, reason: "recoverable_protocol" };
  }

  const rawCl = res.headers.get("content-length");
  let parsedCl: number | null = null;
  if (rawCl !== null) {
    const trimmed = rawCl.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, reason: "recoverable_protocol" };
    }
    parsedCl = Number(trimmed);
    if (!Number.isFinite(parsedCl) || parsedCl < 0) {
      return { ok: false, reason: "recoverable_protocol" };
    }
  }

  if (res.status === 206) {
    if (outboundRange === null) {
      return { ok: false, reason: "recoverable_protocol" };
    }
    const parsedCr = parseContentRangeHeader(res.headers.get("content-range"));
    if (!parsedCr || !("start" in parsedCr)) {
      return { ok: false, reason: "recoverable_protocol" };
    }
    if (expectedTotal > 0) {
      if (parsedCr.total === null) {
        return { ok: false, reason: "recoverable_protocol" };
      }
      if (parsedCr.total !== expectedTotal) {
        return { ok: false, reason: "layout_mismatch" };
      }
    }
    const rangeLen = parsedCr.end - parsedCr.start + 1;
    if (parsedCl !== null && parsedCl !== rangeLen) {
      return { ok: false, reason: "recoverable_protocol" };
    }

    // Verify returned interval matches the forwarded single Range
    const refTotal = expectedTotal > 0 ? expectedTotal : (parsedCr.total ?? 0);
    if (refTotal > 0) {
      const parsedReq = parseHttpRangeHeader(outboundRange, refTotal);
      if (parsedReq === "unsatisfiable") {
        return { ok: false, reason: "recoverable_protocol" };
      }
      if (parsedReq.isPartial && (parsedCr.start !== parsedReq.start || parsedCr.end !== parsedReq.end)) {
        return { ok: false, reason: "recoverable_protocol" };
      }
    } else {
      const m = /^bytes=(\d*)-(\d*)$/i.exec(outboundRange);
      if (m) {
        const [, rawStart, rawEnd] = m;
        if (rawStart === "") {
          const trimmedDigits = rawEnd!.replace(/^0+/, "");
          if (!trimmedDigits) return { ok: false, reason: "recoverable_protocol" };
          const maxSuffix = trimmedDigits.length > 15 ? Infinity : Number(trimmedDigits);
          if (rangeLen > maxSuffix) {
            return { ok: false, reason: "recoverable_protocol" };
          }
        } else {
          const reqStart = Number(rawStart);
          if (!Number.isFinite(reqStart) || parsedCr.start !== reqStart) {
            return { ok: false, reason: "recoverable_protocol" };
          }
          if (rawEnd !== "" && compareUintStrings(String(parsedCr.end), rawEnd!) > 0) {
            return { ok: false, reason: "recoverable_protocol" };
          }
        }
      }
    }

    return { ok: true, expectedBodyBytes: rangeLen };
  }

  if (res.status === 416) {
    const parsed = parseContentRangeHeader(res.headers.get("content-range"));
    if (expectedTotal > 0 && parsed && "unsatisfiableTotal" in parsed && parsed.unsatisfiableTotal !== expectedTotal) {
      return { ok: false, reason: "layout_mismatch" };
    }
    return { ok: true, expectedBodyBytes: 0 };
  }

  if (res.status === 200) {
    if (expectedTotal > 0 && parsedCl !== null && parsedCl !== expectedTotal) {
      return { ok: false, reason: "layout_mismatch" };
    }
    return {
      ok: true,
      expectedBodyBytes: parsedCl ?? (expectedTotal > 0 ? expectedTotal : null),
    };
  }

  return { ok: false, reason: "recoverable_protocol" };
}

/**
 * Pass-through incremental SHA-256 tap for small init/index byte ranges so
 * mid-playback Tier 3 recovery can verify not just range bounds but also
 * exact init/index bytes against what Shaka already parsed.
 */
function tapStreamHash(
  source: ReadableStream<Uint8Array>,
  expectedLength: number,
  onDigest: (hex: string) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const hash = crypto.createHash("sha256");
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (seen === expectedLength) {
            onDigest(hash.digest("hex"));
          }
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) {
          seen += value.byteLength;
          hash.update(value);
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function classifyRequestedRange(req: Request, totalSize: number): RequestedRangeInfo {
  if (req.headers.get("if-range")) return { kind: "offset", start: 0 };
  const range = req.headers.get("range");
  if (!range || !range.trim()) return { kind: "offset", start: 0 };
  const trimmed = range.trim();
  if (!/^bytes=/i.test(trimmed) || trimmed.includes(",")) {
    return { kind: "offset", start: 0 };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match || (match[1] === "" && match[2] === "")) {
    return { kind: "offset", start: 0 };
  }

  if (totalSize > 0) {
    const parsed = parseHttpRangeHeader(trimmed, totalSize);
    if (parsed === "unsatisfiable") {
      return { kind: "unsatisfiable" };
    }
    return { kind: "offset", start: parsed.start };
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "") {
    if (/^0+$/.test(rawEnd!)) return { kind: "unsatisfiable" };
    return { kind: "indeterminate_suffix" };
  }
  if (rawEnd !== "" && compareUintStrings(rawEnd!, rawStart!) < 0) {
    return { kind: "unsatisfiable" };
  }
  const trimmedStart = rawStart!.replace(/^0+/, "") || "0";
  const start = trimmedStart.length > 15 ? Number.MAX_SAFE_INTEGER : Number(trimmedStart);
  if (!Number.isFinite(start) || start < 0) return { kind: "unsatisfiable" };
  return { kind: "offset", start };
}

function getSignalAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(getSignalAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(getSignalAbortError(signal));
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

/**
 * Wraps an upstream ReadableStream with a per-chunk stall watchdog and optional
 * exact `expectedBodyBytes` enforcement so truncated EOFs or over-length upstream
 * bodies fail cleanly and mark the cached target stale for recovery on retry.
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
  expectedBodyBytes?: number | null,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  let cancelled = false;
  let clientAborted = Boolean(signal?.aborted);
  let stallReported = false;
  let totalRead = 0;

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
          if (
            expectedBodyBytes !== null &&
            expectedBodyBytes !== undefined &&
            totalRead < expectedBodyBytes
          ) {
            reportStallOnce();
            controller.error(
              new Error(`Upstream stream truncated early (${totalRead} < ${expectedBodyBytes} bytes)`),
            );
            return;
          }
          controller.close();
        } else if (value) {
          totalRead += value.byteLength;
          if (
            expectedBodyBytes !== null &&
            expectedBodyBytes !== undefined &&
            totalRead > expectedBodyBytes
          ) {
            cleanup();
            reportStallOnce();
            await reader.cancel(new Error("Upstream stream exceeded expected byte length")).catch(() => {});
            controller.error(
              new Error(`Upstream stream exceeded expected length (${totalRead} > ${expectedBodyBytes} bytes)`),
            );
            return;
          }
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
    const clenParam = url.searchParams.get("clen");
    const urlClen = clenParam && /^\d+$/.test(clenParam) ? Number(clenParam) : 0;
    const urlLayout = url.searchParams.get("layout") || null;
    const urlRev = url.searchParams.get("rev") || null;
    const urlXtags = url.searchParams.get("xtags") || null;
    const expectedIdentity: ExpectedTargetIdentity | undefined =
      urlClen > 0 || urlLayout || urlRev || urlXtags
        ? {
            clen: urlClen > 0 ? urlClen : undefined,
            layout: urlLayout,
            rev: urlRev,
            xtags: urlXtags,
          }
        : undefined;

    // Case 1: Standard daemon-issued proxy URL (?v=<id>&fid=<fid>&itag=<itag>...)
    if (videoId !== null) {
      if (!VALID_VIDEO_ID_RE.test(videoId)) {
        return Response.json({ error: "Invalid video id" }, { status: 400 });
      }

      const cachedRecord = this.resolver.getCached(videoId);
      let target = cachedRecord
        ? findStreamTargetInRecord(cachedRecord, formatId, itag, expectedIdentity)
        : null;
      let resolvedAfterMiss = false;

      if (!target && !cachedRecord) {
        // First check if an already-available compatible local file exists on disk (no download needed!)
        // Verify persisted metadata (`formatId`, `clen`, `layout`, `rev`, `xtags`) without re-probing on every segment.
        if (formatId) {
          const legacyKey = this.ephemeralStore.makeKey(videoId, formatId);
          for (const diskEntry of this.ephemeralStore.findEntriesForVideo(videoId)) {
            const fidMatches =
              diskEntry.meta?.formatId === formatId ||
              (!diskEntry.meta?.formatId && diskEntry.key === legacyKey);
            if (!fidMatches) continue;
            if (urlClen > 0 && diskEntry.size !== urlClen) continue;
            if (urlRev && diskEntry.meta?.rev !== urlRev) continue;
            if (urlXtags && diskEntry.meta?.xtags !== urlXtags) continue;
            if (urlLayout) {
              if (diskEntry.meta?.layout != null) {
                if (diskEntry.meta.layout !== urlLayout) continue;
              } else {
                const probed = probeLocalFileDashRanges(
                  diskEntry.filePath,
                  diskEntry.mimeType,
                  MAX_DASH_HEADER_PROBE_BYTES,
                );
                const probedLayout = formatDashLayoutKey(probed);
                diskEntry.meta = { ...(diskEntry.meta ?? {}), formatId, layout: probedLayout };
                if (probedLayout !== urlLayout) continue;
              }
            }
            return this.ephemeralStore.serveFile(diskEntry, req);
          }
        }

        // Apply far-seek / suffix / unsatisfiable range guardrails on cache miss so they NEVER
        // trigger cold Tier 3 download from byte 0; also cap remote-issued fids to maxTier: 2.
        const missRange = classifyRequestedRange(req, urlClen);
        const isTier3DisallowedRange =
          missRange.kind === "unsatisfiable" ||
          missRange.kind === "indeterminate_suffix" ||
          (missRange.kind === "offset" && missRange.start > MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES);
        const isNonTier3IssuedUrl = Boolean(formatId && !formatId.startsWith("tier3-") && expectedIdentity);
        const missMaxTier = isTier3DisallowedRange || isNonTier3IssuedUrl ? 2 : 3;

        try {
          const rec = await raceWithAbort(
            this.resolver.resolveVideo(videoId, origin, { maxTier: missMaxTier }),
            req.signal,
          );
          resolvedAfterMiss = true;
          target = findStreamTargetInRecord(rec, formatId, itag, expectedIdentity);
        } catch (err) {
          if (req.signal.aborted) {
            return new Response(null, { status: 499 });
          }
          this.logger.warn("Failed to re-resolve video on /videoplayback cache miss", {
            videoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!target) {
        // Distinguish a stale/mismatched representation from a missing video so Shaka reloads cleanly
        if ((cachedRecord || resolvedAfterMiss) && (expectedIdentity || formatId?.startsWith("tier3-"))) {
          return new Response("Stream representation changed; reload required", { status: 410 });
        }
        return Response.json({ error: "Stream format not found" }, { status: 404 });
      }

      return await this.serveTarget(req, target, origin, expectedIdentity);
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

  private async serveTarget(
    req: Request,
    target: StreamTarget,
    origin: string,
    expectedIdentity?: ExpectedTargetIdentity,
  ): Promise<Response> {
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    // Tier 3 local ephemeral buffer file
    if (target.kind === "local") {
      return this.serveLocalTargetOr503(target, req);
    }

    // Tier 3 actively downloading progressive stream
    let current: StreamTargetRemote;
    if (target.kind === "progressive") {
      if (target.source.getStatus() !== "failed") {
        const progRes = await this.ephemeralStore.serveProgressive(
          target.source,
          req,
          this.config.playback.streamStallTimeoutMs,
        );
        if (
          progRes.status !== 503 ||
          req.signal.aborted ||
          target.source.getStatus() !== "failed" ||
          !target.fallbackRemote
        ) {
          return progRes;
        }
        // Progressive download failed while waiting for initial bytes -> recover via fallbackRemote
        current = target.fallbackRemote;
      } else if (target.fallbackRemote) {
        current = target.fallbackRemote;
      } else {
        this.resolver.invalidateVideoIfTargetMatches(target.videoId, target.formatId, target);
        return new Response("Tier 3 progressive stream failed", { status: 503 });
      }
    } else {
      current = target;
    }

    // Fast path for HEAD (including ranged HEAD per RFC 9110 §14.2) when exact length is known
    if (req.method === "HEAD" && current.clen > 0 && !current.stale) {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": current.mimeType,
          "Content-Length": String(current.clen),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=300",
          "X-SteadyTube-Tier": String(current.tier),
        },
      });
    }

    // Immediately reject unsatisfiable byte ranges locally when exact total size is known
    const knownTotal = expectedIdentity?.clen || current.clen || 0;
    if (req.method === "GET" && knownTotal > 0) {
      const classified = classifyRequestedRange(req, knownTotal);
      if (classified.kind === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Type": current.mimeType,
            "Accept-Ranges": "bytes",
            "Content-Length": "0",
            "Content-Range": `bytes */${knownTotal}`,
            "Cache-Control": "private, max-age=300",
            "X-SteadyTube-Tier": String(current.tier),
          },
        });
      }
    }

    // If a previous body stalled on this target, immediately escalate before trying it again
    if (current.stale) {
      let preRecovered: StreamTarget | null = null;
      try {
        preRecovered = await raceWithAbort(
          this.resolver.recoverFormatMidPlayback(
            current.videoId,
            current.formatId,
            current.itag,
            origin,
            current,
            { requestedRange: classifyRequestedRange(req, expectedIdentity?.clen || current.clen) },
          ),
          req.signal,
        );
      } catch {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }
      }
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      if (preRecovered) {
        if (!doesTargetMatchRequestIdentity(preRecovered, expectedIdentity)) {
          return new Response("Stream representation changed; reload required", { status: 410 });
        }
        if (preRecovered.kind === "local") {
          return this.serveLocalTargetOr503(preRecovered, req);
        }
        if (preRecovered.kind === "progressive") {
          return await this.ephemeralStore.serveProgressive(
            preRecovered.source,
            req,
            this.config.playback.streamStallTimeoutMs,
          );
        }
        current = preRecovered;
      }
    }

    // Try current remote target over IPv4; transparently recover on 403/410/429/5xx/network/protocol error
    const outboundRange = getEffectiveOutboundRange(req);
    for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchUpstreamSegment(req, current, outboundRange);
        if (res.status === 200 || res.status === 206 || res.status === 416) {
          const expectedTotal = expectedIdentity?.clen || current.clen || 0;
          const validation = validateUpstreamSegmentResponse(outboundRange, res, expectedTotal);
          if (!validation.ok) {
            await res.body?.cancel().catch(() => {});
            if (validation.reason === "layout_mismatch") {
              this.resolver.markNeedsMetadataRefresh(current.videoId, current.formatId, current);
              return new Response("Stream representation changed; reload required", { status: 410 });
            }
            if (attempt === MAX_RECOVERY_ATTEMPTS - 1) {
              return new Response("Invalid upstream segment response", { status: 502 });
            }
            this.logger.warn("Upstream /videoplayback returned malformed/mismatched 206/200 headers; recovering", {
              videoId: current.videoId,
              formatId: current.formatId,
              status: res.status,
              attempt,
            });
          } else if (res.status === 416) {
            await res.body?.cancel().catch(() => {});
            const outHeaders = new Headers({
              "Content-Type": res.headers.get("content-type") || current.mimeType,
              "Accept-Ranges": res.headers.get("accept-ranges") || "bytes",
              "Content-Length": "0",
              "Cache-Control": "private, max-age=300",
              "X-SteadyTube-Tier": String(current.tier),
            });
            const contentRange = res.headers.get("content-range");
            if (contentRange) outHeaders.set("Content-Range", contentRange);
            return new Response(null, { status: 416, headers: outHeaders });
          } else {
            return this.buildStreamResponse(req, res, current, validation.expectedBodyBytes);
          }
        } else {
          await res.body?.cancel().catch(() => {});

          if (!isRecoverableStatus(res.status) || attempt === MAX_RECOVERY_ATTEMPTS - 1) {
            return new Response(null, { status: res.status });
          }

          this.logger.warn("Upstream /videoplayback returned recoverable error", {
            videoId: current.videoId,
            formatId: current.formatId,
            status: res.status,
            tier: current.tier,
            attempt,
          });
        }
      } catch (err) {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }
        if (attempt === MAX_RECOVERY_ATTEMPTS - 1) {
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

      let recovered: StreamTarget | null = null;
      try {
        recovered = await raceWithAbort(
          this.resolver.recoverFormatMidPlayback(
            current.videoId,
            current.formatId,
            current.itag,
            origin,
            current,
            { requestedRange: classifyRequestedRange(req, expectedIdentity?.clen || current.clen) },
          ),
          req.signal,
        );
      } catch {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }
      }

      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      if (!recovered) {
        return new Response("Upstream stream unavailable", { status: 503 });
      }
      if (!doesTargetMatchRequestIdentity(recovered, expectedIdentity)) {
        return new Response("Stream representation changed; reload required", { status: 410 });
      }
      if (recovered.kind === "local") {
        return this.serveLocalTargetOr503(recovered, req);
      }
      if (recovered.kind === "progressive") {
        return await this.ephemeralStore.serveProgressive(
          recovered.source,
          req,
          this.config.playback.streamStallTimeoutMs,
        );
      }
      current = recovered;
    }

    return new Response("Upstream stream exhausted", { status: 502 });
  }

  private serveLocalTargetOr503(
    target: Extract<StreamTarget, { kind: "local" }>,
    req: Request,
  ): Response {
    const storeKey = target.storeKey ?? this.ephemeralStore.makeKey(target.videoId, target.formatId);
    const entry = this.ephemeralStore.getByKey(storeKey);
    if (entry && entry.filePath === target.filePath && entry.size === target.size) {
      return this.ephemeralStore.serveFile(entry, req);
    }
    this.resolver.invalidateVideoIfTargetMatches(target.videoId, target.formatId, target);
    return new Response("Cached stream expired; reload required", { status: 503 });
  }

  private async fetchUpstreamSegment(
    req: Request,
    target: StreamTargetRemote,
    outboundRange: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...target.httpHeaders,
      "Accept-Encoding": "identity",
    };
    if (outboundRange) {
      headers["Range"] = outboundRange;
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
    expectedBodyBytes: number | null,
  ): Response {
    const outHeaders = new Headers();
    outHeaders.set("Content-Type", upstream.headers.get("content-type") || target.mimeType);
    outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      outHeaders.set("Content-Length", contentLength);
    } else if (upstream.status === 206 && expectedBodyBytes !== null) {
      outHeaders.set("Content-Length", String(expectedBodyBytes));
    }

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) outHeaders.set("Content-Range", contentRange);

    outHeaders.set("Cache-Control", "private, max-age=300");
    outHeaders.set("X-SteadyTube-Tier", String(target.tier));

    if (req.method === "HEAD" || !upstream.body) {
      return new Response(null, { status: upstream.status, headers: outHeaders });
    }

    let guardedBody = withStallWatchdog(
      upstream.body,
      this.config.playback.streamStallTimeoutMs,
      req.signal,
      () => {
        if (req.signal.aborted) return;
        this.resolver.markTargetStale(target.videoId, target.formatId, target);
        this.logger.warn("Upstream stream stalled/errored mid-chunk; marked stale for recovery", {
          videoId: target.videoId,
          formatId: target.formatId,
          tier: target.tier,
        });
      },
      expectedBodyBytes,
    );

    // Opportunistically fingerprint exact init/index ranges as Shaka fetches them
    if (upstream.status === 206 && target.dashRanges && contentRange) {
      const parsedCr = parseContentRangeHeader(contentRange);
      if (parsedCr && "start" in parsedCr) {
        const rangeLen = parsedCr.end - parsedCr.start + 1;
        if (rangeLen > 0 && rangeLen <= MAX_DASH_HEADER_PROBE_BYTES) {
          const initB = parseRangeBounds(target.dashRanges.init);
          const indexB = parseRangeBounds(target.dashRanges.index);
          if (
            initB &&
            !target.dashRanges.initHash &&
            parsedCr.start === initB.start &&
            parsedCr.end === initB.end
          ) {
            const dr = target.dashRanges;
            guardedBody = tapStreamHash(guardedBody, rangeLen, (hex) => {
              if (!dr.initHash) dr.initHash = hex;
            });
          } else if (
            indexB &&
            !target.dashRanges.indexHash &&
            parsedCr.start === indexB.start &&
            parsedCr.end === indexB.end
          ) {
            const dr = target.dashRanges;
            guardedBody = tapStreamHash(guardedBody, rangeLen, (hex) => {
              if (!dr.indexHash) dr.indexHash = hex;
            });
          }
        }
      }
    }

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
    const outboundRange = getEffectiveOutboundRange(req);
    const headers: Record<string, string> = {
      ...extraHeaders,
      "Accept-Encoding": "identity",
    };
    if (outboundRange) headers["Range"] = outboundRange;

    try {
      const upstream = await this.fetchRaw(upstreamUrl, {
        method: req.method,
        headers,
        signal: req.signal,
        httpsOnly: true,
        publicIpv4Only: true,
        allowedHost: (h) => ALLOWED_GOOGLEVIDEO_HOST.test(h),
      });

      if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
        await upstream.body?.cancel().catch(() => {});
        return new Response(null, { status: upstream.status });
      }

      const validation = validateUpstreamSegmentResponse(outboundRange, upstream, 0);
      if (!validation.ok) {
        await upstream.body?.cancel().catch(() => {});
        return new Response("Invalid upstream segment response", { status: 502 });
      }

      const outHeaders = new Headers();
      outHeaders.set("Content-Type", upstream.headers.get("content-type") || fallbackMime);
      outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
      const cr = upstream.headers.get("content-range");
      if (cr) outHeaders.set("Content-Range", cr);
      outHeaders.set("X-SteadyTube-Tier", String(tier));

      if (upstream.status === 416) {
        await upstream.body?.cancel().catch(() => {});
        outHeaders.set("Content-Length", "0");
        return new Response(null, { status: 416, headers: outHeaders });
      }

      const cl = upstream.headers.get("content-length");
      if (cl) {
        outHeaders.set("Content-Length", cl);
      } else if (upstream.status === 206 && validation.expectedBodyBytes !== null) {
        outHeaders.set("Content-Length", String(validation.expectedBodyBytes));
      }

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
        validation.expectedBodyBytes,
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

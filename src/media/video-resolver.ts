import fs from "node:fs";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { Semaphore, TtlLruCache } from "../cache/memory-cache.ts";
import type {
  EphemeralFileEntry,
  EphemeralStore,
  ProgressiveStreamSource,
} from "../cache/ephemeral-store.ts";
import type { AnonymousInnertubeProvider } from "../innertube/client.ts";
import {
  type AdaptiveFormatOutput,
  buildMimeTypeFromYtDlp,
  buildProxyPlaybackUrl,
  buildStoryboardWebVtt,
  buildVideoThumbnails,
  descriptionToHtml,
  formatCompactCount,
  inferAudioQuality,
  mapYoutubeiVideoNode,
  normalizeAuthorThumbnails,
  parseUploadDateToUnixSec,
  textOf,
} from "../innertube/mappers.ts";
import { ipv4FetchRaw, type FetchLike } from "../net/ipv4-fetch.ts";
import {
  type DashByteRanges,
  hasValidGlobalMp4Sidx,
  parseWebmDashRanges,
  probeLocalFileDashRanges,
  probeRemoteDashRanges,
} from "./container-probe.ts";
import {
  assertValidVideoId,
  type ProgressiveDownloadHandle,
  YtDlpError,
  type YtDlpFormat,
  type YtDlpRunner,
  type YtDlpVideoInfo,
} from "./ytdlp.ts";

export type PlaybackTier = 1 | 2 | 3;

/**
 * Maximum sequential catch-up distance (in bytes) we are willing to download
 * from byte 0 when starting a mid-playback Tier 3 progressive buffer.
 * Prevents burning hundreds of MB when a failure happens far into a long 4K VOD.
 */
export const MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES = 64 * 1024 * 1024; // 64 MiB

export interface DashRangeIdentity {
  init: string;
  index: string;
}

export interface StreamTargetRemote {
  kind: "remote";
  videoId: string;
  formatId: string;
  itag: number;
  url: string;
  mimeType: string;
  /** Strictly authoritative exact byte length (0 if unknown; NEVER populated from filesize_approx) */
  clen: number;
  /** Approximate size hint (e.g. yt-dlp filesize_approx) used only for bitrate/budget estimates */
  approxSize?: number;
  /** Exact DASH init/index byte ranges advertised in the manifest for this representation */
  dashRanges?: DashRangeIdentity;
  expireSec: number;
  httpHeaders: Record<string, string>;
  tier: 1 | 2;
  resolvedBy: "innertube" | "ytdlp";
  /** Verified yt-dlp format_id selector (differs from InnerTube synthetic fid on multi-audio tracks) */
  ytDlpFormatId?: string;
  isDrc?: boolean;
  resolvedAt: number;
  stale?: boolean;
  tier3CooldownUntil?: number;
}

export interface StreamTargetLocal {
  kind: "local";
  videoId: string;
  formatId: string;
  itag: number;
  filePath: string;
  mimeType: string;
  size: number;
  dashRanges?: DashRangeIdentity;
  tier: 3;
}

export interface StreamTargetProgressive {
  kind: "progressive";
  videoId: string;
  formatId: string;
  itag: number;
  mimeType: string;
  size: number;
  dashRanges?: DashRangeIdentity;
  tier: 3;
  source: ProgressiveStreamSource;
}

export type StreamTarget = StreamTargetRemote | StreamTargetLocal | StreamTargetProgressive;

export interface CaptionTrackRef {
  label: string;
  languageCode: string;
  url: string;
}

export interface ResolvedVideoRecord {
  videoId: string;
  tier: PlaybackTier;
  resolvedBy: "innertube" | "ytdlp" | "ephemeral";
  resolvedAt: number;
  expiresAt: number;
  payload: Record<string, unknown>;
  adaptiveFormats: AdaptiveFormatOutput[];
  durationSec: number;
  targetsByFid: Map<string, StreamTarget>;
  targetsByItag: Map<number, StreamTarget>;
  captions: CaptionTrackRef[];
  storyboards: Array<{
    template_url: string;
    thumbnail_width: number;
    thumbnail_height: number;
    thumbnail_count: number;
    interval: number;
    columns: number;
    rows: number;
  }>;
}

export interface PlaybackMetrics {
  totalRequests: number;
  tier1Hits: number;
  tier2Hits: number;
  tier3Hits: number;
  midPlaybackRecoveries: number;
}

interface HintedRange extends DashByteRanges {
  clen?: number;
  isDrc?: boolean;
}

interface InnertubeMetaHints {
  rangesByKey: Map<string, HintedRange>;
  rangesByItag: Map<number, HintedRange>;
  colorByItag: Map<
    number,
    { primaries?: string; transferCharacteristics?: string; matrixCoefficients?: string }
  >;
  projectionByItag: Map<number, string>;
  authorThumbnails: Array<{ url: string; width: number; height: number }>;
  subCountText: string;
  genre: string;
  isFamilyFriendly: boolean;
  recommendedVideos: Array<Record<string, unknown>>;
  storyboards: ResolvedVideoRecord["storyboards"];
  captions: CaptionTrackRef[];
  title?: string;
  description?: string;
  author?: string;
  authorId?: string;
  viewCount?: number;
  likeCount?: number;
  published?: number;
  durationSec?: number;
  isListed?: boolean;
}

function parseNumericItag(formatId: string, url?: string): number {
  if (url) {
    try {
      const itagParam = new URL(url).searchParams.get("itag");
      if (itagParam && /^\d+$/.test(itagParam)) return Number(itagParam);
    } catch {
      // Ignore
    }
  }
  const m = /^(\d+)/.exec(formatId);
  return m ? Number(m[1]) : 0;
}

function extractUrlMeta(url: string | undefined, fallbackDurSec: number) {
  let expireSec = Math.floor(Date.now() / 1000) + 6 * 3600;
  let durSec = fallbackDurSec;
  let clen = 0;
  let lmt = "0";
  let xtags: string | null = null;

  if (url) {
    try {
      const u = new URL(url);
      const exp = u.searchParams.get("expire");
      if (exp && /^\d+$/.test(exp)) expireSec = Number(exp);
      const dur = u.searchParams.get("dur");
      if (dur && Number.isFinite(Number(dur)) && Number(dur) > 0) durSec = Number(dur);
      const c = u.searchParams.get("clen");
      if (c && /^\d+$/.test(c)) clen = Number(c);
      const l = u.searchParams.get("lmt");
      if (l) lmt = l;
      const x = u.searchParams.get("xtags");
      if (x) xtags = x;
    } catch {
      // Ignore invalid URL
    }
  }

  return { expireSec, durSec, clen, lmt, xtags };
}

function isDirectDashFormat(f: YtDlpFormat): boolean {
  if (!f.url) return false;
  if (f.protocol !== "https" && f.protocol !== "http") return false;
  const hasVideo = Boolean(f.vcodec && f.vcodec !== "none");
  const hasAudio = Boolean(f.acodec && f.acodec !== "none");
  // Adaptive DASH streams are strictly video-only or audio-only
  if (hasVideo === hasAudio) return false;
  if (f.ext === "mhtml") return false;
  if (f.container && !f.container.endsWith("_dash")) return false;
  return true;
}

function isDirectMuxedFormat(f: YtDlpFormat): boolean {
  if (!f.url) return false;
  if (f.protocol !== "https" && f.protocol !== "http") return false;
  const hasVideo = Boolean(f.vcodec && f.vcodec !== "none");
  const hasAudio = Boolean(f.acodec && f.acodec !== "none");
  return hasVideo && hasAudio && Boolean(f.width && f.height);
}

function makeRangeKey(itag: number, isDrc: boolean, lang?: string | null): string {
  return `${itag}:${isDrc ? "drc" : "std"}:${(lang || "").toLowerCase()}`;
}

function isVisionOsClientUrl(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).searchParams.get("c")?.toUpperCase() === "VISIONOS";
  } catch {
    return false;
  }
}

/**
 * When yt-dlp runs with multiple player clients (e.g. `visionos,default,-tv_samsung`),
 * multiple clients can emit entries with the same `format_id`. Prefer the first
 * entry — upgrading only if a later duplicate comes from `VISIONOS` while the
 * earlier one did not — so `default` client URLs never clobber `VISIONOS` URLs.
 */
export function deduplicateYtDlpFormats(formats: YtDlpFormat[]): YtDlpFormat[] {
  const byId = new Map<string, number>();
  const out: YtDlpFormat[] = [];

  for (const fmt of formats) {
    const existingIdx = byId.get(fmt.format_id);
    if (existingIdx === undefined) {
      byId.set(fmt.format_id, out.length);
      out.push(fmt);
    } else if (isVisionOsClientUrl(fmt.url) && !isVisionOsClientUrl(out[existingIdx]?.url)) {
      out[existingIdx] = fmt;
    }
  }

  return out;
}

function withTimeoutNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isYtDlpFormatDrc(fmt: YtDlpFormat): boolean {
  return fmt.format_id.includes("drc") || (fmt.format_note || "").includes("DRC");
}

function getYtDlpFormatExactClen(fmt: YtDlpFormat): number {
  const meta = extractUrlMeta(fmt.url, 0);
  return meta.clen || Number(fmt.filesize || 0);
}

function getYtDlpFormatApproxSize(fmt: YtDlpFormat): number {
  return getYtDlpFormatExactClen(fmt) || Number(fmt.filesize_approx || 0);
}

export function formatDashLayoutKey(ranges?: DashRangeIdentity | null): string | null {
  if (!ranges || !ranges.init || !ranges.index) return null;
  return `${ranges.init}_${ranges.index}`;
}

export interface ExpectedTargetIdentity {
  clen?: number;
  layout?: string | null;
}

/**
 * Verify that a candidate StreamTarget matches the representation identity
 * (`layout` init/index ranges and/or authoritative exact `clen`) embedded in an
 * issued `/videoplayback` URL, preventing stale URLs from serving bytes from a
 * different DASH box layout.
 */
export function doesTargetMatchRequestIdentity(
  target: StreamTarget,
  expected?: ExpectedTargetIdentity,
): boolean {
  if (!expected) return true;
  if (expected.layout) {
    const actualLayout = formatDashLayoutKey(target.dashRanges);
    if (!actualLayout || actualLayout !== expected.layout) {
      return false;
    }
  }
  if (expected.clen && expected.clen > 0) {
    const exactSize = target.kind === "remote" ? target.clen : target.size;
    if (exactSize > 0 && exactSize !== expected.clen) {
      return false;
    }
  }
  return true;
}

/**
 * Look up a stream target in a resolved record while enforcing representation
 * identity compatibility (`fid`, `layout`, exact `clen`). Synthetic cold Tier 3
 * IDs (`tier3-*`) NEVER fall back by `itag`, and other `fid` misses only fall
 * back by `itag` when a verified `layout` or exact `clen` matches 1:1.
 */
export function findStreamTargetInRecord(
  rec: ResolvedVideoRecord,
  formatId: string | null,
  itag: number | null,
  expected?: ExpectedTargetIdentity,
): StreamTarget | null {
  if (formatId) {
    const exact = rec.targetsByFid.get(formatId);
    if (exact) {
      return doesTargetMatchRequestIdentity(exact, expected) ? exact : null;
    }
    if (formatId.startsWith("tier3-")) {
      return null;
    }
    if (itag && itag > 0 && (expected?.layout || (expected?.clen && expected.clen > 0))) {
      const wantDrc = formatId.includes("drc");
      for (const candidate of rec.targetsByFid.values()) {
        if (candidate.itag !== itag) continue;
        if (candidate.formatId.startsWith("tier3-")) continue;
        const candDrc =
          candidate.kind === "remote"
            ? Boolean(candidate.isDrc || candidate.formatId.includes("drc"))
            : candidate.formatId.includes("drc");
        if (candDrc !== wantDrc) continue;
        if (!doesTargetMatchRequestIdentity(candidate, expected)) continue;
        // If layout wasn't provided, require authoritative exact size equality for itag fallback
        if (!expected.layout) {
          const exactSize = candidate.kind === "remote" ? candidate.clen : candidate.size;
          if (!expected.clen || exactSize !== expected.clen) continue;
        }
        return candidate;
      }
    }
    return null;
  }

  if (itag && itag > 0) {
    const byItag = rec.targetsByItag.get(itag);
    if (byItag && doesTargetMatchRequestIdentity(byItag, expected)) {
      return byItag;
    }
  }
  return null;
}

function parseRangeBounds(rangeStr: string): { start: number; end: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(rangeStr.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function doesLocalFileMatchDashRanges(
  filePath: string,
  mimeType: string,
  expected: DashRangeIdentity | undefined,
  allowPartialWebmPrefix = false,
): boolean {
  if (!expected) return true;
  const probed = probeLocalFileDashRanges(filePath, mimeType);
  if (probed) {
    return probed.init === expected.init && probed.index === expected.index;
  }
  if (allowPartialWebmPrefix && mimeType.includes("webm")) {
    const expectedInit = parseRangeBounds(expected.init);
    const expectedIndex = parseRangeBounds(expected.index);
    if (!expectedInit || !expectedIndex) return false;
    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return false;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const readLen = Math.min(size, 65536);
      if (readLen < 16) return false;
      const buf = new Uint8Array(readLen);
      fs.readSync(fd, buf, 0, readLen, 0);
      const parsed = parseWebmDashRanges(buf);
      if (parsed.ranges) {
        return parsed.ranges.init === expected.init && parsed.ranges.index === expected.index;
      }
      if (parsed.initEnd === undefined || parsed.initEnd !== expectedInit.end) {
        return false;
      }
      if (parsed.cuesOffset !== undefined && parsed.cuesOffset !== expectedIndex.start) {
        return false;
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }
  return false;
}

/**
 * Resolve a real, byte-compatible `yt-dlp` `format_id` for a remote target
 * (needed when the target came from fast InnerTube with a synthetic `formatId`
 * such as `251-en-US-en-US.4`).
 */
export function findMatchingYtDlpFormatId(
  formats: YtDlpFormat[],
  target: Pick<StreamTargetRemote, "formatId" | "itag" | "clen" | "isDrc">,
): string | null {
  const deduped = deduplicateYtDlpFormats(formats);
  const targetIsDrc = Boolean(target.isDrc || target.formatId.includes("drc"));

  const exact = deduped.find((f) => f.format_id === target.formatId);
  if (exact) {
    const fmtClen = getYtDlpFormatExactClen(exact);
    if (target.clen === 0 || fmtClen === 0 || fmtClen === target.clen) {
      return exact.format_id;
    }
  }

  if (target.itag > 0) {
    const sameItagAndDrc = deduped.filter(
      (f) =>
        parseNumericItag(f.format_id, f.url) === target.itag &&
        isYtDlpFormatDrc(f) === targetIsDrc,
    );
    if (target.clen > 0) {
      const byteExact = sameItagAndDrc.find((f) => getYtDlpFormatExactClen(f) === target.clen);
      if (byteExact) return byteExact.format_id;
    } else if (sameItagAndDrc.length === 1) {
      return sameItagAndDrc[0]!.format_id;
    }
  }

  return null;
}

/**
 * Deterministically select the best MP4 video (`<= maxHeight`, preferring H.264/avc1)
 * and M4A/MP4 audio tracks for cold Tier 3 buffering so the downloaded `format_id`
 * matches the advertised codec, resolution, and frame rate 1:1.
 */
export function selectColdTier3Formats(
  formats: YtDlpFormat[],
  maxHeight: number,
): { video: YtDlpFormat | null; audio: YtDlpFormat | null } {
  const deduped = deduplicateYtDlpFormats(formats);

  const videoCandidates = deduped.filter(
    (f) =>
      f.ext === "mp4" &&
      Boolean(f.vcodec && f.vcodec !== "none") &&
      (!f.acodec || f.acodec === "none") &&
      (f.height || 0) > 0 &&
      (f.height || 0) <= maxHeight,
  );
  videoCandidates.sort((a, b) => {
    const aAvc = /^avc1/i.test(a.vcodec || "") ? 1 : 0;
    const bAvc = /^avc1/i.test(b.vcodec || "") ? 1 : 0;
    if (bAvc !== aAvc) return bAvc - aAvc;
    const hDiff = (b.height || 0) - (a.height || 0);
    if (hDiff !== 0) return hDiff;
    const fpsDiff = (b.fps || 0) - (a.fps || 0);
    if (fpsDiff !== 0) return fpsDiff;
    return (b.tbr || b.vbr || 0) - (a.tbr || a.vbr || 0);
  });

  const audioCandidates = deduped.filter(
    (f) =>
      (f.ext === "m4a" || f.ext === "mp4") &&
      Boolean(f.acodec && f.acodec !== "none") &&
      (!f.vcodec || f.vcodec === "none"),
  );
  audioCandidates.sort((a, b) => {
    const aNonDrc = isYtDlpFormatDrc(a) ? 0 : 1;
    const bNonDrc = isYtDlpFormatDrc(b) ? 0 : 1;
    if (bNonDrc !== aNonDrc) return bNonDrc - aNonDrc;
    const aAac = /^mp4a/i.test(a.acodec || "") ? 1 : 0;
    const bAac = /^mp4a/i.test(b.acodec || "") ? 1 : 0;
    if (bAac !== aAac) return bAac - aAac;
    return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
  });

  return {
    video: videoCandidates[0] ?? null,
    audio: audioCandidates[0] ?? null,
  };
}

interface RemoteRecoveryOutcome {
  target: StreamTarget | null;
  verifiedYtDlpFormatId?: string;
  ytDlpCheckedAndUnmatched: boolean;
}

export class VideoResolver {
  private readonly cache: TtlLruCache<string, ResolvedVideoRecord>;
  private readonly remoteRecoveryInflight = new Map<string, Promise<RemoteRecoveryOutcome>>();
  private readonly tier3RecoveryInflight = new Map<string, Promise<StreamTarget | null>>();
  private readonly videoRefreshInflight = new Map<string, Promise<ResolvedVideoRecord>>();
  private readonly activeProgressive = new Map<string, ProgressiveDownloadHandle>();
  private readonly startingHandles = new Set<ProgressiveDownloadHandle>();
  private readonly activeRemuxProcs = new Set<{
    killSync: () => void;
    exited: Promise<unknown>;
  }>();
  private readonly probeSemaphore = new Semaphore(6);
  private readonly tier3Semaphore = new Semaphore(2);
  private stopped = false;
  private readonly metrics: PlaybackMetrics = {
    totalRequests: 0,
    tier1Hits: 0,
    tier2Hits: 0,
    tier3Hits: 0,
    midPlaybackRecoveries: 0,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly ytDlp: YtDlpRunner,
    private readonly innertubeProvider: AnonymousInnertubeProvider,
    private readonly ephemeralStore: EphemeralStore,
    private readonly fetchRaw: FetchLike = ipv4FetchRaw,
    private readonly logger: Logger = noopLogger,
  ) {
    this.cache = new TtlLruCache<string, ResolvedVideoRecord>(
      200,
      config.playback.videoCacheTtlSec * 1000,
    );
  }

  getMetrics(): PlaybackMetrics {
    return { ...this.metrics };
  }

  stop(): void {
    this.stopped = true;
    for (const handle of this.startingHandles) {
      handle.cancel("Server shutting down");
    }
    this.startingHandles.clear();
    for (const handle of this.activeProgressive.values()) {
      handle.cancel("Server shutting down");
    }
    this.activeProgressive.clear();
    for (const remux of [...this.activeRemuxProcs]) {
      remux.killSync();
    }
    this.ytDlp.stop?.();
  }

  async awaitShutdown(timeoutMs = 1000): Promise<void> {
    const waiters: Array<Promise<unknown>> = [];
    for (const remux of [...this.activeRemuxProcs]) {
      waiters.push(remux.exited);
    }
    if (this.ytDlp.awaitShutdown) {
      waiters.push(this.ytDlp.awaitShutdown(timeoutMs));
    }
    if (waiters.length === 0) return;
    await withTimeoutNull(Promise.allSettled(waiters), timeoutMs);
  }

  getCached(videoId: string): ResolvedVideoRecord | undefined {
    const rec = this.cache.get(videoId);
    if (rec && Date.now() >= rec.expiresAt - 60_000) {
      this.cache.delete(videoId);
      return undefined;
    }
    return rec;
  }

  invalidateVideo(videoId: string): void {
    this.cache.delete(videoId);
  }

  invalidateVideoIfTargetMatches(
    videoId: string,
    formatId: string,
    expectedTarget: StreamTarget,
  ): void {
    const rec = this.cache.get(videoId);
    if (rec && rec.targetsByFid.get(formatId) === expectedTarget) {
      this.cache.delete(videoId);
    }
  }

  markTargetStale(videoId: string, formatId: string, expectedTarget?: StreamTargetRemote): void {
    const rec = this.cache.get(videoId);
    if (!rec) return;
    const t = rec.targetsByFid.get(formatId);
    if (t && t.kind === "remote" && (!expectedTarget || t === expectedTarget)) {
      t.stale = true;
    }
  }

  async getCaptionsAnonymous(videoId: string): Promise<CaptionTrackRef[]> {
    assertValidVideoId(videoId);
    const cached = this.getCached(videoId);
    if (cached) return cached.captions;
    const hints = await this.fetchInnertubeHints(videoId, "http://127.0.0.1");
    return hints.captions;
  }

  getStreamTarget(
    videoId: string,
    formatId: string | null,
    itag: number | null,
    expected?: ExpectedTargetIdentity,
  ): StreamTarget | null {
    const rec = this.getCached(videoId);
    if (!rec) return null;
    return findStreamTargetInRecord(rec, formatId, itag, expected);
  }

  async resolveVideo(
    videoId: string,
    origin: string,
    options: {
      forceRefresh?: boolean;
      minTier?: PlaybackTier;
      maxTier?: PlaybackTier;
      skipFastInnertube?: boolean;
      publishToCache?: boolean;
    } = {},
  ): Promise<ResolvedVideoRecord> {
    assertValidVideoId(videoId);
    this.metrics.totalRequests++;
    const minTier = options.minTier ?? 1;
    const maxTier = options.maxTier ?? 3;
    const publishToCache = options.publishToCache ?? true;

    if (!options.forceRefresh && minTier === 1 && publishToCache) {
      const cached = this.getCached(videoId);
      if (cached) return cached;
    }

    const usePrimaryCacheKey = publishToCache && !options.forceRefresh && minTier === 1 && maxTier === 3;
    const cacheKey = usePrimaryCacheKey
      ? videoId
      : `${videoId}:t${minTier}-${maxTier}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    const record = await this.cache.getOrCompute(cacheKey, async () => {
      const resolved = await this.executeEscalationLadder(
        videoId,
        origin,
        minTier,
        maxTier,
        Boolean(options.skipFastInnertube),
      );
      const ttlMs = Math.max(
        60_000,
        Math.min(this.config.playback.videoCacheTtlSec * 1000, resolved.expiresAt - Date.now()),
      );
      return { value: resolved, ttlMs, cache: usePrimaryCacheKey };
    });

    if (publishToCache && !usePrimaryCacheKey) {
      const existing = this.cache.get(videoId);
      // Never let a slower lower-tier refresh clobber a newer higher-tier promotion
      if (!existing || record.tier >= existing.tier || Date.now() >= existing.expiresAt - 60_000) {
        const ttlMs = Math.max(
          60_000,
          Math.min(this.config.playback.videoCacheTtlSec * 1000, record.expiresAt - Date.now()),
        );
        this.cache.set(videoId, record, ttlMs);
      }
    }

    return record;
  }

  /**
   * Called by `/videoplayback` when an upstream `googlevideo.com` URL fails
   * mid-playback (403, 410, 429, 5xx, stall). Escalates silently:
   *   Tier 1 -> Tier 1 refresh (if stale) or Tier 2 (Firefox cookies) -> Tier 3 (local disk buffer).
   *
   * Remote refresh steps resolve with `publishToCache: false` and `maxTier` caps so
   * incompatible layouts or lower tiers never poison the live cache or clobber other tracks.
   */
  async recoverFormatMidPlayback(
    videoId: string,
    formatId: string,
    itag: number,
    origin: string,
    failedTarget: StreamTargetRemote,
    options: { requestedRangeStart?: number; maxSequentialOffsetBytes?: number } = {},
  ): Promise<StreamTarget | null> {
    assertValidVideoId(videoId);
    const cacheFormatId = formatId || String(itag);
    const inflightKey = `${videoId}:${cacheFormatId}`;
    const failedIsDrc = Boolean(failedTarget.isDrc || cacheFormatId.includes("drc"));

    const matchesDashRanges = (actual?: DashRangeIdentity | null): boolean => {
      if (!failedTarget.dashRanges) return true;
      return Boolean(
        actual &&
          actual.init === failedTarget.dashRanges.init &&
          actual.index === failedTarget.dashRanges.index,
      );
    };

    const findByteCompatibleTarget = (rec: ResolvedVideoRecord): StreamTarget | null => {
      const exact = formatId ? rec.targetsByFid.get(formatId) : undefined;
      if (exact) {
        if (!matchesDashRanges(exact.dashRanges)) {
          // Same fid but different DASH init/index box layout -> incompatible!
        } else if (exact.kind === "local" || exact.kind === "progressive") {
          if (failedTarget.clen === 0 || exact.size === failedTarget.clen) {
            return exact;
          }
        } else if (failedTarget.clen === 0 || exact.clen === 0 || exact.clen === failedTarget.clen) {
          return exact;
        }
      }
      // Fallback by (itag, isDrc, exact clen, exact DASH ranges) across all tracks
      if (itag > 0 && failedTarget.clen > 0) {
        for (const candidate of rec.targetsByFid.values()) {
          if (
            candidate.kind === "remote" &&
            candidate.itag === itag &&
            Boolean(candidate.isDrc) === failedIsDrc &&
            candidate.clen === failedTarget.clen &&
            matchesDashRanges(candidate.dashRanges)
          ) {
            return candidate;
          }
        }
      }
      return null;
    };

    const mergeRecoveredRemoteTarget = (
      candidate: StreamTargetRemote,
      freshRec: ResolvedVideoRecord,
    ): StreamTargetRemote => {
      const merged: StreamTargetRemote = {
        ...candidate,
        formatId: cacheFormatId,
        dashRanges: candidate.dashRanges ?? failedTarget.dashRanges,
        ytDlpFormatId: candidate.ytDlpFormatId ?? failedTarget.ytDlpFormatId,
        isDrc: candidate.isDrc ?? failedIsDrc,
      };
      // Publish ONLY if the live cache record still owns the exact `failedTarget` that initiated recovery
      const liveRec = this.cache.get(videoId);
      if (liveRec && liveRec.targetsByFid.get(cacheFormatId) === failedTarget) {
        liveRec.targetsByFid.set(cacheFormatId, merged);
        if (
          itag > 0 &&
          (!liveRec.targetsByItag.has(itag) ||
            liveRec.targetsByItag.get(itag) === failedTarget ||
            (!merged.isDrc && liveRec.targetsByItag.get(itag)?.formatId === cacheFormatId))
        ) {
          liveRec.targetsByItag.set(itag, merged);
        }
        if (freshRec.expiresAt > liveRec.expiresAt) {
          liveRec.expiresAt = freshRec.expiresAt;
        }
      }
      return merged;
    };

    const reuseValidLocal = (entry: EphemeralFileEntry | null): StreamTargetLocal | null => {
      if (!entry) return null;
      if (failedTarget.clen > 0 && entry.size !== failedTarget.clen) {
        this.logger.warn("Discarding stale local Tier 3 file whose size mismatches live stream", {
          videoId,
          formatId: cacheFormatId,
          expectedClen: failedTarget.clen,
          actualSize: entry.size,
        });
        this.ephemeralStore.delete(videoId, cacheFormatId);
        return null;
      }
      if (!doesLocalFileMatchDashRanges(entry.filePath, failedTarget.mimeType, failedTarget.dashRanges)) {
        this.logger.warn("Discarding stale local Tier 3 file whose DASH layout mismatches live stream", {
          videoId,
          formatId: cacheFormatId,
          expectedLayout: formatDashLayoutKey(failedTarget.dashRanges),
        });
        this.ephemeralStore.delete(videoId, cacheFormatId);
        return null;
      }
      // Restore accurate MIME type (startup disk scan labels .webm audio as video/webm)
      entry.mimeType = failedTarget.mimeType;
      return this.promoteToLocalTarget(
        videoId,
        cacheFormatId,
        itag,
        entry.filePath,
        failedTarget.mimeType,
        failedTarget.dashRanges,
        failedTarget,
      );
    };

    // Phase 1: Shared remote refresh (Steps 1a, 1b, 2) — independent of caller byte offset so
    // a far-seek caller never blocks a concurrent byte-0 caller from starting Tier 3!
    const runRemotePhase = async (): Promise<RemoteRecoveryOutcome> => {
      const existingRemote = this.remoteRecoveryInflight.get(inflightKey);
      if (existingRemote) return existingRemote;

      const remotePromise = (async (): Promise<RemoteRecoveryOutcome> => {
        this.metrics.midPlaybackRecoveries++;
        this.logger.warn("Mid-playback upstream failure; attempting silent recovery", {
          videoId,
          formatId: cacheFormatId,
          itag,
          currentTier: failedTarget.tier,
        });

        const currentRec = this.cache.get(videoId);
        const targetResolvedAt = failedTarget.resolvedAt || currentRec?.resolvedAt || 0;
        const ageMs = targetResolvedAt > 0 ? Date.now() - targetResolvedAt : Infinity;
        let verifiedYtDlpFormatId: string | undefined = failedTarget.ytDlpFormatId;
        let ytDlpCheckedAndUnmatched = false;

        // Step 1a: Fast InnerTube refresh if Tier 1 came from InnerTube and is >20s old
        if (
          failedTarget.tier === 1 &&
          failedTarget.resolvedBy === "innertube" &&
          ageMs > 20_000
        ) {
          try {
            const fresh = await this.singleFlightRefresh(
              videoId,
              1,
              () =>
                this.resolveVideo(videoId, origin, {
                  forceRefresh: true,
                  minTier: 1,
                  maxTier: 1,
                  skipFastInnertube: false,
                  publishToCache: false,
                }),
              "innertube",
            );
            const nextTarget = findByteCompatibleTarget(fresh);
            if (nextTarget) {
              if (nextTarget.kind !== "remote") {
                return { target: nextTarget, verifiedYtDlpFormatId, ytDlpCheckedAndUnmatched };
              }
              if (nextTarget.url !== failedTarget.url) {
                this.logger.info("Mid-playback recovery succeeded via Tier 1 fast refresh", {
                  videoId,
                  formatId: cacheFormatId,
                  resolvedBy: fresh.resolvedBy,
                });
                return {
                  target: mergeRecoveredRemoteTarget(nextTarget, fresh),
                  verifiedYtDlpFormatId,
                  ytDlpCheckedAndUnmatched,
                };
              }
            }
          } catch (err) {
            this.logger.warn("Tier 1 fast refresh failed during mid-playback recovery", {
              videoId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Step 1b: yt-dlp Tier 1 refresh if cached >20s or originated from fast InnerTube
        if (failedTarget.tier === 1 && (ageMs > 20_000 || failedTarget.resolvedBy === "innertube")) {
          try {
            const fresh = await this.singleFlightRefresh(
              videoId,
              1,
              () =>
                this.resolveVideo(videoId, origin, {
                  forceRefresh: true,
                  minTier: 1,
                  maxTier: 1,
                  skipFastInnertube: true,
                  publishToCache: false,
                }),
              "ytdlp",
            );
            const nextTarget = findByteCompatibleTarget(fresh);
            if (nextTarget) {
              if (nextTarget.kind !== "remote") {
                return { target: nextTarget, verifiedYtDlpFormatId, ytDlpCheckedAndUnmatched };
              }
              if (nextTarget.ytDlpFormatId) {
                verifiedYtDlpFormatId = nextTarget.ytDlpFormatId;
              }
              if (nextTarget.url !== failedTarget.url) {
                this.logger.info("Mid-playback recovery succeeded via Tier 1 yt-dlp refresh", {
                  videoId,
                  formatId: cacheFormatId,
                });
                return {
                  target: mergeRecoveredRemoteTarget(nextTarget, fresh),
                  verifiedYtDlpFormatId,
                  ytDlpCheckedAndUnmatched,
                };
              }
            } else {
              ytDlpCheckedAndUnmatched = true;
            }
          } catch (err) {
            this.logger.warn("Tier 1 yt-dlp refresh failed during mid-playback recovery", {
              videoId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Step 2: Escalate silently to Tier 2 (Firefox cookies), OR refresh an older Tier 2 URL once
        if (
          this.config.playback.authFallback.enabled &&
          (failedTarget.tier < 2 || (failedTarget.tier === 2 && ageMs > 20_000))
        ) {
          const isTier2Refresh = failedTarget.tier === 2;
          try {
            const tier2Rec = await this.singleFlightRefresh(
              videoId,
              2,
              () =>
                this.resolveVideo(videoId, origin, {
                  forceRefresh: true,
                  minTier: 2,
                  maxTier: 2,
                  publishToCache: false,
                }),
              isTier2Refresh ? "refresh" : "escalate",
            );
            const nextTarget = findByteCompatibleTarget(tier2Rec);
            if (nextTarget) {
              if (nextTarget.kind !== "remote") {
                return { target: nextTarget, verifiedYtDlpFormatId, ytDlpCheckedAndUnmatched };
              }
              if (nextTarget.ytDlpFormatId) {
                verifiedYtDlpFormatId = nextTarget.ytDlpFormatId;
                ytDlpCheckedAndUnmatched = false;
              }
              if (!isTier2Refresh || nextTarget.url !== failedTarget.url) {
                this.logger.info(
                  isTier2Refresh
                    ? "Mid-playback recovery succeeded via Tier 2 refresh"
                    : "Mid-playback recovery escalated to Tier 2",
                  { videoId, formatId: cacheFormatId },
                );
                return {
                  target: mergeRecoveredRemoteTarget(nextTarget, tier2Rec),
                  verifiedYtDlpFormatId,
                  ytDlpCheckedAndUnmatched,
                };
              }
            } else {
              ytDlpCheckedAndUnmatched = true;
            }
          } catch (err) {
            this.logger.warn(
              isTier2Refresh
                ? "Tier 2 refresh failed during mid-playback recovery"
                : "Tier 2 escalation failed during mid-playback recovery",
              {
                videoId,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
        }

        return { target: null, verifiedYtDlpFormatId, ytDlpCheckedAndUnmatched };
      })();

      this.remoteRecoveryInflight.set(inflightKey, remotePromise);
      try {
        return await remotePromise;
      } finally {
        this.remoteRecoveryInflight.delete(inflightKey);
      }
    };

    try {
      const remoteOutcome = await runRemotePhase();
      if (remoteOutcome.target) {
        return remoteOutcome.target;
      }

      // Phase 2: Step 3 Tier 3 ephemeral buffer — evaluate THIS caller's byte offset FIRST!
      if (!this.config.playback.ephemeralBuffer.enabled || this.stopped) {
        return null;
      }

      const pinKey = this.ephemeralStore.makeKey(videoId, cacheFormatId);
      const existingLocal = reuseValidLocal(this.ephemeralStore.get(videoId, cacheFormatId));
      if (existingLocal) {
        return existingLocal;
      }

      const existingProgressive = this.activeProgressive.get(pinKey);
      if (existingProgressive && existingProgressive.getStatus() !== "failed") {
        return this.promoteToProgressiveTarget(
          videoId,
          cacheFormatId,
          itag,
          existingProgressive,
          failedTarget.dashRanges,
          failedTarget,
        );
      }

      // Evaluate seek-offset guardrail per caller BEFORE joining/starting Tier 3
      const maxOffsetBytes =
        options.maxSequentialOffsetBytes ?? MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES;
      if (
        options.requestedRangeStart !== undefined &&
        options.requestedRangeStart > maxOffsetBytes
      ) {
        this.logger.warn(
          "Skipping Tier 3 mid-playback buffer: requested byte offset is too far ahead for sequential download",
          {
            videoId,
            formatId: cacheFormatId,
            requestedRangeStart: options.requestedRangeStart,
            maxOffsetBytes,
          },
        );
        return null;
      }

      const existingTier3 = this.tier3RecoveryInflight.get(inflightKey);
      if (existingTier3) {
        return await existingTier3;
      }

      const tier3Promise = (async (): Promise<StreamTarget | null> => {
        if (this.stopped) return null;

        const recheckLocalPre = reuseValidLocal(this.ephemeralStore.get(videoId, cacheFormatId));
        if (recheckLocalPre) return recheckLocalPre;
        const recheckProgPre = this.activeProgressive.get(pinKey);
        if (recheckProgPre && recheckProgPre.getStatus() !== "failed") {
          return this.promoteToProgressiveTarget(
            videoId,
            cacheFormatId,
            itag,
            recheckProgPre,
            failedTarget.dashRanges,
            failedTarget,
          );
        }

        if (failedTarget.tier3CooldownUntil && Date.now() < failedTarget.tier3CooldownUntil) {
          this.logger.debug("Skipping Tier 3 mid-playback buffer during cooldown", {
            videoId,
            formatId: cacheFormatId,
          });
          return null;
        }

        const maxCacheBytes = this.config.playback.ephemeralBuffer.maxCacheBytes;
        const sizeEstimate = failedTarget.clen || failedTarget.approxSize || 0;
        if (sizeEstimate > 0 && sizeEstimate > maxCacheBytes) {
          this.logger.warn("Skipping Tier 3 mid-playback buffer: stream exceeds maxCacheBytes", {
            videoId,
            formatId: cacheFormatId,
            sizeEstimate,
            maxCacheBytes,
          });
          failedTarget.tier3CooldownUntil = Date.now() + 5 * 60_000;
          return null;
        }

        // Verify the real yt-dlp format_id selector (never blindly pass synthetic InnerTube IDs)
        let verifiedYtDlpFormatId = remoteOutcome.verifiedYtDlpFormatId;
        if (!verifiedYtDlpFormatId) {
          if (!remoteOutcome.ytDlpCheckedAndUnmatched) {
            verifiedYtDlpFormatId =
              (await this.resolveYtDlpFormatIdForTarget(videoId, failedTarget)) ?? undefined;
          }
          if (!verifiedYtDlpFormatId) {
            this.logger.warn(
              "Skipping Tier 3 mid-playback buffer: no byte-compatible yt-dlp format matched track",
              { videoId, formatId: cacheFormatId, itag, clen: failedTarget.clen },
            );
            failedTarget.tier3CooldownUntil = Date.now() + 60_000;
            return null;
          }
        }
        const ytDlpSelector = verifiedYtDlpFormatId;

        const ext = failedTarget.mimeType.includes("webm")
          ? "webm"
          : failedTarget.mimeType.startsWith("audio/")
            ? "m4a"
            : "mp4";
        const outPath = this.ephemeralStore.getPathFor(videoId, cacheFormatId, ext);

        // Compute how many initial header bytes we should verify before advertising 206 progressive
        let startupVerifyBytes = 1;
        if (failedTarget.dashRanges && failedTarget.clen > 0) {
          const initB = parseRangeBounds(failedTarget.dashRanges.init);
          const indexB = parseRangeBounds(failedTarget.dashRanges.index);
          if (initB && indexB) {
            if (!failedTarget.mimeType.includes("webm") && indexB.end + 1 <= 65536) {
              startupVerifyBytes = Math.min(failedTarget.clen, Math.max(initB.end, indexB.end) + 1);
            } else if (failedTarget.mimeType.includes("webm")) {
              const targetEnd = indexB.end + 1 <= 65536 ? Math.max(initB.end, indexB.end) : initB.end;
              if (targetEnd + 1 <= 65536) {
                startupVerifyBytes = Math.min(failedTarget.clen, targetEnd + 1);
              }
            }
          }
        }

        // Progressive streaming path: ONLY when `clen` is strictly authoritative exact (never approxSize!)
        if (failedTarget.clen > 0 && typeof this.ytDlp.startProgressiveDownload === "function") {
          let releasePermit: () => void;
          try {
            releasePermit = await this.tier3Semaphore.acquirePermit(5_000);
          } catch {
            this.logger.warn("Skipping Tier 3 progressive buffer: concurrent Tier 3 slots busy", {
              videoId,
              formatId: cacheFormatId,
            });
            return null;
          }
          let permitOwnedByBackground = false;
          let reservationActive = false;
          this.ephemeralStore.pin(pinKey);

          try {
            if (this.stopped) return null;

            const recheckLocal = reuseValidLocal(this.ephemeralStore.get(videoId, cacheFormatId));
            if (recheckLocal) {
              return recheckLocal;
            }
            const recheckProgressive = this.activeProgressive.get(pinKey);
            if (recheckProgressive && recheckProgressive.getStatus() !== "failed") {
              return this.promoteToProgressiveTarget(
                videoId,
                cacheFormatId,
                itag,
                recheckProgressive,
                failedTarget.dashRanges,
                failedTarget,
              );
            }

            if (!this.ephemeralStore.reserveBytes(pinKey, failedTarget.clen)) {
              this.logger.warn(
                "Skipping Tier 3 progressive buffer: insufficient shared ephemeral disk budget",
                {
                  videoId,
                  formatId: cacheFormatId,
                  clen: failedTarget.clen,
                  maxCacheBytes,
                },
              );
              return null;
            }
            reservationActive = true;

            const startAttempt = async (useAuth: boolean): Promise<ProgressiveDownloadHandle> => {
              if (this.stopped) throw new Error("Server shutting down");
              const handle = await this.ytDlp.startProgressiveDownload!(
                videoId,
                ytDlpSelector,
                outPath,
                {
                  useAuth,
                  mimeType: failedTarget.mimeType,
                  expectedSize: failedTarget.clen,
                  maxBytes: Math.min(maxCacheBytes, failedTarget.clen),
                  cacheFormatId,
                },
              );
              if (this.stopped) {
                handle.cancel("Server shutting down");
                handle.done.catch(() => {});
                throw new Error("Server shutting down");
              }
              this.startingHandles.add(handle);
              const startupWaitMs = Math.min(this.config.playback.ytDlpTimeoutMs, 20_000);
              try {
                await handle.waitForBytes(startupVerifyBytes, undefined, startupWaitMs);
                if (this.stopped) {
                  handle.cancel("Server shutting down");
                  handle.done.catch(() => {});
                  throw new Error("Server shutting down");
                }
                if (
                  failedTarget.dashRanges &&
                  !doesLocalFileMatchDashRanges(
                    handle.getReadablePath(),
                    failedTarget.mimeType,
                    failedTarget.dashRanges,
                    true,
                  )
                ) {
                  const layoutErr = new Error(
                    `Tier 3 progressive download DASH layout mismatched expected ${formatDashLayoutKey(failedTarget.dashRanges)}`,
                  );
                  layoutErr.name = "LayoutMismatchError";
                  throw layoutErr;
                }
                return handle;
              } catch (err) {
                handle.cancel("Failed startup verification");
                handle.done.catch(() => {});
                throw err;
              } finally {
                this.startingHandles.delete(handle);
              }
            };

            const initialUseAuth =
              failedTarget.tier === 2 && this.config.playback.authFallback.enabled;
            let handle: ProgressiveDownloadHandle;
            try {
              handle = await startAttempt(initialUseAuth);
            } catch (firstErr) {
              const isLayoutErr =
                firstErr instanceof Error && firstErr.name === "LayoutMismatchError";
              if (
                !this.stopped &&
                !isLayoutErr &&
                !initialUseAuth &&
                this.config.playback.authFallback.enabled
              ) {
                handle = await startAttempt(true);
              } else {
                throw firstErr;
              }
            }

            if (this.stopped) {
              handle.cancel("Server shutting down");
              handle.done.catch(() => {});
              return null;
            }

            this.activeProgressive.set(pinKey, handle);
            const progressiveTarget = this.promoteToProgressiveTarget(
              videoId,
              cacheFormatId,
              itag,
              handle,
              failedTarget.dashRanges,
              failedTarget,
            );
            this.metrics.tier3Hits++;
            this.logger.info("Mid-playback recovery escalated to Tier 3 progressive stream", {
              videoId,
              formatId: cacheFormatId,
              ytDlpSelector,
              expectedSize: failedTarget.clen,
            });

            permitOwnedByBackground = true;
            handle.done
              .then(({ filePath }) => {
                // Verify final file DASH ranges before registering/promoting
                if (
                  failedTarget.dashRanges &&
                  !doesLocalFileMatchDashRanges(filePath, failedTarget.mimeType, failedTarget.dashRanges)
                ) {
                  try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                  } catch {
                    // Ignore
                  }
                  this.invalidateVideoIfTargetMatches(videoId, cacheFormatId, progressiveTarget);
                  return;
                }
                // Release reservation immediately before register() so cleanup() never double-counts
                this.ephemeralStore.releaseReservation(pinKey);
                this.ephemeralStore.register(videoId, cacheFormatId, filePath, failedTarget.mimeType);
                const rec = this.cache.get(videoId);
                if (rec && rec.targetsByFid.get(cacheFormatId) === progressiveTarget) {
                  this.promoteToLocalTarget(
                    videoId,
                    cacheFormatId,
                    itag,
                    filePath,
                    failedTarget.mimeType,
                    failedTarget.dashRanges,
                    progressiveTarget,
                  );
                }
              })
              .catch((err) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                const isIdleCancel = err instanceof Error && err.name === "IdleCancelledError";
                this.logger.warn("Tier 3 progressive download terminated with error", {
                  videoId,
                  formatId: cacheFormatId,
                  error: errMsg,
                });
                if (err instanceof Error && err.name === "SizeMismatchError") {
                  this.invalidateVideoIfTargetMatches(videoId, cacheFormatId, progressiveTarget);
                  return;
                }
                failedTarget.stale = false;
                if (!isIdleCancel) {
                  failedTarget.tier3CooldownUntil = Date.now() + 60_000;
                }
                const rec = this.cache.get(videoId);
                if (rec && rec.targetsByFid.get(cacheFormatId) === progressiveTarget) {
                  rec.targetsByFid.set(cacheFormatId, failedTarget);
                  if (itag > 0 && rec.targetsByItag.get(itag) === progressiveTarget) {
                    rec.targetsByItag.set(itag, failedTarget);
                  }
                }
              })
              .finally(() => {
                if (this.activeProgressive.get(pinKey) === handle) {
                  this.activeProgressive.delete(pinKey);
                }
                this.ephemeralStore.releaseReservation(pinKey);
                this.ephemeralStore.unpin(pinKey);
                releasePermit();
              });

            return progressiveTarget;
          } catch (err) {
            if (err instanceof Error && err.name === "LayoutMismatchError") {
              this.invalidateVideoIfTargetMatches(videoId, cacheFormatId, failedTarget);
            } else if (!this.stopped) {
              failedTarget.tier3CooldownUntil = Date.now() + 60_000;
            }
            this.logger.error("Tier 3 progressive mid-playback startup failed", {
              videoId,
              formatId: cacheFormatId,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          } finally {
            if (!permitOwnedByBackground) {
              if (reservationActive) {
                this.ephemeralStore.releaseReservation(pinKey);
              }
              this.ephemeralStore.unpin(pinKey);
              releasePermit();
            }
          }
        }

        // Fallback non-progressive path (unknown exact clen or runner without progressive support)
        let fallbackPermit: () => void;
        try {
          fallbackPermit = await this.tier3Semaphore.acquirePermit(5_000);
        } catch {
          this.logger.warn("Skipping Tier 3 fallback buffer: concurrent Tier 3 slots busy", {
            videoId,
            formatId: cacheFormatId,
          });
          return null;
        }
        try {
          if (this.stopped) return null;
          const recheck = reuseValidLocal(this.ephemeralStore.get(videoId, cacheFormatId));
          if (recheck) {
            return recheck;
          }

          const budgetBefore = this.ephemeralStore.getAvailableBudgetFor(pinKey);
          if (failedTarget.clen > 0) {
            if (!this.ephemeralStore.reserveBytes(pinKey, failedTarget.clen)) {
              this.logger.warn(
                "Skipping Tier 3 fallback buffer: insufficient shared ephemeral disk budget",
                { videoId, formatId: cacheFormatId, clen: failedTarget.clen, maxCacheBytes },
              );
              return null;
            }
          } else if (budgetBefore <= 0) {
            return null;
          }

          const downloadMaxBytes =
            failedTarget.clen > 0
              ? Math.min(maxCacheBytes, failedTarget.clen)
              : Math.min(maxCacheBytes, budgetBefore);
          const onStagingBytes =
            failedTarget.clen > 0
              ? undefined
              : (bytes: number) => this.ephemeralStore.reserveBytes(pinKey, bytes);

          this.ephemeralStore.pin(pinKey);

          try {
            const useAuth = failedTarget.tier === 2 && this.config.playback.authFallback.enabled;
            try {
              await this.ytDlp.downloadFormat(videoId, ytDlpSelector, outPath, {
                useAuth,
                maxBytes: downloadMaxBytes,
                onStagingBytes,
              });
            } catch (firstErr) {
              const isBudgetErr =
                firstErr instanceof Error && firstErr.name === "BudgetExceededError";
              if (!this.stopped && !isBudgetErr && !useAuth && this.config.playback.authFallback.enabled) {
                await this.ytDlp.downloadFormat(videoId, ytDlpSelector, outPath, {
                  useAuth: true,
                  maxBytes: downloadMaxBytes,
                  onStagingBytes,
                });
              } else {
                throw firstErr;
              }
            }

            this.ephemeralStore.releaseReservation(pinKey);
            const entry = this.ephemeralStore.register(
              videoId,
              cacheFormatId,
              outPath,
              failedTarget.mimeType,
            );
            const allowedBytes = this.ephemeralStore.getAvailableBudgetFor(pinKey);
            if (entry.size > maxCacheBytes || entry.size > allowedBytes) {
              this.logger.warn("Tier 3 downloaded file exceeded available cache budget; discarding", {
                videoId,
                formatId: cacheFormatId,
                actualSize: entry.size,
                maxCacheBytes,
                allowedBytes,
              });
              this.ephemeralStore.delete(videoId, cacheFormatId);
              failedTarget.tier3CooldownUntil = Date.now() + 5 * 60_000;
              return null;
            }
            // Verify byte length and DASH init/index compatibility with Shaka's parsed segment index
            if (
              (failedTarget.clen > 0 && entry.size !== failedTarget.clen) ||
              !doesLocalFileMatchDashRanges(outPath, failedTarget.mimeType, failedTarget.dashRanges)
            ) {
              this.logger.warn("Tier 3 downloaded stream differs from original layout/size; forcing reload", {
                videoId,
                formatId: cacheFormatId,
                expectedClen: failedTarget.clen,
                actualSize: entry.size,
                expectedLayout: formatDashLayoutKey(failedTarget.dashRanges),
              });
              this.ephemeralStore.delete(videoId, cacheFormatId);
              this.invalidateVideoIfTargetMatches(videoId, cacheFormatId, failedTarget);
              return null;
            }
            const localTarget = this.promoteToLocalTarget(
              videoId,
              cacheFormatId,
              itag,
              outPath,
              failedTarget.mimeType,
              failedTarget.dashRanges,
              failedTarget,
            );
            this.metrics.tier3Hits++;
            this.logger.info("Mid-playback recovery escalated to Tier 3 ephemeral buffer", {
              videoId,
              formatId: cacheFormatId,
              ytDlpSelector,
            });
            return localTarget;
          } catch (err) {
            failedTarget.tier3CooldownUntil = Date.now() + 60_000;
            this.logger.error("Tier 3 mid-playback buffer failed", {
              videoId,
              formatId: cacheFormatId,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          } finally {
            this.ephemeralStore.releaseReservation(pinKey);
            this.ephemeralStore.unpin(pinKey);
          }
        } finally {
          fallbackPermit();
        }
      })();

      this.tier3RecoveryInflight.set(inflightKey, tier3Promise);
      try {
        return await tier3Promise;
      } finally {
        this.tier3RecoveryInflight.delete(inflightKey);
      }
    } finally {
      // Always clear `stale` on the failed target so a failed/skipped recovery
      // never traps subsequent requests in an infinite recovery loop.
      failedTarget.stale = false;
    }
  }

  private async resolveYtDlpFormatIdForTarget(
    videoId: string,
    target: StreamTargetRemote,
  ): Promise<string | null> {
    const tryExtract = async (useAuth: boolean): Promise<string | null> => {
      const ytInfo = await this.ytDlp.extractVideoInfo(videoId, { useAuth });
      return findMatchingYtDlpFormatId(ytInfo.formats || [], target);
    };
    const initialUseAuth = target.tier === 2 && this.config.playback.authFallback.enabled;
    try {
      const matched = await tryExtract(initialUseAuth);
      if (matched) return matched;
    } catch {
      // Fall through to auth attempt if permitted
    }
    if (!initialUseAuth && this.config.playback.authFallback.enabled) {
      try {
        return await tryExtract(true);
      } catch {
        return null;
      }
    }
    return null;
  }

  getStoryboardVtt(videoId: string, height: number, origin: string): string {
    const rec = this.cache.get(videoId);
    if (!rec || rec.storyboards.length === 0) return "WEBVTT\n\n";
    return buildStoryboardWebVtt(rec.storyboards, rec.durationSec, height, origin);
  }

  private singleFlightRefresh(
    videoId: string,
    tier: PlaybackTier,
    fn: () => Promise<ResolvedVideoRecord>,
    variant = "default",
  ): Promise<ResolvedVideoRecord> {
    const key = `${videoId}:t${tier}:${variant}`;
    const existing = this.videoRefreshInflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => {
      this.videoRefreshInflight.delete(key);
    });
    this.videoRefreshInflight.set(key, p);
    return p;
  }

  private promoteToProgressiveTarget(
    videoId: string,
    formatId: string,
    itag: number,
    source: ProgressiveStreamSource,
    dashRanges?: DashRangeIdentity,
    expectedCurrent?: StreamTarget,
  ): StreamTargetProgressive {
    const progressiveTarget: StreamTargetProgressive = {
      kind: "progressive",
      videoId,
      formatId,
      itag,
      mimeType: source.mimeType,
      size: source.expectedSize,
      dashRanges,
      tier: 3,
      source,
    };
    const rec = this.cache.get(videoId);
    if (rec && (!expectedCurrent || rec.targetsByFid.get(formatId) === expectedCurrent)) {
      rec.targetsByFid.set(formatId, progressiveTarget);
      const isDrc = formatId.includes("drc");
      if (
        itag > 0 &&
        (!rec.targetsByItag.has(itag) ||
          rec.targetsByItag.get(itag) === expectedCurrent ||
          rec.targetsByItag.get(itag)?.formatId === formatId ||
          !isDrc)
      ) {
        rec.targetsByItag.set(itag, progressiveTarget);
      }
    }
    return progressiveTarget;
  }

  private promoteToLocalTarget(
    videoId: string,
    formatId: string,
    itag: number,
    filePath: string,
    mimeType: string,
    dashRanges?: DashRangeIdentity,
    expectedCurrent?: StreamTarget,
  ): StreamTargetLocal {
    const size = fs.statSync(filePath).size;
    const localTarget: StreamTargetLocal = {
      kind: "local",
      videoId,
      formatId,
      itag,
      filePath,
      mimeType,
      size,
      dashRanges,
      tier: 3,
    };
    const rec = this.cache.get(videoId);
    if (rec && (!expectedCurrent || rec.targetsByFid.get(formatId) === expectedCurrent)) {
      rec.targetsByFid.set(formatId, localTarget);
      const isDrc = formatId.includes("drc");
      if (
        itag > 0 &&
        (!rec.targetsByItag.has(itag) ||
          rec.targetsByItag.get(itag) === expectedCurrent ||
          rec.targetsByItag.get(itag)?.formatId === formatId ||
          !isDrc)
      ) {
        rec.targetsByItag.set(itag, localTarget);
      }
    }
    return localTarget;
  }

  private async executeEscalationLadder(
    videoId: string,
    origin: string,
    minTier: PlaybackTier,
    maxTier: PlaybackTier = 3,
    skipFastInnertube = false,
  ): Promise<ResolvedVideoRecord> {
    // Launch anonymous IPv4 InnerTube metadata lookup in parallel (non-fatal, capped to 6s)
    const hintsPromise = this.fetchInnertubeHints(videoId, origin);

    let lastError: unknown = null;

    // ─── TIER 1a: Fast Anonymous IPv4 InnerTube (VISIONOS / ANDROID_VR / IOS) ──
    // Direct non-SABR 1080p/4K DASH streams with YouTube's exact init/index ranges in ~200ms!
    if (minTier <= 1 && maxTier >= 1 && !skipFastInnertube) {
      try {
        const fastRecord = await this.tryFastInnertubeDirect(videoId, origin, hintsPromise);
        if (fastRecord && fastRecord.adaptiveFormats.length >= 2) {
          this.metrics.tier1Hits++;
          return fastRecord;
        }
      } catch (err) {
        lastError = err;
        this.logger.debug("Tier 1a fast IPv4 InnerTube skipped; falling through to yt-dlp -4", {
          videoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ─── TIER 1b: Anonymous IPv4 yt-dlp (-4 + Deno + optional bgutil POT) ──────
    if (minTier <= 1 && maxTier >= 1) {
      try {
        const ytInfo = await this.ytDlp.extractVideoInfo(videoId, { useAuth: false });
        const hints = await hintsPromise;
        const record = await this.buildResolvedFromYtDlp(videoId, origin, ytInfo, hints, 1);
        if (record.adaptiveFormats.length > 0 || (record.payload.formatStreams as unknown[]).length > 0) {
          this.metrics.tier1Hits++;
          return record;
        }
        lastError = new Error("Tier 1 returned no direct playable DASH/MP4 formats");
        this.logger.warn("Tier 1 returned no direct playable formats; escalating", { videoId });
      } catch (err) {
        lastError = err;
        this.logger.warn("Tier 1 extraction failed", {
          videoId,
          kind: err instanceof YtDlpError ? err.kind : "unknown",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ─── TIER 2: Silent Auth Fallback (Dedicated Firefox profile, NO --mark-watched) ─
    const isPermanentUnavailable =
      lastError instanceof YtDlpError && lastError.kind === "unavailable";
    const isTransientTimeout =
      lastError instanceof YtDlpError && lastError.kind === "timeout";

    if (
      minTier <= 2 &&
      maxTier >= 2 &&
      this.config.playback.authFallback.enabled &&
      !isPermanentUnavailable &&
      !isTransientTimeout
    ) {
      try {
        const ytInfo = await this.ytDlp.extractVideoInfo(videoId, { useAuth: true });
        const hints = await hintsPromise;
        const record = await this.buildResolvedFromYtDlp(videoId, origin, ytInfo, hints, 2);
        if (record.adaptiveFormats.length > 0 || (record.payload.formatStreams as unknown[]).length > 0) {
          this.metrics.tier2Hits++;
          this.logger.info("Tier 2 silent auth fallback succeeded", { videoId });
          return record;
        }
        lastError = new Error("Tier 2 returned no direct playable DASH/MP4 formats");
        this.logger.warn("Tier 2 returned no direct playable formats; escalating to Tier 3", {
          videoId,
        });
      } catch (err) {
        lastError = err;
        this.logger.warn("Tier 2 silent auth fallback failed", {
          videoId,
          kind: err instanceof YtDlpError ? err.kind : "unknown",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ─── TIER 3: Silent Ephemeral Buffer Fallback ──────────────────────────────
    if (maxTier >= 3 && this.config.playback.ephemeralBuffer.enabled && !isPermanentUnavailable && !this.stopped) {
      try {
        const hints = await hintsPromise;
        const record = await this.buildResolvedFromEphemeralBuffer(videoId, origin, hints);
        this.metrics.tier3Hits++;
        this.logger.info("Tier 3 silent ephemeral buffer fallback succeeded", { videoId });
        return record;
      } catch (err) {
        lastError = err;
        this.logger.error("Tier 3 ephemeral buffer fallback failed", {
          videoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to resolve video ${videoId}`);
  }

  private async tryFastInnertubeDirect(
    videoId: string,
    origin: string,
    hintsPromise: Promise<InnertubeMetaHints>,
  ): Promise<ResolvedVideoRecord | null> {
    const client: any = await this.innertubeProvider.getClient();
    if (typeof client?.getBasicInfo !== "function") {
      return null;
    }

    let info: any = null;
    let usedClient = "";
    const startMs = Date.now();

    // Prefer VISIONOS first (no 60-second anonymous 403 cap; verified 206 across full multi-GB 4K60 VODs!),
    // falling back to ANDROID_VR / IOS only if VISIONOS is unavailable.
    for (const clientName of ["VISIONOS", "ANDROID_VR", "IOS"] as const) {
      try {
        const candidate: any = await withTimeoutNull(
          client.getBasicInfo(videoId, { client: clientName }),
          5000,
        );
        if (!candidate) continue;
        if (candidate.playability_status?.status !== "OK") continue;
        const af: any[] = candidate.streaming_data?.adaptive_formats || [];
        const usable = af.filter(
          (f: any) => f?.url && f?.init_range && f?.index_range && !f?.is_type_otf,
        );
        const hasV = usable.some((f: any) => f.has_video || String(f.mime_type || "").startsWith("video/"));
        const hasA = usable.some((f: any) => f.has_audio || String(f.mime_type || "").startsWith("audio/"));
        if (hasV && hasA) {
          info = candidate;
          usedClient = clientName;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!info) return null;

    const hints = await hintsPromise;
    const basic = info.basic_info || {};
    const durationSec = Math.max(1, Math.round(Number(basic.duration || hints.durationSec || 0)));
    const targetsByFid = new Map<string, StreamTarget>();
    const targetsByItag = new Map<number, StreamTarget>();
    const adaptiveFormats: AdaptiveFormatOutput[] = [];
    let earliestExpireSec = Math.floor(Date.now() / 1000) + 6 * 3600;

    const rawAdaptive: any[] = info.streaming_data?.adaptive_formats || [];
    const seenFids = new Set<string>();

    for (const fmt of rawAdaptive) {
      if (!fmt?.url || !fmt?.init_range || !fmt?.index_range || fmt?.is_type_otf) continue;
      const mimeType = String(fmt.mime_type || "");
      if (!mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) continue;

      const itag = Number(fmt.itag) || 0;
      if (!itag) continue;

      const meta = extractUrlMeta(fmt.url, durationSec);
      const clen = Number(fmt.content_length) || meta.clen || 0;
      if (meta.expireSec < earliestExpireSec) earliestExpireSec = meta.expireSec;

      const fidParts = [String(itag)];
      if (fmt.is_drc) fidParts.push("drc");
      if (fmt.language) fidParts.push(String(fmt.language));
      if (fmt.audio_track?.id) fidParts.push(String(fmt.audio_track.id));
      let formatId = fidParts.join("-");
      if (seenFids.has(formatId)) {
        formatId = `${formatId}-${seenFids.size}`;
      }
      seenFids.add(formatId);

      const isVideo = mimeType.startsWith("video/");
      const baseContainer = mimeType.includes("webm") ? "webm" : "mp4";
      const codecMatch = /codecs="([^"]+)"/.exec(mimeType);
      const encoding = codecMatch ? codecMatch[1]! : "";
      const initStr = `${fmt.init_range.start}-${fmt.init_range.end}`;
      const indexStr = `${fmt.index_range.start}-${fmt.index_range.end}`;
      const dashRanges: DashRangeIdentity = { init: initStr, index: indexStr };

      const proxyUrl = buildProxyPlaybackUrl({
        origin,
        videoId,
        formatId,
        itag,
        durSec: meta.durSec,
        expireSec: meta.expireSec,
        clen,
        layout: formatDashLayoutKey(dashRanges),
        xtags: meta.xtags || (typeof fmt.xtags === "string" ? fmt.xtags : null),
      });

      const out: AdaptiveFormatOutput = {
        index: indexStr,
        init: initStr,
        bitrate: String(Math.max(1000, Number(fmt.bitrate) || 128_000)),
        url: proxyUrl,
        itag: String(itag),
        type: mimeType,
        clen: String(clen),
        lmt: String(fmt.last_modified_ms || meta.lmt || "0"),
        projectionType: String(fmt.projection_type || "RECTANGULAR"),
        container: baseContainer,
        encoding,
      };

      if (isVideo) {
        const w = Number(fmt.width) || 0;
        const h = Number(fmt.height) || 0;
        const fps = Math.round(Number(fmt.fps) || 30);
        if (w <= 0 || h <= 0) continue;
        out.size = `${w}x${h}`;
        out.fps = fps;
        out.resolution = `${h}p`;
        out.qualityLabel = fmt.quality_label || (fps > 30 ? `${h}p${fps}` : `${h}p`);
        if (fmt.color_info) {
          out.colorInfo = {
            primaries: fmt.color_info.primaries,
            transferCharacteristics: fmt.color_info.transfer_characteristics,
            matrixCoefficients: fmt.color_info.matrix_coefficients,
          };
        }
      } else {
        out.audioQuality = String(fmt.audio_quality || inferAudioQuality(Number(fmt.bitrate) / 1000));
        out.audioSampleRate = String(fmt.audio_sample_rate || 48000);
        out.audioChannels = Number(fmt.audio_channels) || 2;
      }

      adaptiveFormats.push(out);

      const target: StreamTargetRemote = {
        kind: "remote",
        videoId,
        formatId,
        itag,
        url: String(fmt.url),
        mimeType: mimeType.split(";")[0]!.trim(),
        clen,
        dashRanges,
        expireSec: meta.expireSec,
        httpHeaders: {},
        tier: 1,
        resolvedBy: "innertube",
        isDrc: Boolean(fmt.is_drc),
        resolvedAt: Date.now(),
      };
      targetsByFid.set(formatId, target);
      if (!targetsByItag.has(itag) || !fmt.is_drc) {
        targetsByItag.set(itag, target);
      }
    }

    // Legacy muxed streams (e.g. itag 18) if present
    const formatStreams: Array<Record<string, unknown>> = [];
    for (const fmt of (info.streaming_data?.formats || []) as any[]) {
      if (!fmt?.url || !fmt?.width || !fmt?.height) continue;
      const itag = Number(fmt.itag) || 18;
      const mimeType = String(fmt.mime_type || 'video/mp4; codecs="avc1.42001E, mp4a.40.2"');
      const meta = extractUrlMeta(fmt.url, durationSec);
      const clen = Number(fmt.content_length) || meta.clen || 0;
      const formatId = String(itag);

      const proxyUrl = buildProxyPlaybackUrl({
        origin,
        videoId,
        formatId,
        itag,
        durSec: meta.durSec,
        expireSec: meta.expireSec,
        clen,
      });

      formatStreams.push({
        url: proxyUrl,
        itag: String(itag),
        type: mimeType,
        quality: String(fmt.quality || "medium"),
        bitrate: String(Number(fmt.bitrate) || 500_000),
        fps: Math.round(Number(fmt.fps) || 30),
        container: mimeType.includes("webm") ? "webm" : "mp4",
        encoding: "avc1",
        resolution: `${fmt.height}p`,
        qualityLabel: String(fmt.quality_label || `${fmt.height}p`),
        size: `${fmt.width}x${fmt.height}`,
      });

      const target: StreamTargetRemote = {
        kind: "remote",
        videoId,
        formatId,
        itag,
        url: String(fmt.url),
        mimeType: mimeType.split(";")[0]!.trim(),
        clen,
        expireSec: meta.expireSec,
        httpHeaders: {},
        tier: 1,
        resolvedBy: "innertube",
        isDrc: Boolean(fmt.is_drc),
        resolvedAt: Date.now(),
      };
      targetsByFid.set(formatId, target);
      targetsByItag.set(itag, target);
    }

    // Merge captions from basic_info + hints
    const captions: CaptionTrackRef[] = [...hints.captions];
    const seenCap = new Set(captions.map((c) => `${c.languageCode}:${c.label}`));
    for (const c of (info.captions?.caption_tracks || []) as any[]) {
      if (!c?.base_url) continue;
      const label = textOf(c.name) || String(c.language_code || "Unknown");
      const lang = String(c.language_code || "en");
      const key = `${lang}:${label}`;
      if (!seenCap.has(key)) {
        seenCap.add(key);
        captions.push({ label, languageCode: lang, url: String(c.base_url) });
      }
    }

    // Merge storyboards if hints didn't have them
    let storyboards = hints.storyboards;
    if (storyboards.length === 0 && Array.isArray(info.storyboards?.boards)) {
      storyboards = info.storyboards.boards.map((b: any) => ({
        template_url: String(b.template_url || ""),
        thumbnail_width: Number(b.thumbnail_width) || 160,
        thumbnail_height: Number(b.thumbnail_height) || 90,
        thumbnail_count: Number(b.thumbnail_count) || 0,
        interval: Number(b.interval) || 0,
        columns: Number(b.columns) || 5,
        rows: Number(b.rows) || 5,
      }));
    }

    const payload = this.assembleInvidiousVideoPayload({
      videoId,
      origin,
      title: String(basic.title || hints.title || ""),
      description: String(hints.description || basic.short_description || ""),
      durationSec,
      author: String(basic.author || hints.author || ""),
      authorId: String(basic.channel_id || hints.authorId || ""),
      viewCount: Number(basic.view_count ?? hints.viewCount ?? 0),
      likeCount: Number(basic.like_count ?? hints.likeCount ?? 0),
      published: hints.published ?? Math.floor(Date.now() / 1000),
      subCountText: hints.subCountText,
      genre: String(basic.category || hints.genre || ""),
      isFamilyFriendly: basic.is_family_safe !== false && hints.isFamilyFriendly,
      isListed: hints.isListed ?? !basic.is_unlisted,
      hints,
      adaptiveFormats,
      formatStreams,
      captions,
    });

    this.logger.info("Fast IPv4 InnerTube resolved video", {
      videoId,
      client: usedClient,
      adaptiveFormats: adaptiveFormats.length,
      elapsedMs: Date.now() - startMs,
    });

    return {
      videoId,
      tier: 1,
      resolvedBy: "innertube",
      resolvedAt: Date.now(),
      expiresAt: earliestExpireSec * 1000,
      payload,
      adaptiveFormats,
      durationSec,
      targetsByFid,
      targetsByItag,
      captions,
      storyboards,
    };
  }

  private async fetchInnertubeHints(videoId: string, origin: string): Promise<InnertubeMetaHints> {
    const empty: InnertubeMetaHints = {
      rangesByKey: new Map(),
      rangesByItag: new Map(),
      colorByItag: new Map(),
      projectionByItag: new Map(),
      authorThumbnails: [],
      subCountText: "",
      genre: "",
      isFamilyFriendly: true,
      recommendedVideos: [],
      storyboards: [],
      captions: [],
    };

    try {
      const client = await this.innertubeProvider.getClient();
      const info = await withTimeoutNull(client.getInfo(videoId), 6000);
      if (!info) return empty;

      let streaming = (info as any).streaming_data;
      if ((!streaming || !Array.isArray(streaming.adaptive_formats) || streaming.adaptive_formats.length === 0) && typeof (client as any).getBasicInfo === "function") {
        try {
          const basicAndroid: any = await withTimeoutNull(
            (client as any).getBasicInfo(videoId, { client: "ANDROID" }),
            3000,
          );
          if (basicAndroid?.streaming_data?.adaptive_formats?.length) {
            streaming = basicAndroid.streaming_data;
          }
        } catch {
          // Non-fatal
        }
      }
      if (streaming && Array.isArray(streaming.adaptive_formats)) {
        for (const fmt of streaming.adaptive_formats) {
          const itag = Number(fmt.itag);
          if (!itag) continue;

          if (fmt.init_range && fmt.index_range) {
            const initStart = Number(fmt.init_range.start);
            const initEnd = Number(fmt.init_range.end);
            const indexStart = Number(fmt.index_range.start);
            const indexEnd = Number(fmt.index_range.end);
            if (
              Number.isFinite(initStart) &&
              Number.isFinite(initEnd) &&
              Number.isFinite(indexStart) &&
              Number.isFinite(indexEnd)
            ) {
              const rangeObj: HintedRange = {
                init: `${initStart}-${initEnd}`,
                index: `${indexStart}-${indexEnd}`,
                initStart,
                initEnd,
                indexStart,
                indexEnd,
                clen: Number(fmt.content_length) || undefined,
                isDrc: Boolean(fmt.is_drc),
              };
              const key = makeRangeKey(itag, Boolean(fmt.is_drc), fmt.language);
              empty.rangesByKey.set(key, rangeObj);
              if (!empty.rangesByItag.has(itag) || !fmt.is_drc) {
                empty.rangesByItag.set(itag, rangeObj);
              }
            }
          }

          if (fmt.color_info) {
            empty.colorByItag.set(itag, {
              primaries: fmt.color_info.primaries,
              transferCharacteristics: fmt.color_info.transfer_characteristics,
              matrixCoefficients: fmt.color_info.matrix_coefficients,
            });
          }

          if (fmt.projection_type) {
            empty.projectionByItag.set(itag, String(fmt.projection_type));
          }
        }
      }

      const secondary = (info as any).secondary_info;
      const owner = secondary?.owner;
      if (owner?.author?.thumbnails) {
        empty.authorThumbnails = normalizeAuthorThumbnails(owner.author.thumbnails, origin);
      }
      if (owner?.subscriber_count) {
        empty.subCountText = textOf(owner.subscriber_count).replace(/\s*subscribers?$/i, "").trim();
      }

      const basic = (info as any).basic_info;
      const primary = (info as any).primary_info;
      if (basic?.category) empty.genre = String(basic.category);
      if (typeof basic?.is_family_safe === "boolean") {
        empty.isFamilyFriendly = basic.is_family_safe;
      }
      if (basic?.title) empty.title = String(basic.title);
      if (basic?.short_description) empty.description = String(basic.short_description);
      else if (secondary?.description) empty.description = textOf(secondary.description);
      if (basic?.author) empty.author = String(basic.author);
      if (basic?.channel_id) empty.authorId = String(basic.channel_id);
      if (typeof basic?.view_count === "number") empty.viewCount = basic.view_count;
      if (typeof basic?.like_count === "number") empty.likeCount = basic.like_count;
      if (typeof basic?.duration === "number") empty.durationSec = basic.duration;
      if (typeof basic?.is_unlisted === "boolean") empty.isListed = !basic.is_unlisted;
      if (primary?.published) {
        const pubText = textOf(primary.published);
        const parsedMs = Date.parse(pubText.replace(/^(Premiered|Streamed live on)\s+/i, ""));
        if (!Number.isNaN(parsedMs)) {
          empty.published = Math.floor(parsedMs / 1000);
        }
      }

      const watchNext: unknown[] = (info as any).watch_next_feed || [];
      for (const item of watchNext.slice(0, 20)) {
        const mapped = mapYoutubeiVideoNode(item, origin);
        if (mapped && mapped.videoId !== videoId) {
          empty.recommendedVideos.push({
            videoId: mapped.videoId,
            title: mapped.title,
            videoThumbnails: mapped.videoThumbnails,
            author: mapped.author,
            authorId: mapped.authorId,
            authorUrl: mapped.authorUrl,
            lengthSeconds: mapped.lengthSeconds,
            viewCountText: mapped.viewCountText,
            viewCount: mapped.viewCount,
          });
        }
      }

      const sb = (info as any).storyboards;
      if (sb?.boards && Array.isArray(sb.boards)) {
        empty.storyboards = sb.boards.map((b: any) => ({
          template_url: String(b.template_url || ""),
          thumbnail_width: Number(b.thumbnail_width) || 160,
          thumbnail_height: Number(b.thumbnail_height) || 90,
          thumbnail_count: Number(b.thumbnail_count) || 0,
          interval: Number(b.interval) || 0,
          columns: Number(b.columns) || 5,
          rows: Number(b.rows) || 5,
        }));
      }

      const captionTracks = (info as any).captions?.caption_tracks;
      if (Array.isArray(captionTracks)) {
        for (const c of captionTracks) {
          if (!c?.base_url) continue;
          empty.captions.push({
            label: textOf(c.name) || String(c.language_code || "Unknown"),
            languageCode: String(c.language_code || "en"),
            url: String(c.base_url),
          });
        }
      }
    } catch (err) {
      this.logger.debug("Anonymous InnerTube hints fetch skipped/failed (non-fatal)", {
        videoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return empty;
  }

  private async buildResolvedFromYtDlp(
    videoId: string,
    origin: string,
    ytInfo: YtDlpVideoInfo,
    hints: InnertubeMetaHints,
    tier: 1 | 2,
  ): Promise<ResolvedVideoRecord> {
    const durationSec = Math.max(1, Math.round(ytInfo.duration || 0));
    const allFormats = ytInfo.formats || [];
    const directDash = deduplicateYtDlpFormats(allFormats.filter(isDirectDashFormat));
    const directMuxed = deduplicateYtDlpFormats(allFormats.filter(isDirectMuxedFormat));

    const targetsByFid = new Map<string, StreamTarget>();
    const targetsByItag = new Map<number, StreamTarget>();
    const adaptiveFormats: AdaptiveFormatOutput[] = [];
    let earliestExpireSec = Math.floor(Date.now() / 1000) + 6 * 3600;

    // Resolve DASH init/index ranges: prefer InnerTube hints, probe container header over IPv4 for missing formats
    const rangeTasks = directDash.map(async (fmt) => {
      const itag = parseNumericItag(fmt.format_id, fmt.url);
      const isDrc = fmt.format_id.includes("drc") || (fmt.format_note || "").includes("DRC");
      const mimeType = buildMimeTypeFromYtDlp(fmt);

      const fmtMeta = extractUrlMeta(fmt.url, durationSec);
      const fmtClen = fmtMeta.clen || Number(fmt.filesize || 0);
      const exactHint = hints.rangesByKey.get(makeRangeKey(itag, isDrc, fmt.language));
      const itagHint = hints.rangesByItag.get(itag);
      const hintMatchesLayout = (h: HintedRange | undefined): h is HintedRange => {
        if (!h) return false;
        if (h.isDrc !== undefined && h.isDrc !== isDrc) return false;
        if (h.clen && fmtClen > 0 && h.clen !== fmtClen) return false;
        return true;
      };

      let ranges: DashByteRanges | null =
        (hintMatchesLayout(exactHint) ? exactHint : null) ||
        (!isDrc && !fmt.language && hintMatchesLayout(itagHint) ? itagHint : null);

      if (!ranges && fmt.url) {
        ranges = await this.probeSemaphore.run(async () => {
          try {
            return await probeRemoteDashRanges(fmt.url!, mimeType, this.fetchRaw, fmt.http_headers);
          } catch {
            return null;
          }
        });
      }

      return { fmt, itag, mimeType, ranges };
    });

    const probedFormats = await Promise.all(rangeTasks);

    for (const { fmt, itag, mimeType, ranges } of probedFormats) {
      if (!fmt.url || !ranges) continue;

      const meta = extractUrlMeta(fmt.url, durationSec);
      const exactClen = meta.clen || Number(fmt.filesize || 0);
      const approxSize = exactClen || Number(fmt.filesize_approx || 0);
      const dashRanges: DashRangeIdentity = { init: ranges.init, index: ranges.index };
      if (meta.expireSec < earliestExpireSec) {
        earliestExpireSec = meta.expireSec;
      }

      const proxyUrl = buildProxyPlaybackUrl({
        origin,
        videoId,
        formatId: fmt.format_id,
        itag,
        durSec: meta.durSec,
        expireSec: meta.expireSec,
        clen: exactClen,
        layout: formatDashLayoutKey(dashRanges),
        xtags: meta.xtags,
      });

      const isVideo = mimeType.startsWith("video/");
      const bitrateBps = Math.max(
        1000,
        Math.round((fmt.tbr || fmt.vbr || fmt.abr || (approxSize > 0 ? (approxSize * 8) / (durationSec * 1000) : 128)) * 1000),
      );
      const baseContainer = mimeType.includes("webm") ? "webm" : "mp4";
      const encoding = isVideo ? (fmt.vcodec || "") : (fmt.acodec || "");

      const out: AdaptiveFormatOutput = {
        index: ranges.index,
        init: ranges.init,
        bitrate: String(bitrateBps),
        url: proxyUrl,
        itag: String(itag),
        type: mimeType,
        clen: String(exactClen || approxSize),
        lmt: meta.lmt,
        projectionType: hints.projectionByItag.get(itag) || "RECTANGULAR",
        container: baseContainer,
        encoding,
      };

      if (isVideo) {
        const w = Number(fmt.width) || 0;
        const h = Number(fmt.height) || 0;
        const fps = Math.round(Number(fmt.fps) || 30);
        if (w <= 0 || h <= 0) continue;
        out.size = `${w}x${h}`;
        out.fps = fps;
        out.resolution = `${h}p`;
        out.qualityLabel = fps > 30 ? `${h}p${fps}` : `${h}p`;
        const colorInfo = hints.colorByItag.get(itag);
        if (colorInfo) out.colorInfo = colorInfo;
      } else {
        out.audioQuality = inferAudioQuality(fmt.abr || fmt.tbr, fmt.format_note);
        out.audioSampleRate = String(fmt.asr || 48000);
        out.audioChannels = Number(fmt.audio_channels) || 2;
      }

      adaptiveFormats.push(out);

      const target: StreamTargetRemote = {
        kind: "remote",
        videoId,
        formatId: fmt.format_id,
        itag,
        url: fmt.url,
        mimeType: mimeType.split(";")[0]!.trim(),
        clen: exactClen,
        approxSize: approxSize > 0 ? approxSize : undefined,
        dashRanges,
        expireSec: meta.expireSec,
        httpHeaders: fmt.http_headers || {},
        tier,
        resolvedBy: "ytdlp",
        ytDlpFormatId: fmt.format_id,
        isDrc: isYtDlpFormatDrc(fmt),
        resolvedAt: Date.now(),
      };
      targetsByFid.set(fmt.format_id, target);
      if (itag > 0 && (!targetsByItag.has(itag) || !fmt.format_id.includes("drc"))) {
        targetsByItag.set(itag, target);
      }
    }

    // Legacy muxed streams (e.g. itag 18)
    const formatStreams: Array<Record<string, unknown>> = [];
    for (const fmt of directMuxed) {
      if (!fmt.url || !fmt.width || !fmt.height) continue;
      const itag = parseNumericItag(fmt.format_id, fmt.url);
      const mimeType = buildMimeTypeFromYtDlp(fmt);
      const meta = extractUrlMeta(fmt.url, durationSec);
      const exactClen = meta.clen || Number(fmt.filesize || 0);
      const approxSize = exactClen || Number(fmt.filesize_approx || 0);
      const proxyUrl = buildProxyPlaybackUrl({
        origin,
        videoId,
        formatId: fmt.format_id,
        itag,
        durSec: meta.durSec,
        expireSec: meta.expireSec,
        clen: exactClen,
      });

      const fps = Math.round(Number(fmt.fps) || 30);
      formatStreams.push({
        url: proxyUrl,
        itag: String(itag),
        type: mimeType,
        quality: "medium",
        bitrate: String(Math.round((fmt.tbr || 500) * 1000)),
        fps,
        container: fmt.ext || "mp4",
        encoding: fmt.vcodec || "avc1",
        resolution: `${fmt.height}p`,
        qualityLabel: `${fmt.height}p`,
        size: `${fmt.width}x${fmt.height}`,
      });

      const target: StreamTargetRemote = {
        kind: "remote",
        videoId,
        formatId: fmt.format_id,
        itag,
        url: fmt.url,
        mimeType: mimeType.split(";")[0]!.trim(),
        clen: exactClen,
        approxSize: approxSize > 0 ? approxSize : undefined,
        expireSec: meta.expireSec,
        httpHeaders: fmt.http_headers || {},
        tier,
        resolvedBy: "ytdlp",
        ytDlpFormatId: fmt.format_id,
        isDrc: isYtDlpFormatDrc(fmt),
        resolvedAt: Date.now(),
      };
      targetsByFid.set(fmt.format_id, target);
      if (itag > 0) targetsByItag.set(itag, target);
    }

    // Captions: merge yt-dlp subtitles with InnerTube captions
    const captions = this.collectCaptions(ytInfo, hints);

    const payload = this.assembleInvidiousVideoPayload({
      videoId,
      origin,
      title: ytInfo.title || "",
      description: ytInfo.description || "",
      durationSec,
      author: ytInfo.channel || ytInfo.uploader || "",
      authorId: ytInfo.channel_id || "",
      viewCount: Number(ytInfo.view_count) || 0,
      likeCount: Number(ytInfo.like_count) || 0,
      published: parseUploadDateToUnixSec(ytInfo.upload_date, ytInfo.timestamp),
      subCountText:
        hints.subCountText ||
        (ytInfo.channel_follower_count ? formatCompactCount(ytInfo.channel_follower_count) : ""),
      genre: ytInfo.categories?.[0] || hints.genre || "",
      isFamilyFriendly: (ytInfo.age_limit ?? 0) < 18 && hints.isFamilyFriendly,
      isListed: ytInfo.availability !== "unlisted",
      hints,
      adaptiveFormats,
      formatStreams,
      captions,
    });

    return {
      videoId,
      tier,
      resolvedBy: "ytdlp",
      resolvedAt: Date.now(),
      expiresAt: earliestExpireSec * 1000,
      payload,
      adaptiveFormats,
      durationSec,
      targetsByFid,
      targetsByItag,
      captions,
      storyboards: hints.storyboards,
    };
  }

  private async buildResolvedFromEphemeralBuffer(
    videoId: string,
    origin: string,
    hints: InnertubeMetaHints,
  ): Promise<ResolvedVideoRecord> {
    const maxH = this.config.playback.ephemeralBuffer.maxFormatHeight;
    const useAuth = this.config.playback.authFallback.enabled;

    // Fetch metadata if possible (or fall back to basic metadata)
    let ytInfo: YtDlpVideoInfo | null = null;
    try {
      ytInfo = await this.ytDlp.extractVideoInfo(videoId, { useAuth });
    } catch {
      try {
        if (useAuth) ytInfo = await this.ytDlp.extractVideoInfo(videoId, { useAuth: false });
      } catch {
        ytInfo = null;
      }
    }

    const durationSec = Math.max(1, Math.round(ytInfo?.duration || 60));
    const expireSec = Math.floor(Date.now() / 1000) + this.config.playback.ephemeralBuffer.ttlSeconds;

    const maxCacheBytes = this.config.playback.ephemeralBuffer.maxCacheBytes;
    const { video: matchedVideoFmt, audio: matchedAudioFmt } = selectColdTier3Formats(
      ytInfo?.formats || [],
      maxH,
    );

    // Key cold Tier 3 cache files by selected format_id so cached tracks are NEVER
    // reused under a different codec/resolution/container representation.
    const videoFid = matchedVideoFmt ? `tier3-v-${matchedVideoFmt.format_id}` : "tier3-video";
    const audioFid = matchedAudioFmt ? `tier3-a-${matchedAudioFmt.format_id}` : "tier3-audio";
    const videoPath = this.ephemeralStore.getPathFor(videoId, videoFid, "mp4");
    const audioPath = this.ephemeralStore.getPathFor(videoId, audioFid, "m4a");

    const videoPin = this.ephemeralStore.makeKey(videoId, videoFid);
    const audioPin = this.ephemeralStore.makeKey(videoId, audioFid);

    const expectedVideoBytes = matchedVideoFmt ? getYtDlpFormatApproxSize(matchedVideoFmt) : 0;
    const expectedAudioBytes = matchedAudioFmt ? getYtDlpFormatApproxSize(matchedAudioFmt) : 0;
    if (
      expectedVideoBytes > 0 &&
      expectedAudioBytes > 0 &&
      expectedVideoBytes + expectedAudioBytes > maxCacheBytes
    ) {
      throw new Error(
        `Tier 3 combined tracks exceed maxCacheBytes (${expectedVideoBytes + expectedAudioBytes} > ${maxCacheBytes})`,
      );
    }

    return await this.tier3Semaphore.run(async () => {
      if (this.stopped) {
        throw new Error("Server shutting down");
      }
      this.ephemeralStore.pin(videoPin);
      this.ephemeralStore.pin(audioPin);

      let downloadedVideo = false;
      let downloadedAudio = false;
      try {
        // Download the exact selected format_id so advertised codec/resolution/fps match the file 1:1.
        // When ytInfo is unavailable, prefer H.264/AAC MP4/M4A for universal MSE + global_sidx compatibility.
        const videoSelector = matchedVideoFmt
          ? matchedVideoFmt.format_id
          : `bestvideo[height<=${maxH}][ext=mp4][vcodec^=avc1]/bestvideo[height<=${maxH}][ext=mp4]/bestvideo[height<=${maxH}]/bestvideo`;
        const audioSelector = matchedAudioFmt
          ? matchedAudioFmt.format_id
          : `bestaudio[ext=m4a][acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio`;

        if (!this.ephemeralStore.get(videoId, videoFid)) {
          const videoBudget = this.ephemeralStore.getAvailableBudgetFor(videoPin);
          if (expectedVideoBytes > 0) {
            if (!this.ephemeralStore.reserveBytes(videoPin, expectedVideoBytes)) {
              throw new Error(
                `Tier 3 video track exceeds available ephemeral disk budget (${expectedVideoBytes} > ${maxCacheBytes})`,
              );
            }
          } else if (videoBudget <= 0) {
            throw new Error("Insufficient ephemeral disk budget for Tier 3 video track");
          }
          await this.downloadWithAuthFallback(videoId, videoSelector, videoPath, {
            maxBytes: Math.min(maxCacheBytes, videoBudget),
            onStagingBytes: (bytes) => this.ephemeralStore.reserveBytes(videoPin, bytes),
          });
          downloadedVideo = true;
        }
        const finalVideoPath = await this.ensureDashIndexedFile(videoPath, "video/mp4", videoPin);
        const videoSize = fs.statSync(finalVideoPath).size;
        this.ephemeralStore.releaseReservation(videoPin);
        if (videoSize > maxCacheBytes || videoSize > this.ephemeralStore.getAvailableBudgetFor(videoPin)) {
          throw new Error(
            `Tier 3 video track exceeds maxCacheBytes (${videoSize} > ${maxCacheBytes})`,
          );
        }
        const videoEntry = this.ephemeralStore.register(videoId, videoFid, finalVideoPath, "video/mp4");

        if (!this.ephemeralStore.get(videoId, audioFid)) {
          const audioBudget = this.ephemeralStore.getAvailableBudgetFor(audioPin);
          if (expectedAudioBytes > 0) {
            if (!this.ephemeralStore.reserveBytes(audioPin, expectedAudioBytes)) {
              throw new Error(
                `Tier 3 audio track exceeds available ephemeral disk budget (${expectedAudioBytes} > ${maxCacheBytes})`,
              );
            }
          } else if (audioBudget <= 0) {
            throw new Error("Insufficient ephemeral disk budget for Tier 3 audio track");
          }
          await this.downloadWithAuthFallback(videoId, audioSelector, audioPath, {
            maxBytes: Math.min(maxCacheBytes, audioBudget),
            onStagingBytes: (bytes) => this.ephemeralStore.reserveBytes(audioPin, bytes),
          });
          downloadedAudio = true;
        }
        const finalAudioPath = await this.ensureDashIndexedFile(audioPath, "audio/mp4", audioPin);
        const audioSize = fs.statSync(finalAudioPath).size;
        this.ephemeralStore.releaseReservation(audioPin);
        if (
          videoEntry.size + audioSize > maxCacheBytes ||
          audioSize > this.ephemeralStore.getAvailableBudgetFor(audioPin)
        ) {
          throw new Error(
            `Tier 3 combined tracks exceed maxCacheBytes (${videoEntry.size + audioSize} > ${maxCacheBytes})`,
          );
        }
        const audioEntry = this.ephemeralStore.register(videoId, audioFid, finalAudioPath, "audio/mp4");

        const videoRanges = hasValidGlobalMp4Sidx(finalVideoPath)
          ? probeLocalFileDashRanges(finalVideoPath, "video/mp4")
          : null;
        const audioRanges = hasValidGlobalMp4Sidx(finalAudioPath)
          ? probeLocalFileDashRanges(finalAudioPath, "audio/mp4")
          : null;

        if (!videoRanges || !audioRanges) {
          throw new Error(
            `Tier 3 downloaded tracks lack valid global DASH index ranges (video=${Boolean(videoRanges)}, audio=${Boolean(audioRanges)})`,
          );
        }

        const targetsByFid = new Map<string, StreamTarget>();
        const targetsByItag = new Map<number, StreamTarget>();
        const adaptiveFormats: AdaptiveFormatOutput[] = [];

        const vItag = matchedVideoFmt
          ? parseNumericItag(matchedVideoFmt.format_id, matchedVideoFmt.url) || 137
          : 137;
        const aItag = matchedAudioFmt
          ? parseNumericItag(matchedAudioFmt.format_id, matchedAudioFmt.url) || 140
          : 140;

        const vWidth = Number(matchedVideoFmt?.width || ytInfo?.width) || 1280;
        const vHeight = Math.min(Number(matchedVideoFmt?.height || ytInfo?.height) || 720, maxH);
        const vFps = Math.round(Number(matchedVideoFmt?.fps || ytInfo?.fps) || 30);
        const vCodec = matchedVideoFmt?.vcodec || "avc1.640028";
        const aCodec = matchedAudioFmt?.acodec || "mp4a.40.2";

        const videoDashRanges: DashRangeIdentity = {
          init: videoRanges.init,
          index: videoRanges.index,
        };
        const videoTarget: StreamTargetLocal = {
          kind: "local",
          videoId,
          formatId: videoFid,
          itag: vItag,
          filePath: finalVideoPath,
          mimeType: "video/mp4",
          size: videoEntry.size,
          dashRanges: videoDashRanges,
          tier: 3,
        };
        targetsByFid.set(videoFid, videoTarget);
        targetsByItag.set(vItag, videoTarget);

        adaptiveFormats.push({
          index: videoRanges.index,
          init: videoRanges.init,
          bitrate: String(Math.max(100_000, Math.round((videoEntry.size * 8) / durationSec))),
          url: buildProxyPlaybackUrl({
            origin,
            videoId,
            formatId: videoFid,
            itag: vItag,
            durSec: durationSec,
            expireSec,
            clen: videoEntry.size,
            layout: formatDashLayoutKey(videoDashRanges),
          }),
          itag: String(vItag),
          type: `video/mp4; codecs="${vCodec}"`,
          clen: String(videoEntry.size),
          lmt: "0",
          projectionType: "RECTANGULAR",
          container: "mp4",
          encoding: vCodec,
          size: `${vWidth}x${vHeight}`,
          fps: vFps,
          resolution: `${vHeight}p`,
          qualityLabel: vFps > 30 ? `${vHeight}p${vFps}` : `${vHeight}p`,
        });

        const audioDashRanges: DashRangeIdentity = {
          init: audioRanges.init,
          index: audioRanges.index,
        };
        const audioTarget: StreamTargetLocal = {
          kind: "local",
          videoId,
          formatId: audioFid,
          itag: aItag,
          filePath: finalAudioPath,
          mimeType: "audio/mp4",
          size: audioEntry.size,
          dashRanges: audioDashRanges,
          tier: 3,
        };
        targetsByFid.set(audioFid, audioTarget);
        targetsByItag.set(aItag, audioTarget);

        adaptiveFormats.push({
          index: audioRanges.index,
          init: audioRanges.init,
          bitrate: String(Math.max(32_000, Math.round((audioEntry.size * 8) / durationSec))),
          url: buildProxyPlaybackUrl({
            origin,
            videoId,
            formatId: audioFid,
            itag: aItag,
            durSec: durationSec,
            expireSec,
            clen: audioEntry.size,
            layout: formatDashLayoutKey(audioDashRanges),
          }),
          itag: String(aItag),
          type: `audio/mp4; codecs="${aCodec}"`,
          clen: String(audioEntry.size),
          lmt: "0",
          projectionType: "RECTANGULAR",
          container: "mp4",
          encoding: aCodec,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
          audioSampleRate: String(matchedAudioFmt?.asr || 44100),
          audioChannels: Number(matchedAudioFmt?.audio_channels) || 2,
        });

        const captions = ytInfo ? this.collectCaptions(ytInfo, hints) : hints.captions;
        const payload = this.assembleInvidiousVideoPayload({
          videoId,
          origin,
          title: ytInfo?.title || videoId,
          description: ytInfo?.description || "",
          durationSec,
          author: ytInfo?.channel || ytInfo?.uploader || "",
          authorId: ytInfo?.channel_id || "",
          viewCount: Number(ytInfo?.view_count) || 0,
          likeCount: Number(ytInfo?.like_count) || 0,
          published: parseUploadDateToUnixSec(ytInfo?.upload_date, ytInfo?.timestamp),
          subCountText:
            hints.subCountText ||
            (ytInfo?.channel_follower_count ? formatCompactCount(ytInfo.channel_follower_count) : ""),
          genre: ytInfo?.categories?.[0] || hints.genre || "",
          isFamilyFriendly: (ytInfo?.age_limit ?? 0) < 18 && hints.isFamilyFriendly,
          isListed: ytInfo?.availability !== "unlisted",
          hints,
          adaptiveFormats,
          formatStreams: [],
          captions,
        });

        return {
          videoId,
          tier: 3,
          resolvedBy: "ephemeral",
          resolvedAt: Date.now(),
          expiresAt: expireSec * 1000,
          payload,
          adaptiveFormats,
          durationSec,
          targetsByFid,
          targetsByItag,
          captions,
          storyboards: hints.storyboards,
        };
      } catch (err) {
        // Clean up untracked files if one download failed mid-way
        if (downloadedVideo && !this.ephemeralStore.get(videoId, videoFid) && fs.existsSync(videoPath)) {
          try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
        }
        if (downloadedAudio && !this.ephemeralStore.get(videoId, audioFid) && fs.existsSync(audioPath)) {
          try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
        }
        throw err;
      } finally {
        this.ephemeralStore.releaseReservation(videoPin);
        this.ephemeralStore.releaseReservation(audioPin);
        this.ephemeralStore.unpin(videoPin);
        this.ephemeralStore.unpin(audioPin);
      }
    });
  }

  private async downloadWithAuthFallback(
    videoId: string,
    selector: string,
    outputPath: string,
    limits?: { maxBytes?: number; onStagingBytes?: (bytes: number) => boolean },
  ): Promise<void> {
    if (this.stopped) throw new Error("Server shutting down");
    try {
      await this.ytDlp.downloadFormat(videoId, selector, outputPath, {
        useAuth: false,
        maxBytes: limits?.maxBytes,
        onStagingBytes: limits?.onStagingBytes,
      });
    } catch (err) {
      const isBudgetErr = err instanceof Error && err.name === "BudgetExceededError";
      if (!this.stopped && !isBudgetErr && this.config.playback.authFallback.enabled) {
        await this.ytDlp.downloadFormat(videoId, selector, outputPath, {
          useAuth: true,
          maxBytes: limits?.maxBytes,
          onStagingBytes: limits?.onStagingBytes,
        });
      } else {
        throw err;
      }
    }
  }

  private async ensureDashIndexedFile(
    filePath: string,
    mimeType: string,
    reserveKey?: string,
  ): Promise<string> {
    if (mimeType.includes("webm")) {
      return filePath;
    }
    // For MP4/M4A, require a SINGLE global sidx covering all fragments (not per-fragment sidx)
    if (hasValidGlobalMp4Sidx(filePath) && probeLocalFileDashRanges(filePath, mimeType)) {
      return filePath;
    }
    const ffmpeg = this.config.binaries.ffmpeg;
    if (!ffmpeg || this.stopped) return filePath;

    const remuxReserveKey = reserveKey ? `${reserveKey}:remux` : null;
    if (remuxReserveKey) {
      const inputSize = fs.statSync(filePath).size;
      if (!this.ephemeralStore.reserveBytes(remuxReserveKey, inputSize)) {
        throw new Error(`Insufficient ephemeral disk budget to remux ${filePath}`);
      }
    }

    const remuxPath = `${filePath}.dash.mp4`;
    let code = -1;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let trackedRemux: { killSync: () => void; exited: Promise<unknown> } | null = null;

    try {
      if (this.stopped) {
        throw new Error("Server shutting down");
      }
      const proc = Bun.spawn(
        [
          ffmpeg,
          "-y",
          "-i",
          filePath,
          "-c",
          "copy",
          "-movflags",
          "+dash+global_sidx+frag_keyframe+empty_moov+default_base_moof",
          "-f",
          "mp4",
          remuxPath,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );

      trackedRemux = {
        killSync: () => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already exited
          }
          try {
            if (fs.existsSync(remuxPath)) fs.unlinkSync(remuxPath);
          } catch {
            // Ignore
          }
        },
        exited: proc.exited.catch(() => {}),
      };
      this.activeRemuxProcs.add(trackedRemux);

      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }, 60_000);

      const stderrPromise = new Response(proc.stderr).text().catch(() => "");
      code = await proc.exited;
      await withTimeoutNull(stderrPromise, timedOut ? 100 : 500);
    } finally {
      if (timer) clearTimeout(timer);
      if (trackedRemux) {
        this.activeRemuxProcs.delete(trackedRemux);
      }
      if (remuxReserveKey) {
        this.ephemeralStore.releaseReservation(remuxReserveKey);
      }
    }

    if (
      !this.stopped &&
      !timedOut &&
      code === 0 &&
      fs.existsSync(remuxPath) &&
      hasValidGlobalMp4Sidx(remuxPath) &&
      probeLocalFileDashRanges(remuxPath, "video/mp4")
    ) {
      fs.renameSync(remuxPath, filePath);
      return filePath;
    }
    try {
      if (fs.existsSync(remuxPath)) fs.unlinkSync(remuxPath);
    } catch {
      // Ignore
    }
    return filePath;
  }

  private collectCaptions(ytInfo: YtDlpVideoInfo, hints: InnertubeMetaHints): CaptionTrackRef[] {
    const out: CaptionTrackRef[] = [];
    const seen = new Set<string>();

    const addFromMap = (map: Record<string, Array<{ ext?: string; url?: string; name?: string }>> | undefined, isAuto: boolean) => {
      if (!map) return;
      for (const [lang, tracks] of Object.entries(map)) {
        if (!Array.isArray(tracks)) continue;
        const vtt = tracks.find((t) => t.ext === "vtt" && t.url) || tracks.find((t) => t.url);
        if (!vtt?.url) continue;
        const label = vtt.name || (isAuto ? `${lang} (auto-generated)` : lang);
        const key = `${lang}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label, languageCode: lang, url: vtt.url });
      }
    };

    // Prefer manual subtitles first, then InnerTube tracks
    addFromMap(ytInfo.subtitles, false);
    for (const c of hints.captions) {
      const key = `${c.languageCode}:${c.label}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
    // Limit auto-generated captions to common original/English tracks if none present
    if (out.length === 0 && ytInfo.automatic_captions) {
      const subset: Record<string, Array<{ ext?: string; url?: string; name?: string }>> = {};
      for (const lang of ["en", "en-orig", "de", "es", "fr", "ja"]) {
        if (ytInfo.automatic_captions[lang]) {
          subset[lang] = ytInfo.automatic_captions[lang]!;
        }
      }
      addFromMap(subset, true);
    }

    return out;
  }

  private assembleInvidiousVideoPayload(input: {
    videoId: string;
    origin: string;
    title: string;
    description: string;
    durationSec: number;
    author: string;
    authorId: string;
    viewCount: number;
    likeCount: number;
    published: number;
    subCountText: string;
    genre: string;
    isFamilyFriendly: boolean;
    isListed: boolean;
    hints: InnertubeMetaHints;
    adaptiveFormats: AdaptiveFormatOutput[];
    formatStreams: Array<Record<string, unknown>>;
    captions: CaptionTrackRef[];
  }): Record<string, unknown> {
    const authorThumbnails =
      input.hints.authorThumbnails.length >= 4
        ? input.hints.authorThumbnails
        : normalizeAuthorThumbnails([], input.origin);

    return {
      type: "video",
      title: input.title,
      videoId: input.videoId,
      videoThumbnails: buildVideoThumbnails(input.videoId, input.origin),
      storyboards: [],
      description: input.description,
      descriptionHtml: descriptionToHtml(input.description),
      published: input.published,
      publishedText: "",
      keywords: [],
      viewCount: input.viewCount,
      likeCount: input.likeCount,
      dislikeCount: 0,
      paid: false,
      premium: false,
      isFamilyFriendly: input.isFamilyFriendly,
      allowedRegions: [],
      genre: input.genre,
      genreUrl: "",
      author: input.author,
      authorId: input.authorId,
      authorUrl: input.authorId ? `/channel/${input.authorId}` : "",
      authorVerified: false,
      authorThumbnails,
      subCountText: input.subCountText,
      lengthSeconds: input.durationSec,
      allowRatings: true,
      rating: 0,
      isListed: input.isListed,
      liveNow: false,
      isPostLiveDvr: false,
      isUpcoming: false,
      dashUrl: `${input.origin}/api/manifest/dash/id/${encodeURIComponent(input.videoId)}`,
      adaptiveFormats: input.adaptiveFormats,
      formatStreams: input.formatStreams,
      captions: input.captions.map((c) => ({
        label: c.label,
        language_code: c.languageCode,
        url: `/api/v1/captions/${encodeURIComponent(input.videoId)}?label=${encodeURIComponent(c.label)}&lang=${encodeURIComponent(c.languageCode)}`,
      })),
      recommendedVideos: input.hints.recommendedVideos,
    };
  }
}

import fs from "node:fs";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { Semaphore, TtlLruCache } from "../cache/memory-cache.ts";
import type { EphemeralStore } from "../cache/ephemeral-store.ts";
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
  probeLocalFileDashRanges,
  probeRemoteDashRanges,
} from "./container-probe.ts";
import {
  YtDlpError,
  type YtDlpFormat,
  type YtDlpRunner,
  type YtDlpVideoInfo,
} from "./ytdlp.ts";

export type PlaybackTier = 1 | 2 | 3;

export interface StreamTargetRemote {
  kind: "remote";
  videoId: string;
  formatId: string;
  itag: number;
  url: string;
  mimeType: string;
  clen: number;
  expireSec: number;
  httpHeaders: Record<string, string>;
  tier: 1 | 2;
}

export interface StreamTargetLocal {
  kind: "local";
  videoId: string;
  formatId: string;
  itag: number;
  filePath: string;
  mimeType: string;
  size: number;
  tier: 3;
}

export type StreamTarget = StreamTargetRemote | StreamTargetLocal;

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

interface InnertubeMetaHints {
  rangesByKey: Map<string, DashByteRanges>;
  rangesByItag: Map<number, DashByteRanges>;
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

export class VideoResolver {
  private readonly cache: TtlLruCache<string, ResolvedVideoRecord>;
  private readonly recoveryInflight = new Map<string, Promise<StreamTarget | null>>();
  private readonly videoRefreshInflight = new Map<string, Promise<ResolvedVideoRecord>>();
  private readonly probeSemaphore = new Semaphore(6);
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

  getCached(videoId: string): ResolvedVideoRecord | undefined {
    return this.cache.get(videoId);
  }

  getStreamTarget(videoId: string, formatId: string | null, itag: number | null): StreamTarget | null {
    const rec = this.cache.get(videoId);
    if (!rec) return null;
    if (formatId) {
      const exact = rec.targetsByFid.get(formatId);
      if (exact) return exact;
    }
    if (itag && itag > 0) {
      const byItag = rec.targetsByItag.get(itag);
      if (byItag) return byItag;
    }
    return null;
  }

  async resolveVideo(
    videoId: string,
    origin: string,
    options: { forceRefresh?: boolean; minTier?: PlaybackTier; skipFastInnertube?: boolean } = {},
  ): Promise<ResolvedVideoRecord> {
    this.metrics.totalRequests++;
    const minTier = options.minTier ?? 1;

    if (!options.forceRefresh && minTier === 1) {
      const cached = this.cache.get(videoId);
      if (cached && Date.now() < cached.expiresAt - 60_000) {
        return cached;
      }
    }

    const cacheKey = options.forceRefresh || minTier > 1 ? `${videoId}:t${minTier}:${Date.now()}` : videoId;
    const record = await this.cache.getOrCompute(cacheKey, async () => {
      const resolved = await this.executeEscalationLadder(
        videoId,
        origin,
        minTier,
        Boolean(options.skipFastInnertube),
      );
      const ttlMs = Math.max(
        60_000,
        Math.min(this.config.playback.videoCacheTtlSec * 1000, resolved.expiresAt - Date.now()),
      );
      return { value: resolved, ttlMs, cache: cacheKey === videoId };
    });

    if (cacheKey !== videoId) {
      const ttlMs = Math.max(
        60_000,
        Math.min(this.config.playback.videoCacheTtlSec * 1000, record.expiresAt - Date.now()),
      );
      this.cache.set(videoId, record, ttlMs);
    }

    return record;
  }

  /**
   * Called by `/videoplayback` when an upstream `googlevideo.com` URL fails
   * mid-playback (403, 410, 429, 5xx, stall). Escalates silently:
   *   Tier 1 -> Tier 1 refresh (if stale) or Tier 2 (Firefox cookies) -> Tier 3 (local disk buffer).
   */
  async recoverFormatMidPlayback(
    videoId: string,
    formatId: string,
    itag: number,
    origin: string,
    failedTarget: StreamTargetRemote,
  ): Promise<StreamTarget | null> {
    const inflightKey = `${videoId}:${formatId || itag}`;
    const existing = this.recoveryInflight.get(inflightKey);
    if (existing) return existing;

    const promise = (async (): Promise<StreamTarget | null> => {
      this.metrics.midPlaybackRecoveries++;
      this.logger.warn("Mid-playback upstream failure; attempting silent recovery", {
        videoId,
        formatId,
        itag,
        currentTier: failedTarget.tier,
      });

      const currentRec = this.cache.get(videoId);
      const ageMs = currentRec ? Date.now() - currentRec.resolvedAt : Infinity;

      // Step 1: If Tier 1 and entry was cached for > 20s (or came from fast InnerTube), try yt-dlp Tier 1 refresh once (single-flight per videoId!)
      if (failedTarget.tier === 1 && (ageMs > 20_000 || currentRec?.resolvedBy === "innertube")) {
        try {
          const fresh = await this.singleFlightRefresh(videoId, 1, () =>
            this.resolveVideo(videoId, origin, {
              forceRefresh: true,
              minTier: 1,
              skipFastInnertube: true,
            }),
          );
          const nextTarget = fresh.targetsByFid.get(formatId) || fresh.targetsByItag.get(itag);
          if (nextTarget && (nextTarget.kind === "local" || nextTarget.url !== failedTarget.url)) {
            this.logger.info("Mid-playback recovery succeeded via Tier 1 yt-dlp refresh", { videoId, formatId });
            return nextTarget;
          }
        } catch (err) {
          this.logger.warn("Tier 1 refresh failed during mid-playback recovery", {
            videoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Step 2: Escalate silently to Tier 2 (Firefox cookies) if configured and not already Tier 2
      if (failedTarget.tier < 2 && this.config.playback.authFallback.enabled) {
        try {
          const tier2Rec = await this.singleFlightRefresh(videoId, 2, () =>
            this.resolveVideo(videoId, origin, { forceRefresh: true, minTier: 2 }),
          );
          const nextTarget = tier2Rec.targetsByFid.get(formatId) || tier2Rec.targetsByItag.get(itag);
          if (nextTarget) {
            this.logger.info("Mid-playback recovery escalated to Tier 2", { videoId, formatId });
            return nextTarget;
          }
        } catch (err) {
          this.logger.warn("Tier 2 escalation failed during mid-playback recovery", {
            videoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Step 3: Escalate silently to Tier 3 (download exact formatId into ephemeral disk buffer)
      if (this.config.playback.ephemeralBuffer.enabled) {
        const selector = formatId || String(itag);
        const existingLocal = this.ephemeralStore.get(videoId, selector);
        if (existingLocal) {
          return this.promoteToLocalTarget(videoId, selector, itag, existingLocal.filePath, existingLocal.mimeType);
        }

        const ext = failedTarget.mimeType.includes("webm")
          ? "webm"
          : failedTarget.mimeType.startsWith("audio/")
            ? "m4a"
            : "mp4";
        const outPath = this.ephemeralStore.getPathFor(videoId, selector, ext);
        const pinKey = this.ephemeralStore.makeKey(videoId, selector);
        this.ephemeralStore.pin(pinKey);

        try {
          const useAuth = failedTarget.tier === 2 && this.config.playback.authFallback.enabled;
          try {
            await this.ytDlp.downloadFormat(videoId, selector, outPath, { useAuth });
          } catch (firstErr) {
            if (!useAuth && this.config.playback.authFallback.enabled) {
              await this.ytDlp.downloadFormat(videoId, selector, outPath, { useAuth: true });
            } else {
              throw firstErr;
            }
          }

          this.ephemeralStore.register(videoId, selector, outPath, failedTarget.mimeType);
          const localTarget = this.promoteToLocalTarget(
            videoId,
            selector,
            itag,
            outPath,
            failedTarget.mimeType,
          );
          this.metrics.tier3Hits++;
          this.logger.info("Mid-playback recovery escalated to Tier 3 ephemeral buffer", {
            videoId,
            formatId: selector,
          });
          return localTarget;
        } catch (err) {
          this.logger.error("Tier 3 mid-playback buffer failed", {
            videoId,
            formatId: selector,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.ephemeralStore.unpin(pinKey);
        }
      }

      return null;
    })();

    this.recoveryInflight.set(inflightKey, promise);
    try {
      return await promise;
    } finally {
      this.recoveryInflight.delete(inflightKey);
    }
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
  ): Promise<ResolvedVideoRecord> {
    const key = `${videoId}:t${tier}`;
    const existing = this.videoRefreshInflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => {
      this.videoRefreshInflight.delete(key);
    });
    this.videoRefreshInflight.set(key, p);
    return p;
  }

  private promoteToLocalTarget(
    videoId: string,
    formatId: string,
    itag: number,
    filePath: string,
    mimeType: string,
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
      tier: 3,
    };
    const rec = this.cache.get(videoId);
    if (rec) {
      rec.targetsByFid.set(formatId, localTarget);
      if (itag > 0) rec.targetsByItag.set(itag, localTarget);
    }
    return localTarget;
  }

  private async executeEscalationLadder(
    videoId: string,
    origin: string,
    minTier: PlaybackTier,
    skipFastInnertube = false,
  ): Promise<ResolvedVideoRecord> {
    // Launch anonymous IPv4 InnerTube metadata lookup in parallel (non-fatal, capped to 6s)
    const hintsPromise = this.fetchInnertubeHints(videoId, origin);

    let lastError: unknown = null;

    // ─── TIER 1a: Fast Anonymous IPv4 InnerTube (ANDROID_VR / IOS) ─────────────
    // Direct non-SABR 1080p/4K DASH streams with YouTube's exact init/index ranges in ~200ms!
    if (minTier <= 1 && !skipFastInnertube) {
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
    if (minTier <= 1) {
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
    if (minTier <= 2 && this.config.playback.authFallback.enabled) {
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
    if (this.config.playback.ephemeralBuffer.enabled) {
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
        const candidate: any = await Promise.race([
          client.getBasicInfo(videoId, { client: clientName }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
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

      const proxyUrl = buildProxyPlaybackUrl({
        origin,
        videoId,
        formatId,
        itag,
        durSec: meta.durSec,
        expireSec: meta.expireSec,
        clen,
        xtags: meta.xtags || (typeof fmt.xtags === "string" ? fmt.xtags : null),
      });

      const isVideo = mimeType.startsWith("video/");
      const baseContainer = mimeType.includes("webm") ? "webm" : "mp4";
      const codecMatch = /codecs="([^"]+)"/.exec(mimeType);
      const encoding = codecMatch ? codecMatch[1]! : "";
      const initStr = `${fmt.init_range.start}-${fmt.init_range.end}`;
      const indexStr = `${fmt.index_range.start}-${fmt.index_range.end}`;

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
        expireSec: meta.expireSec,
        httpHeaders: {},
        tier: 1,
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
      const info = await Promise.race([
        client.getInfo(videoId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      if (!info) return empty;

      let streaming = (info as any).streaming_data;
      if ((!streaming || !Array.isArray(streaming.adaptive_formats) || streaming.adaptive_formats.length === 0) && typeof (client as any).getBasicInfo === "function") {
        try {
          const basicAndroid: any = await Promise.race([
            (client as any).getBasicInfo(videoId, { client: "ANDROID" }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
          ]);
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
              const rangeObj: DashByteRanges = {
                init: `${initStart}-${initEnd}`,
                index: `${indexStart}-${indexEnd}`,
                initStart,
                initEnd,
                indexStart,
                indexEnd,
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
    const directDash = allFormats.filter(isDirectDashFormat);
    const directMuxed = allFormats.filter(isDirectMuxedFormat);

    const targetsByFid = new Map<string, StreamTarget>();
    const targetsByItag = new Map<number, StreamTarget>();
    const adaptiveFormats: AdaptiveFormatOutput[] = [];
    let earliestExpireSec = Math.floor(Date.now() / 1000) + 6 * 3600;

    // Resolve DASH init/index ranges: prefer InnerTube hints, probe container header over IPv4 for missing formats
    const rangeTasks = directDash.map(async (fmt) => {
      const itag = parseNumericItag(fmt.format_id, fmt.url);
      const isDrc = fmt.format_id.includes("drc") || (fmt.format_note || "").includes("DRC");
      const mimeType = buildMimeTypeFromYtDlp(fmt);

      let ranges: DashByteRanges | null =
        hints.rangesByKey.get(makeRangeKey(itag, isDrc, fmt.language)) ||
        hints.rangesByItag.get(itag) ||
        null;

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
      const clen = meta.clen || Number(fmt.filesize || fmt.filesize_approx || 0);
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
        clen,
        xtags: meta.xtags,
      });

      const isVideo = mimeType.startsWith("video/");
      const bitrateBps = Math.max(
        1000,
        Math.round((fmt.tbr || fmt.vbr || fmt.abr || (clen > 0 ? (clen * 8) / (durationSec * 1000) : 128)) * 1000),
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
        clen: String(clen),
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
        clen,
        expireSec: meta.expireSec,
        httpHeaders: fmt.http_headers || {},
        tier,
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
      const clen = meta.clen || Number(fmt.filesize || fmt.filesize_approx || 0);
      const proxyUrl = buildProxyPlaybackUrl({
        origin,
        videoId,
        formatId: fmt.format_id,
        itag,
        durSec: meta.durSec,
        expireSec: meta.expireSec,
        clen,
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
        clen,
        expireSec: meta.expireSec,
        httpHeaders: fmt.http_headers || {},
        tier,
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

    const videoFid = "tier3-video";
    const audioFid = "tier3-audio";
    const videoPath = this.ephemeralStore.getPathFor(videoId, videoFid, "mp4");
    const audioPath = this.ephemeralStore.getPathFor(videoId, audioFid, "m4a");

    const videoPin = this.ephemeralStore.makeKey(videoId, videoFid);
    const audioPin = this.ephemeralStore.makeKey(videoId, audioFid);
    this.ephemeralStore.pin(videoPin);
    this.ephemeralStore.pin(audioPin);

    try {
      const videoSelector = `bestvideo[height<=${maxH}][ext=mp4]/bestvideo[height<=${maxH}]/bestvideo`;
      const audioSelector = `bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio`;

      if (!this.ephemeralStore.get(videoId, videoFid)) {
        await this.downloadWithAuthFallback(videoId, videoSelector, videoPath);
      }
      if (!this.ephemeralStore.get(videoId, audioFid)) {
        await this.downloadWithAuthFallback(videoId, audioSelector, audioPath);
      }

      // Ensure both downloaded files have DASH sidx/Cues index ranges; remux fast with ffmpeg if needed
      const finalVideoPath = await this.ensureDashIndexedFile(videoPath, "video/mp4");
      const finalAudioPath = await this.ensureDashIndexedFile(audioPath, "audio/mp4");

      const videoEntry = this.ephemeralStore.register(videoId, videoFid, finalVideoPath, "video/mp4");
      const audioEntry = this.ephemeralStore.register(videoId, audioFid, finalAudioPath, "audio/mp4");

      const videoRanges = probeLocalFileDashRanges(finalVideoPath, "video/mp4");
      const audioRanges = probeLocalFileDashRanges(finalAudioPath, "audio/mp4");

      const targetsByFid = new Map<string, StreamTarget>();
      const targetsByItag = new Map<number, StreamTarget>();
      const adaptiveFormats: AdaptiveFormatOutput[] = [];

      const vWidth = Number(ytInfo?.width) || 1280;
      const vHeight = Math.min(Number(ytInfo?.height) || 720, maxH);
      const vFps = Math.round(Number(ytInfo?.fps) || 30);

      if (videoRanges) {
        const videoTarget: StreamTargetLocal = {
          kind: "local",
          videoId,
          formatId: videoFid,
          itag: 137,
          filePath: finalVideoPath,
          mimeType: "video/mp4",
          size: videoEntry.size,
          tier: 3,
        };
        targetsByFid.set(videoFid, videoTarget);
        targetsByItag.set(137, videoTarget);

        adaptiveFormats.push({
          index: videoRanges.index,
          init: videoRanges.init,
          bitrate: String(Math.max(100_000, Math.round((videoEntry.size * 8) / durationSec))),
          url: buildProxyPlaybackUrl({
            origin,
            videoId,
            formatId: videoFid,
            itag: 137,
            durSec: durationSec,
            expireSec,
            clen: videoEntry.size,
          }),
          itag: "137",
          type: 'video/mp4; codecs="avc1.640028"',
          clen: String(videoEntry.size),
          lmt: "0",
          projectionType: "RECTANGULAR",
          container: "mp4",
          encoding: "avc1",
          size: `${vWidth}x${vHeight}`,
          fps: vFps,
          resolution: `${vHeight}p`,
          qualityLabel: vFps > 30 ? `${vHeight}p${vFps}` : `${vHeight}p`,
        });
      }

      if (audioRanges) {
        const audioTarget: StreamTargetLocal = {
          kind: "local",
          videoId,
          formatId: audioFid,
          itag: 140,
          filePath: finalAudioPath,
          mimeType: "audio/mp4",
          size: audioEntry.size,
          tier: 3,
        };
        targetsByFid.set(audioFid, audioTarget);
        targetsByItag.set(140, audioTarget);

        adaptiveFormats.push({
          index: audioRanges.index,
          init: audioRanges.init,
          bitrate: String(Math.max(32_000, Math.round((audioEntry.size * 8) / durationSec))),
          url: buildProxyPlaybackUrl({
            origin,
            videoId,
            formatId: audioFid,
            itag: 140,
            durSec: durationSec,
            expireSec,
            clen: audioEntry.size,
          }),
          itag: "140",
          type: 'audio/mp4; codecs="mp4a.40.2"',
          clen: String(audioEntry.size),
          lmt: "0",
          projectionType: "RECTANGULAR",
          container: "mp4",
          encoding: "mp4a.40.2",
          audioQuality: "AUDIO_QUALITY_MEDIUM",
          audioSampleRate: "44100",
          audioChannels: 2,
        });
      }

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
    } finally {
      this.ephemeralStore.unpin(videoPin);
      this.ephemeralStore.unpin(audioPin);
    }
  }

  private async downloadWithAuthFallback(
    videoId: string,
    selector: string,
    outputPath: string,
  ): Promise<void> {
    try {
      await this.ytDlp.downloadFormat(videoId, selector, outputPath, { useAuth: false });
    } catch (err) {
      if (this.config.playback.authFallback.enabled) {
        await this.ytDlp.downloadFormat(videoId, selector, outputPath, { useAuth: true });
      } else {
        throw err;
      }
    }
  }

  private async ensureDashIndexedFile(filePath: string, mimeType: string): Promise<string> {
    if (probeLocalFileDashRanges(filePath, mimeType)) {
      return filePath;
    }
    const ffmpeg = this.config.binaries.ffmpeg;
    if (!ffmpeg) return filePath;

    const remuxPath = `${filePath}.dash.mp4`;
    const proc = Bun.spawn(
      [
        ffmpeg,
        "-y",
        "-i",
        filePath,
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof+faststart",
        "-f",
        "mp4",
        remuxPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code === 0 && fs.existsSync(remuxPath) && probeLocalFileDashRanges(remuxPath, "video/mp4")) {
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

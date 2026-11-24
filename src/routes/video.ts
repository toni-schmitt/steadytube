import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { buildStaticDashMpdXml } from "../innertube/mappers.ts";
import { hasCompleteDashPair, type VideoResolver } from "../media/video-resolver.ts";
import { VALID_VIDEO_ID_RE } from "../media/ytdlp.ts";
import { ipv4Fetch, readBoundedResponseBytes, type FetchLike } from "../net/ipv4-fetch.ts";

const ALLOWED_CAPTION_HOST = /^(?:www\.)?youtube\.com$/i;
const CAPTION_FETCH_TIMEOUT_MS = 20_000;
const MAX_CAPTION_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB cap for VTT subtitle tracks

export class VideoRoutes {
  constructor(
    private readonly resolver: VideoResolver,
    private readonly fetchFn: FetchLike = ipv4Fetch,
    private readonly logger: Logger = noopLogger,
  ) {}

  async handleVideo(videoId: string, origin: string): Promise<Response> {
    if (!VALID_VIDEO_ID_RE.test(videoId)) {
      return Response.json({ error: "Invalid video id" }, { status: 400 });
    }

    try {
      const record = await this.resolver.resolveVideo(videoId, origin);
      return Response.json(record.payload, {
        status: 200,
        headers: {
          "X-SteadyTube-Tier": String(record.tier),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Video resolution failed across all tiers", { videoId, error: message });
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async handleDashManifest(videoId: string, origin: string): Promise<Response> {
    if (!VALID_VIDEO_ID_RE.test(videoId)) {
      return Response.json({ error: "Invalid video id" }, { status: 400 });
    }

    try {
      const record = await this.resolver.resolveVideo(videoId, origin, { requireDashPair: true });
      if (!hasCompleteDashPair(record.adaptiveFormats)) {
        return Response.json(
          { error: "Video lacks complete DASH video and audio representations" },
          { status: 503 },
        );
      }
      const xml = buildStaticDashMpdXml(record.durationSec, record.adaptiveFormats);
      return new Response(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/dash+xml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async handleCaptions(
    videoId: string,
    url: URL,
    _origin: string,
    reqSignal?: AbortSignal,
  ): Promise<Response> {
    if (!VALID_VIDEO_ID_RE.test(videoId)) {
      return new Response("WEBVTT\n\n", {
        status: 400,
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      });
    }

    const label = url.searchParams.get("label") || "";
    const lang = url.searchParams.get("lang") || "";

    try {
      // Never trigger Tier 2 cookies or Tier 3 downloads just to read captions
      const captions =
        this.resolver.getCached(videoId)?.captions ??
        (await this.resolver.getCaptionsAnonymous(videoId));

      if (reqSignal?.aborted) {
        return new Response(null, { status: 499 });
      }

      const track =
        label || lang
          ? captions.find((c) => label && c.label === label) ||
            captions.find((c) => lang && c.languageCode === lang)
          : captions[0];

      if (!track) {
        return new Response("WEBVTT\n\n", {
          status: 404,
          headers: { "Content-Type": "text/vtt; charset=utf-8" },
        });
      }

      const upstream = new URL(track.url);
      if (!upstream.searchParams.has("fmt")) {
        upstream.searchParams.set("fmt", "vtt");
      }

      const timeoutSignal = AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS);
      const signal = reqSignal ? AbortSignal.any([reqSignal, timeoutSignal]) : timeoutSignal;

      const res = await this.fetchFn(upstream.toString(), {
        method: "GET",
        timeoutMs: CAPTION_FETCH_TIMEOUT_MS,
        signal,
        maxBodyBytes: MAX_CAPTION_BODY_BYTES,
        httpsOnly: true,
        publicIpv4Only: true,
        allowedHost: (h) => ALLOWED_CAPTION_HOST.test(h),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return new Response("WEBVTT\n\n", {
          status: res.status,
          headers: { "Content-Type": "text/vtt; charset=utf-8" },
        });
      }

      const vttBytes = await readBoundedResponseBytes(res, MAX_CAPTION_BODY_BYTES);
      const vttText = new TextDecoder("utf-8").decode(vttBytes);
      return new Response(vttText, {
        status: 200,
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Cache-Control": "public, max-age=1800",
        },
      });
    } catch (err) {
      if (reqSignal?.aborted) {
        return new Response(null, { status: 499 });
      }
      this.logger.warn("Caption fetch failed", {
        videoId,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response("Upstream caption fetch failed", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  async handleStoryboards(videoId: string, url: URL, origin: string): Promise<Response> {
    if (!VALID_VIDEO_ID_RE.test(videoId)) {
      return new Response("WEBVTT\n\n", {
        status: 400,
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      });
    }

    const height = Number(url.searchParams.get("height") || 90) || 90;
    const vtt = this.resolver.getStoryboardVtt(videoId, height, origin);
    return new Response(vtt, {
      status: 200,
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "public, max-age=1800",
      },
    });
  }
}

import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { buildStaticDashMpdXml } from "../innertube/mappers.ts";
import type { VideoResolver } from "../media/video-resolver.ts";
import { ipv4Fetch, type FetchLike } from "../net/ipv4-fetch.ts";

const VALID_VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export class VideoRoutes {
  constructor(
    private readonly resolver: VideoResolver,
    private readonly fetchFn: FetchLike = ipv4Fetch,
    private readonly logger: Logger = noopLogger,
  ) {}

  async handleVideo(videoId: string, origin: string): Promise<Response> {
    if (!VALID_VIDEO_ID.test(videoId)) {
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
    if (!VALID_VIDEO_ID.test(videoId)) {
      return Response.json({ error: "Invalid video id" }, { status: 400 });
    }

    try {
      const record = await this.resolver.resolveVideo(videoId, origin);
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

  async handleCaptions(videoId: string, url: URL, origin: string): Promise<Response> {
    if (!VALID_VIDEO_ID.test(videoId)) {
      return new Response("WEBVTT\n\n", {
        status: 400,
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      });
    }

    const label = url.searchParams.get("label") || "";
    const lang = url.searchParams.get("lang") || "";

    try {
      const record = this.resolver.getCached(videoId) || (await this.resolver.resolveVideo(videoId, origin));
      const track =
        record.captions.find((c) => label && c.label === label) ||
        record.captions.find((c) => lang && c.languageCode === lang) ||
        record.captions[0];

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

      const res = await this.fetchFn(upstream.toString(), { method: "GET" });
      if (!res.ok) {
        return new Response("WEBVTT\n\n", {
          status: res.status,
          headers: { "Content-Type": "text/vtt; charset=utf-8" },
        });
      }

      const vttText = await res.text();
      return new Response(vttText, {
        status: 200,
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Cache-Control": "public, max-age=1800",
        },
      });
    } catch (err) {
      this.logger.warn("Caption fetch failed", {
        videoId,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response("WEBVTT\n\n", {
        status: 200,
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      });
    }
  }

  async handleStoryboards(videoId: string, url: URL, origin: string): Promise<Response> {
    if (!VALID_VIDEO_ID.test(videoId)) {
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

import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import type { EphemeralStore } from "../cache/ephemeral-store.ts";
import type { VideoResolver } from "../media/video-resolver.ts";
import type { BrowseRoutes } from "./browse.ts";
import type { MediaProxyRoutes } from "./media-proxy.ts";
import { handleStats } from "./stats.ts";
import type { VideoRoutes } from "./video.ts";
import type { VideoPlaybackRoute } from "./videoplayback.ts";

export interface RouterDeps {
  resolver: VideoResolver;
  ephemeralStore: EphemeralStore;
  mediaProxy: MediaProxyRoutes;
  videoRoutes: VideoRoutes;
  playbackRoute: VideoPlaybackRoute;
  browseRoutes: BrowseRoutes;
  startedAtSec: number;
  allowRemoteBind?: boolean;
  logger?: Logger;
}

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function isAllowedOrigin(origin: string): boolean {
  if (origin === "null") return true; // Electron file:// / FreeTube renderer
  if (origin.startsWith("file://") || origin.startsWith("app://")) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function addCorsHeaders(res: Response, allowedOrigin: string | null): Response {
  const apply = (headers: Headers) => {
    if (allowedOrigin) {
      headers.set("Access-Control-Allow-Origin", allowedOrigin);
      headers.append("Vary", "Origin");
    }
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
    headers.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, X-SteadyTube-Tier",
    );
  };

  try {
    apply(res.headers);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    apply(headers);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

export function normalizePathname(pathname: string): string {
  if (pathname.length > 1) {
    return pathname.replace(/\/+$/, "") || "/";
  }
  return pathname;
}

export function createRequestHandler(deps: RouterDeps) {
  const logger = deps.logger ?? noopLogger;
  const enforceLoopbackHost = !deps.allowRemoteBind;

  return async function handleRequest(req: Request): Promise<Response> {
    const startMs = Date.now();
    const url = new URL(req.url);
    const origin = url.origin;
    const method = req.method.toUpperCase();
    const pathname = normalizePathname(url.pathname);

    // Block DNS rebinding when bound to loopback
    const hostHeader = req.headers.get("host");
    if (enforceLoopbackHost && hostHeader && !LOOPBACK_HOST_RE.test(hostHeader.trim())) {
      return Response.json({ error: "Forbidden Host header" }, { status: 403 });
    }

    // Block arbitrary cross-site browser webpages from calling localhost SteadyTube
    const reqOrigin = req.headers.get("origin");
    let corsOrigin: string | null = null;
    if (reqOrigin !== null) {
      if (!isAllowedOrigin(reqOrigin)) {
        return Response.json({ error: "Forbidden Origin" }, { status: 403 });
      }
      corsOrigin = reqOrigin;
    }

    if (method === "OPTIONS") {
      return addCorsHeaders(new Response(null, { status: 204 }), corsOrigin);
    }

    let response: Response;

    try {
      response = await dispatch(req, url, pathname, method, origin, deps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Unhandled route error", { method, pathname, error: msg });
      response = Response.json({ error: msg }, { status: 500 });
    }

    const elapsedMs = Date.now() - startMs;
    if (!pathname.startsWith("/vi/") && !pathname.startsWith("/ggpht/")) {
      logger.debug("HTTP request", {
        method,
        path: pathname,
        status: response.status,
        elapsedMs,
      });
    }

    return addCorsHeaders(response, corsOrigin);
  };
}

function safeDecodeParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function dispatch(
  req: Request,
  url: URL,
  pathname: string,
  method: string,
  origin: string,
  deps: RouterDeps,
): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  // Health & stats
  if (pathname === "/api/v1/stats" || pathname === "/health") {
    return handleStats(deps.resolver, deps.ephemeralStore, deps.startedAtSec);
  }

  // Stream proxy (/videoplayback)
  if (pathname === "/videoplayback") {
    return await deps.playbackRoute.handle(req, url, origin);
  }

  // Thumbnails (/vi/<videoId>/<file>.jpg)
  if (pathname.startsWith("/vi/")) {
    return await deps.mediaProxy.handleVideoThumbnail(pathname, method);
  }

  // Avatars / banners / storyboards (/ggpht/*)
  if (pathname.startsWith("/ggpht/")) {
    return await deps.mediaProxy.handleGgphtProxy(pathname, url.search, method);
  }

  // RSS subscription feeds
  const feedPlaylistMatch = /^\/feed\/playlist\/([^/]+)$/.exec(pathname);
  if (feedPlaylistMatch) {
    const id = safeDecodeParam(feedPlaylistMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.mediaProxy.handleFeed("playlist", id, method);
  }

  const feedChannelMatch = /^\/feed\/channel\/([^/]+)$/.exec(pathname);
  if (feedChannelMatch) {
    const id = safeDecodeParam(feedChannelMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.mediaProxy.handleFeed("channel", id, method);
  }

  // Video playback & manifests
  const videoMatch = /^\/api\/v1\/videos\/([^/]+)$/.exec(pathname);
  if (videoMatch) {
    const id = safeDecodeParam(videoMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.videoRoutes.handleVideo(id, origin);
  }

  const dashMatch = /^\/api\/manifest\/dash\/id\/([^/]+)$/.exec(pathname);
  if (dashMatch) {
    const id = safeDecodeParam(dashMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.videoRoutes.handleDashManifest(id, origin);
  }

  const captionsMatch = /^\/api\/v1\/captions\/([^/]+)$/.exec(pathname);
  if (captionsMatch) {
    const id = safeDecodeParam(captionsMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.videoRoutes.handleCaptions(id, url, origin, req.signal);
  }

  const storyboardsMatch = /^\/api\/v1\/storyboards\/([^/]+)$/.exec(pathname);
  if (storyboardsMatch) {
    const id = safeDecodeParam(storyboardsMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.videoRoutes.handleStoryboards(id, url, origin);
  }

  // Anonymous IPv4 browsing routes
  if (pathname === "/api/v1/search/suggestions") {
    return await deps.browseRoutes.handleSearchSuggestions(url);
  }

  if (pathname === "/api/v1/search") {
    return await deps.browseRoutes.handleSearch(url, origin);
  }

  if (pathname === "/api/v1/resolveurl") {
    return await deps.browseRoutes.handleResolveUrl(url);
  }

  const channelTabMatch = /^\/api\/v1\/channels\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (channelTabMatch) {
    const channelId = safeDecodeParam(channelTabMatch[1]!);
    const tab = safeDecodeParam(channelTabMatch[2]!);
    if (channelId === null || tab === null) {
      return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    }
    return await deps.browseRoutes.handleChannelTab(
      channelId,
      tab.toLowerCase(),
      url,
      origin,
    );
  }

  const channelMatch = /^\/api\/v1\/channels\/([^/]+)$/.exec(pathname);
  if (channelMatch) {
    const id = safeDecodeParam(channelMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.browseRoutes.handleChannel(id, origin);
  }

  const commentsMatch = /^\/api\/v1\/comments\/([^/]+)$/.exec(pathname);
  if (commentsMatch) {
    const id = safeDecodeParam(commentsMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.browseRoutes.handleComments(id, url, origin);
  }

  const playlistMatch = /^\/api\/v1\/playlists\/([^/]+)$/.exec(pathname);
  if (playlistMatch) {
    const id = safeDecodeParam(playlistMatch[1]!);
    if (id === null) return Response.json({ error: "Malformed path parameter" }, { status: 400 });
    return await deps.browseRoutes.handlePlaylist(id, url, origin);
  }

  return Response.json({ error: `Not Found: ${pathname}` }, { status: 404 });
}

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
  logger?: Logger;
}

function addCorsHeaders(res: Response): Response {
  try {
    if (!res.headers.has("Access-Control-Allow-Origin")) {
      res.headers.set("Access-Control-Allow-Origin", "*");
    }
    res.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
    res.headers.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, X-SteadyTube-Tier",
    );
    return res;
  } catch {
    const headers = new Headers(res.headers);
    if (!headers.has("Access-Control-Allow-Origin")) {
      headers.set("Access-Control-Allow-Origin", "*");
    }
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
    headers.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, X-SteadyTube-Tier",
    );
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

  return async function handleRequest(req: Request): Promise<Response> {
    const startMs = Date.now();
    const url = new URL(req.url);
    const origin = url.origin;
    const method = req.method.toUpperCase();
    const pathname = normalizePathname(url.pathname);

    if (method === "OPTIONS") {
      return addCorsHeaders(new Response(null, { status: 204 }));
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

    return addCorsHeaders(response);
  };
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
    return await deps.mediaProxy.handleFeed(
      "playlist",
      decodeURIComponent(feedPlaylistMatch[1]!),
      method,
    );
  }

  const feedChannelMatch = /^\/feed\/channel\/([^/]+)$/.exec(pathname);
  if (feedChannelMatch) {
    return await deps.mediaProxy.handleFeed(
      "channel",
      decodeURIComponent(feedChannelMatch[1]!),
      method,
    );
  }

  // Video playback & manifests
  const videoMatch = /^\/api\/v1\/videos\/([^/]+)$/.exec(pathname);
  if (videoMatch) {
    return await deps.videoRoutes.handleVideo(decodeURIComponent(videoMatch[1]!), origin);
  }

  const dashMatch = /^\/api\/manifest\/dash\/id\/([^/]+)$/.exec(pathname);
  if (dashMatch) {
    return await deps.videoRoutes.handleDashManifest(decodeURIComponent(dashMatch[1]!), origin);
  }

  const captionsMatch = /^\/api\/v1\/captions\/([^/]+)$/.exec(pathname);
  if (captionsMatch) {
    return await deps.videoRoutes.handleCaptions(decodeURIComponent(captionsMatch[1]!), url, origin);
  }

  const storyboardsMatch = /^\/api\/v1\/storyboards\/([^/]+)$/.exec(pathname);
  if (storyboardsMatch) {
    return await deps.videoRoutes.handleStoryboards(
      decodeURIComponent(storyboardsMatch[1]!),
      url,
      origin,
    );
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
    return await deps.browseRoutes.handleChannelTab(
      decodeURIComponent(channelTabMatch[1]!),
      decodeURIComponent(channelTabMatch[2]!).toLowerCase(),
      url,
      origin,
    );
  }

  const channelMatch = /^\/api\/v1\/channels\/([^/]+)$/.exec(pathname);
  if (channelMatch) {
    return await deps.browseRoutes.handleChannel(decodeURIComponent(channelMatch[1]!), origin);
  }

  const commentsMatch = /^\/api\/v1\/comments\/([^/]+)$/.exec(pathname);
  if (commentsMatch) {
    return await deps.browseRoutes.handleComments(decodeURIComponent(commentsMatch[1]!), url, origin);
  }

  const playlistMatch = /^\/api\/v1\/playlists\/([^/]+)$/.exec(pathname);
  if (playlistMatch) {
    return await deps.browseRoutes.handlePlaylist(decodeURIComponent(playlistMatch[1]!), url, origin);
  }

  return Response.json({ error: `Not Found: ${pathname}` }, { status: 404 });
}

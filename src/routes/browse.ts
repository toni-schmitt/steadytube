import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { TtlLruCache } from "../cache/memory-cache.ts";
import type { AnonymousInnertubeProvider } from "../innertube/client.ts";
import { ContinuationStore } from "../innertube/continuation-store.ts";
import {
  descriptionToHtml,
  mapChannelHeaderAndMeta,
  mapCommentThreadToInvidious,
  mapSearchResultNode,
  mapYoutubeiPlaylistCard,
  mapYoutubeiVideoNode,
  normalizeAuthorThumbnails,
  parseCompactNumber,
  parseRelativeTimeToUnixSec,
  textOf,
} from "../innertube/mappers.ts";

const MAX_SEARCH_PAGES = 25;
const MAX_SEARCH_QUERY_LEN = 500;
const MAX_PLAYLIST_OFFSET = 5000;
const MAX_CONSECUTIVE_EMPTY_PLAYLIST_PAGES = 3;
const SUPPORTED_CHANNEL_TABS = new Set([
  "home",
  "videos",
  "latest",
  "streams",
  "live",
  "shorts",
  "playlists",
  "releases",
  "podcasts",
  "courses",
  "community",
  "posts",
  "search",
]);

interface CachedSearchSession {
  pages: Array<Array<Record<string, unknown>>>;
  lastResult: any;
  inflightContinuation?: Promise<void>;
}

interface CachedPlaylistSession {
  meta: {
    title: string;
    playlistId: string;
    author: string;
    authorId: string;
    authorUrl: string;
    authorThumbnails: Array<{ url: string; width: number; height: number }>;
    description: string;
    descriptionHtml: string;
    videoCount: number;
    viewCount: number;
    updated: number;
  };
  videos: Array<Record<string, unknown>>;
  lastFeed: any;
  exhausted?: boolean;
  consecutiveEmptyPages?: number;
  inflightContinuation?: Promise<void>;
}

interface ChannelTabContinuation {
  kind: "videos" | "playlists";
  channelId: string;
  channelParam: string;
  tab: string;
  channelAuthor: string;
  feed: any;
}

interface CommentContinuation {
  kind: "comments" | "replies" | "replies_page";
  videoId: string;
  source: any;
}

function mapSearchFilters(url: URL): Record<string, string> {
  const filters: Record<string, string> = {};
  const sortBy = url.searchParams.get("sort_by");
  if (sortBy === "upload_date" || sortBy === "date") filters.sort_by = "upload_date";
  else if (sortBy === "view_count" || sortBy === "views") filters.sort_by = "view_count";
  else if (sortBy === "rating") filters.sort_by = "rating";
  else if (sortBy === "relevance") filters.sort_by = "relevance";

  const date = url.searchParams.get("date");
  if (date === "hour" || date === "today" || date === "week" || date === "month" || date === "year") {
    filters.upload_date = date;
  }

  const duration = url.searchParams.get("duration");
  if (duration === "short" || duration === "medium" || duration === "long") {
    filters.duration = duration;
  }

  const type = url.searchParams.get("type");
  if (type === "video" || type === "channel" || type === "playlist" || type === "movie") {
    filters.type = type;
  }

  return filters;
}

export class BrowseRoutes {
  private readonly searchSessions = new TtlLruCache<string, CachedSearchSession>(100, 10 * 60 * 1000);
  private readonly playlistSessions = new TtlLruCache<string, CachedPlaylistSession>(100, 10 * 60 * 1000);
  private readonly searchInitInflight = new Map<string, Promise<CachedSearchSession>>();
  private readonly playlistInitInflight = new Map<string, Promise<CachedPlaylistSession>>();
  private readonly channelContinuations = new ContinuationStore<ChannelTabContinuation>(300, 15 * 60 * 1000);
  private readonly commentContinuations = new ContinuationStore<CommentContinuation>(500, 15 * 60 * 1000);

  constructor(
    private readonly innertube: AnonymousInnertubeProvider,
    private readonly logger: Logger = noopLogger,
  ) {}

  private async getOrInitSearchSession(
    sessionKey: string,
    forceRefresh: boolean,
    initFn: () => Promise<CachedSearchSession>,
  ): Promise<CachedSearchSession> {
    // Always join an active refresh first so overlapping page 1 + page 2 requests stay
    // on the same result generation rather than mixing stale and fresh sessions.
    const inflight = this.searchInitInflight.get(sessionKey);
    if (inflight) return inflight;
    if (!forceRefresh) {
      const existing = this.searchSessions.get(sessionKey);
      if (existing) return existing;
    }

    const promise = initFn()
      .then((session) => {
        this.searchSessions.set(sessionKey, session);
        return session;
      })
      .finally(() => {
        if (this.searchInitInflight.get(sessionKey) === promise) {
          this.searchInitInflight.delete(sessionKey);
        }
      });
    this.searchInitInflight.set(sessionKey, promise);
    return promise;
  }

  private async getOrInitPlaylistSession(
    playlistId: string,
    forceRefresh: boolean,
    initFn: () => Promise<CachedPlaylistSession>,
  ): Promise<CachedPlaylistSession> {
    const inflight = this.playlistInitInflight.get(playlistId);
    if (inflight) return inflight;
    if (!forceRefresh) {
      const existing = this.playlistSessions.get(playlistId);
      if (existing) return existing;
    }

    const promise = initFn()
      .then((session) => {
        this.playlistSessions.set(playlistId, session);
        return session;
      })
      .finally(() => {
        if (this.playlistInitInflight.get(playlistId) === promise) {
          this.playlistInitInflight.delete(playlistId);
        }
      });
    this.playlistInitInflight.set(playlistId, promise);
    return promise;
  }

  /**
   * GET /api/v1/search?q=...&page=1&sort_by=...&date=...&duration=...&type=...
   */
  async handleSearch(url: URL, origin: string): Promise<Response> {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      return Response.json([]);
    }
    if (q.length > MAX_SEARCH_QUERY_LEN) {
      return Response.json({ error: "Search query too long" }, { status: 400 });
    }
    const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1) || 1));
    if (page > MAX_SEARCH_PAGES) {
      return Response.json([]);
    }
    const filters = mapSearchFilters(url);
    const sessionKey = JSON.stringify({ q, filters });

    try {
      const client = await this.innertube.getClient();
      let session = await this.getOrInitSearchSession(sessionKey, page === 1, async () => {
        const res: any = await client.search(q, filters as any);
        const mapped = (res.results || [])
          .map((n: unknown) => mapSearchResultNode(n, origin))
          .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
        return { pages: [mapped], lastResult: res };
      });

      const MAX_GEN_HOPS = 3;
      for (let hops = 0; ; ) {
        let switchedGeneration = false;
        while (session.pages.length < page) {
          const activeRefresh = this.searchInitInflight.get(sessionKey);
          if (activeRefresh && hops < MAX_GEN_HOPS) {
            session = await activeRefresh;
            hops++;
            switchedGeneration = true;
            break;
          }
          const currentCached = this.searchSessions.get(sessionKey);
          if (currentCached && currentCached !== session && hops < MAX_GEN_HOPS) {
            session = currentCached;
            hops++;
            switchedGeneration = true;
            break;
          }
          if (session.inflightContinuation) {
            try {
              await session.inflightContinuation;
            } catch (contErr) {
              if (hops < MAX_GEN_HOPS) {
                const newerRefresh = this.searchInitInflight.get(sessionKey);
                if (newerRefresh) {
                  session = await newerRefresh;
                  hops++;
                  switchedGeneration = true;
                  break;
                }
                const newerCached = this.searchSessions.get(sessionKey);
                if (newerCached && newerCached !== session) {
                  session = newerCached;
                  hops++;
                  switchedGeneration = true;
                  break;
                }
              }
              throw contErr;
            }
            continue;
          }
          if (!session.lastResult?.has_continuation) {
            break;
          }
          const activeSession = session;
          const step = (async () => {
            const next: any = await activeSession.lastResult.getContinuation();
            const mapped = (next.results || [])
              .map((n: unknown) => mapSearchResultNode(n, origin))
              .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
            activeSession.pages.push(mapped);
            activeSession.lastResult = next;
          })();
          activeSession.inflightContinuation = step;
          try {
            await step;
          } catch (contErr) {
            if (hops < MAX_GEN_HOPS) {
              const newerRefresh = this.searchInitInflight.get(sessionKey);
              if (newerRefresh) {
                session = await newerRefresh;
                hops++;
                switchedGeneration = true;
                break;
              }
              const newerCached = this.searchSessions.get(sessionKey);
              if (newerCached && newerCached !== session) {
                session = newerCached;
                hops++;
                switchedGeneration = true;
                break;
              }
            }
            throw contErr;
          } finally {
            if (activeSession.inflightContinuation === step) {
              activeSession.inflightContinuation = undefined;
            }
          }
        }
        if (switchedGeneration) continue;
        // Re-check after completing continuations in case page=1 started/installed a newer generation;
        // only hop while hops < MAX_GEN_HOPS so every switched generation is filled before returning.
        if (hops < MAX_GEN_HOPS) {
          const trailingRefresh = this.searchInitInflight.get(sessionKey);
          if (trailingRefresh) {
            session = await trailingRefresh;
            hops++;
            continue;
          }
          const latestCached = this.searchSessions.get(sessionKey);
          if (latestCached && latestCached !== session) {
            session = latestCached;
            hops++;
            continue;
          }
        }
        break;
      }

      return Response.json(session.pages[page - 1] || []);
    } catch (err) {
      this.logger.warn("Search failed", {
        q,
        page,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : "Search failed" },
        { status: 500 },
      );
    }
  }

  /**
   * GET /api/v1/search/suggestions?q=...
   */
  async handleSearchSuggestions(url: URL): Promise<Response> {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      return Response.json({ query: "", suggestions: [] });
    }
    if (q.length > MAX_SEARCH_QUERY_LEN) {
      return Response.json({ error: "Search query too long" }, { status: 400 });
    }
    try {
      const client = await this.innertube.getClient();
      const suggestions = await client.getSearchSuggestions(q);
      return Response.json({
        query: q,
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      });
    } catch (err) {
      this.logger.warn("Search suggestions failed", {
        q,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ query: q, suggestions: [] });
    }
  }

  /**
   * GET /api/v1/resolveurl?url=...
   */
  async handleResolveUrl(url: URL): Promise<Response> {
    const targetUrl = (url.searchParams.get("url") || "").trim();
    if (!targetUrl) {
      return Response.json({ error: "Missing url parameter" }, { status: 400 });
    }

    try {
      const client = await this.innertube.getClient();
      const resolved: any = await client.resolveURL(targetUrl);
      const payload = resolved?.payload || {};

      if (payload.browseId) {
        const browseId = String(payload.browseId);
        if (browseId.startsWith("UC")) {
          return Response.json({
            pageType: "WEB_PAGE_TYPE_CHANNEL",
            ucid: browseId,
          });
        }
        return Response.json({
          pageType: "WEB_PAGE_TYPE_BROWSE",
          browseId,
        });
      }

      if (payload.videoId) {
        return Response.json({
          pageType: "WEB_PAGE_TYPE_WATCH",
          videoId: String(payload.videoId),
          ...(payload.params ? { params: String(payload.params) } : {}),
        });
      }

      if (payload.playlistId) {
        return Response.json({
          pageType: "WEB_PAGE_TYPE_PLAYLIST",
          playlistId: String(payload.playlistId),
        });
      }

      return Response.json({ error: "Could not resolve URL" }, { status: 404 });
    } catch (err) {
      this.logger.warn("resolveURL failed", {
        targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to resolve URL" },
        { status: 404 },
      );
    }
  }

  /**
   * GET /api/v1/channels/:id
   */
  async handleChannel(channelIdOrHandle: string, origin: string): Promise<Response> {
    try {
      const client = await this.innertube.getClient();
      const resolvedId = await this.normalizeChannelId(client, channelIdOrHandle);
      const channel: any = await client.getChannel(resolvedId);
      const base = mapChannelHeaderAndMeta(channel, resolvedId, origin);

      // Enrich with About tab metadata (totalViews, joined date) when available
      try {
        const about: any = await channel.getAbout();
        const details = about?.metadata || about;
        if (details?.views) base.totalViews = parseCompactNumber(details.views);
        if (details?.joined_date) base.joined = parseRelativeTimeToUnixSec(details.joined_date);
        if (details?.description && !base.description) {
          base.description = textOf(details.description);
        }
      } catch {
        // Optional enrichment; non-fatal
      }

      return Response.json(base);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("Channel fetch failed", { channelIdOrHandle, error: msg });
      const status = /does not exist|not found|404/i.test(msg) ? 404 : 500;
      return Response.json(
        { error: status === 404 ? "This channel does not exist." : msg },
        { status },
      );
    }
  }

  /**
   * GET /api/v1/channels/:id/:tab (videos, streams, shorts, playlists, releases, podcasts, courses, community, search)
   */
  async handleChannelTab(
    channelIdOrHandle: string,
    tab: string,
    url: URL,
    origin: string,
  ): Promise<Response> {
    if (!SUPPORTED_CHANNEL_TABS.has(tab)) {
      return Response.json({ error: `Unsupported channel tab: ${tab}` }, { status: 404 });
    }

    const continuationToken = url.searchParams.get("continuation") || "";
    const sortBy = (url.searchParams.get("sort_by") || "newest").toLowerCase();
    const isPlaylistTab =
      tab === "playlists" || tab === "releases" || tab === "podcasts" || tab === "courses";

    try {
      // Handle continuation pagination first (strictly bound to channel + tab)
      if (continuationToken) {
        const state = this.channelContinuations.get(continuationToken);
        const matchesOwner =
          Boolean(state) &&
          state!.tab === tab &&
          (state!.channelId === channelIdOrHandle || state!.channelParam === channelIdOrHandle);
        if (!state || !matchesOwner) {
          return Response.json(
            isPlaylistTab
              ? { playlists: [], continuation: null }
              : tab === "community" || tab === "posts"
                ? { comments: [], continuation: null }
                : { videos: [], continuation: null },
          );
        }
        const nextFeed = await state.feed.getContinuation();
        const nextToken = nextFeed?.has_continuation
          ? this.channelContinuations.put({
              kind: state.kind,
              channelId: state.channelId,
              channelParam: state.channelParam,
              tab: state.tab,
              channelAuthor: state.channelAuthor,
              feed: nextFeed,
            })
          : null;

        if (state.kind === "playlists") {
          const items = (nextFeed.playlists || nextFeed.videos || [])
            .map((p: unknown) =>
              mapYoutubeiPlaylistCard(p, origin, {
                author: state.channelAuthor,
                authorId: state.channelId,
              }),
            )
            .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
          return Response.json({ playlists: items, continuation: nextToken });
        }

        const items = (nextFeed.videos || [])
          .map((v: unknown) =>
            mapYoutubeiVideoNode(v, origin, {
              author: state.channelAuthor,
              authorId: state.channelId,
            }),
          )
          .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
        return Response.json({ videos: items, continuation: nextToken });
      }

      if (tab === "community" || tab === "posts") {
        return Response.json({ comments: [], continuation: null });
      }

      const client = await this.innertube.getClient();
      const resolvedId = await this.normalizeChannelId(client, channelIdOrHandle);
      const channel: any = await client.getChannel(resolvedId);
      const channelAuthor = textOf(channel.metadata?.title || channel.header?.author?.name || "");
      const channelId = String(channel.metadata?.external_id || resolvedId);

      if (tab === "search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return Response.json([]);
        if (q.length > MAX_SEARCH_QUERY_LEN) {
          return Response.json({ error: "Search query too long" }, { status: 400 });
        }
        const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1) || 1));
        if (page > MAX_SEARCH_PAGES) {
          return Response.json([]);
        }
        const sessionKey = `chsearch:${channelId}:${q}`;
        let session = await this.getOrInitSearchSession(sessionKey, page === 1, async () => {
          const searchFeed: any = await channel.search(q);
          const items = (searchFeed.videos || searchFeed.posts || [])
            .map((n: unknown) =>
              mapYoutubeiVideoNode(n, origin, { author: channelAuthor, authorId: channelId }),
            )
            .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
          return { pages: [items], lastResult: searchFeed };
        });

        const MAX_GEN_HOPS = 3;
        for (let hops = 0; ; ) {
          let switchedGeneration = false;
          while (session.pages.length < page) {
            const activeRefresh = this.searchInitInflight.get(sessionKey);
            if (activeRefresh && hops < MAX_GEN_HOPS) {
              session = await activeRefresh;
              hops++;
              switchedGeneration = true;
              break;
            }
            const currentCached = this.searchSessions.get(sessionKey);
            if (currentCached && currentCached !== session && hops < MAX_GEN_HOPS) {
              session = currentCached;
              hops++;
              switchedGeneration = true;
              break;
            }
            if (session.inflightContinuation) {
              try {
                await session.inflightContinuation;
              } catch (contErr) {
                if (hops < MAX_GEN_HOPS) {
                  const newerRefresh = this.searchInitInflight.get(sessionKey);
                  if (newerRefresh) {
                    session = await newerRefresh;
                    hops++;
                    switchedGeneration = true;
                    break;
                  }
                  const newerCached = this.searchSessions.get(sessionKey);
                  if (newerCached && newerCached !== session) {
                    session = newerCached;
                    hops++;
                    switchedGeneration = true;
                    break;
                  }
                }
                throw contErr;
              }
              continue;
            }
            if (!session.lastResult?.has_continuation) {
              break;
            }
            const activeSession = session;
            const step = (async () => {
              const next: any = await activeSession.lastResult.getContinuation();
              const more = (next.videos || next.posts || [])
                .map((n: unknown) =>
                  mapYoutubeiVideoNode(n, origin, { author: channelAuthor, authorId: channelId }),
                )
                .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
              activeSession.pages.push(more);
              activeSession.lastResult = next;
            })();
            activeSession.inflightContinuation = step;
            try {
              await step;
            } catch (contErr) {
              if (hops < MAX_GEN_HOPS) {
                const newerRefresh = this.searchInitInflight.get(sessionKey);
                if (newerRefresh) {
                  session = await newerRefresh;
                  hops++;
                  switchedGeneration = true;
                  break;
                }
                const newerCached = this.searchSessions.get(sessionKey);
                if (newerCached && newerCached !== session) {
                  session = newerCached;
                  hops++;
                  switchedGeneration = true;
                  break;
                }
              }
              throw contErr;
            } finally {
              if (activeSession.inflightContinuation === step) {
                activeSession.inflightContinuation = undefined;
              }
            }
          }
          if (switchedGeneration) continue;
          if (hops < MAX_GEN_HOPS) {
            const trailingRefresh = this.searchInitInflight.get(sessionKey);
            if (trailingRefresh) {
              session = await trailingRefresh;
              hops++;
              continue;
            }
            const latestCached = this.searchSessions.get(sessionKey);
            if (latestCached && latestCached !== session) {
              session = latestCached;
              hops++;
              continue;
            }
          }
          break;
        }

        return Response.json(session.pages[page - 1] || []);
      }

      let feed: any;
      if (tab === "home" || tab === "videos" || tab === "latest") {
        feed = await channel.getVideos();
      } else if (tab === "streams" || tab === "live") {
        feed = await channel.getLiveStreams();
      } else if (tab === "shorts") {
        feed = await channel.getShorts();
      } else if (tab === "playlists") {
        feed = await channel.getPlaylists();
      } else if (tab === "releases") {
        feed = await channel.getReleases();
      } else if (tab === "podcasts") {
        feed = await channel.getPodcasts();
      } else {
        feed = await channel.getCourses();
      }

      // Apply sort filter if requested (newest / popular / oldest)
      if (!isPlaylistTab && feed && Array.isArray(feed.filters) && feed.filters.length > 1) {
        if (sortBy === "popular") {
          const popFilter = feed.filters.find((f: string) => /popular/i.test(f));
          if (popFilter) feed = await feed.applyFilter(popFilter);
        } else if (sortBy === "oldest") {
          const oldFilter = feed.filters.find((f: string) => /oldest/i.test(f));
          if (oldFilter) feed = await feed.applyFilter(oldFilter);
        }
      }

      const nextToken = feed?.has_continuation
        ? this.channelContinuations.put({
            kind: isPlaylistTab ? "playlists" : "videos",
            channelId,
            channelParam: channelIdOrHandle,
            tab,
            channelAuthor,
            feed,
          })
        : null;

      if (isPlaylistTab) {
        const rawPlaylists = feed?.playlists || [];
        const playlists = rawPlaylists
          .map((p: unknown) =>
            mapYoutubeiPlaylistCard(p, origin, { author: channelAuthor, authorId: channelId }),
          )
          .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
        return Response.json({ playlists, continuation: nextToken });
      }

      const rawVideos = feed?.videos || [];
      const videos = rawVideos
        .map((v: unknown) =>
          mapYoutubeiVideoNode(v, origin, { author: channelAuthor, authorId: channelId }),
        )
        .filter((x: unknown): x is NonNullable<typeof x> => x !== null);

      return Response.json({ videos, continuation: nextToken });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("Channel tab fetch failed", { channelIdOrHandle, tab, error: msg });
      if (/does not have|no videos|not found/i.test(msg)) {
        return Response.json(
          tab === "playlists" || tab === "releases" || tab === "podcasts" || tab === "courses"
            ? { playlists: [], continuation: null }
            : { videos: [], continuation: null },
        );
      }
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  /**
   * GET /api/v1/comments/:id?sort_by=top|new&continuation=...
   */
  async handleComments(videoId: string, url: URL, origin: string): Promise<Response> {
    const continuationToken = url.searchParams.get("continuation") || "";
    const sortBy = (url.searchParams.get("sort_by") || "top").toLowerCase();

    try {
      // Handle pagination or reply thread expansion (strictly bound to videoId)
      if (continuationToken) {
        const state = this.commentContinuations.get(continuationToken);
        if (!state || state.videoId !== videoId) {
          return Response.json({ comments: [], continuation: null });
        }

        if (state.kind === "replies" || state.kind === "replies_page") {
          const repliesObj: any =
            state.kind === "replies"
              ? await state.source.getReplies()
              : await state.source.getContinuation();
          const replyItems: unknown[] = repliesObj?.replies || repliesObj?.contents || [];
          const comments = replyItems
            .map((r: unknown) => mapCommentThreadToInvidious(r as Record<string, any>, origin))
            .filter((x): x is NonNullable<typeof x> => x !== null);
          const nextToken = repliesObj?.has_continuation
            ? this.commentContinuations.put({ kind: "replies_page", videoId, source: repliesObj })
            : null;
          return Response.json({ comments, continuation: nextToken });
        }

        const nextPage: any = await state.source.getContinuation();
        return Response.json(this.serializeCommentsPage(nextPage, origin, videoId));
      }

      const client = await this.innertube.getClient();
      const sortMode = sortBy === "new" ? "NEWEST_FIRST" : "TOP_COMMENTS";
      const page: any = await client.getComments(videoId, sortMode);
      return Response.json(this.serializeCommentsPage(page, origin, videoId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("Comments fetch failed", { videoId, error: msg });
      if (/disabled|not found|turned off/i.test(msg)) {
        return Response.json({ error: "Comments not found" }, { status: 404 });
      }
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  /**
   * GET /api/v1/playlists/:id?index=50
   */
  async handlePlaylist(playlistId: string, url: URL, origin: string): Promise<Response> {
    // FreeTube calls xq(id, t=0) with params: { index: t + 50 }
    const requestedIndex = Math.max(0, Math.floor(Number(url.searchParams.get("index") || 50) || 50));
    const startOffset = Math.max(0, requestedIndex - 50);
    const pageSize = 100;

    try {
      const client = await this.innertube.getClient();
      let session = await this.getOrInitPlaylistSession(playlistId, startOffset === 0, async () => {
        const pl: any = await client.getPlaylist(playlistId);
        const info = pl.info || {};
        const authorName = textOf(info.author?.name || "");
        const authorId = String(info.author?.id || "");
        const totalCount = parseCompactNumber(info.total_items) || (pl.items?.length ?? 0);

        const initialVideos = (pl.items || [])
          .map((v: unknown) => mapYoutubeiVideoNode(v, origin, { author: authorName, authorId }))
          .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
        const descText = textOf(info.description);

        return {
          meta: {
            title: textOf(info.title) || playlistId,
            playlistId,
            author: authorName,
            authorId,
            authorUrl: authorId ? `/channel/${authorId}` : "",
            authorThumbnails: normalizeAuthorThumbnails(info.author?.thumbnails, origin),
            description: descText,
            descriptionHtml: descriptionToHtml(descText),
            videoCount: Math.max(totalCount, initialVideos.length),
            viewCount: parseCompactNumber(info.views),
            updated: parseRelativeTimeToUnixSec(info.last_updated),
          },
          videos: initialVideos,
          lastFeed: pl,
        };
      });

      if (startOffset > MAX_PLAYLIST_OFFSET) {
        return Response.json({
          ...session.meta,
          videoCount: Math.max(session.meta.videoCount, session.videos.length),
          videos: [],
        });
      }

      // Fetch continuations if caller asked past currently buffered items (serialized per session)
      const targetLen = Math.min(startOffset + pageSize, MAX_PLAYLIST_OFFSET + pageSize);
      const MAX_GEN_HOPS = 3;
      for (let hops = 0; ; ) {
        let switchedGeneration = false;
        while (
          session.videos.length < targetLen &&
          !session.exhausted &&
          (session.inflightContinuation || session.lastFeed?.has_continuation)
        ) {
          const activeRefresh = this.playlistInitInflight.get(playlistId);
          if (activeRefresh && hops < MAX_GEN_HOPS) {
            session = await activeRefresh;
            hops++;
            switchedGeneration = true;
            break;
          }
          const currentCached = this.playlistSessions.get(playlistId);
          if (currentCached && currentCached !== session && hops < MAX_GEN_HOPS) {
            session = currentCached;
            hops++;
            switchedGeneration = true;
            break;
          }
          if (session.inflightContinuation) {
            try {
              await session.inflightContinuation;
            } catch (contErr) {
              if (hops < MAX_GEN_HOPS) {
                const newerRefresh = this.playlistInitInflight.get(playlistId);
                if (newerRefresh) {
                  session = await newerRefresh;
                  hops++;
                  switchedGeneration = true;
                  break;
                }
                const newerCached = this.playlistSessions.get(playlistId);
                if (newerCached && newerCached !== session) {
                  session = newerCached;
                  hops++;
                  switchedGeneration = true;
                  break;
                }
              }
              throw contErr;
            }
            continue;
          }
          const activeSession = session;
          const step = (async () => {
            const next: any = await activeSession.lastFeed.getContinuation();
            const more = (next.items || [])
              .map((v: unknown) =>
                mapYoutubeiVideoNode(v, origin, {
                  author: activeSession.meta.author,
                  authorId: activeSession.meta.authorId,
                }),
              )
              .filter((x: unknown): x is NonNullable<typeof x> => x !== null);
            activeSession.lastFeed = next;
            if (more.length === 0) {
              const emptyCount = (activeSession.consecutiveEmptyPages ?? 0) + 1;
              activeSession.consecutiveEmptyPages = emptyCount;
              if (!next?.has_continuation || emptyCount >= MAX_CONSECUTIVE_EMPTY_PLAYLIST_PAGES) {
                activeSession.exhausted = true;
              }
              return;
            }
            activeSession.consecutiveEmptyPages = 0;
            activeSession.videos.push(...more);
          })();
          activeSession.inflightContinuation = step;
          try {
            await step;
          } catch (contErr) {
            if (hops < MAX_GEN_HOPS) {
              const newerRefresh = this.playlistInitInflight.get(playlistId);
              if (newerRefresh) {
                session = await newerRefresh;
                hops++;
                switchedGeneration = true;
                break;
              }
              const newerCached = this.playlistSessions.get(playlistId);
              if (newerCached && newerCached !== session) {
                session = newerCached;
                hops++;
                switchedGeneration = true;
                break;
              }
            }
            throw contErr;
          } finally {
            if (activeSession.inflightContinuation === step) {
              activeSession.inflightContinuation = undefined;
            }
          }
        }
        if (switchedGeneration) continue;
        if (hops < MAX_GEN_HOPS) {
          const trailingRefresh = this.playlistInitInflight.get(playlistId);
          if (trailingRefresh) {
            session = await trailingRefresh;
            hops++;
            continue;
          }
          const latestCached = this.playlistSessions.get(playlistId);
          if (latestCached && latestCached !== session) {
            session = latestCached;
            hops++;
            continue;
          }
        }
        break;
      }

      const slice = session.videos.slice(startOffset, startOffset + pageSize);
      return Response.json({
        ...session.meta,
        videoCount: Math.max(session.meta.videoCount, session.videos.length),
        videos: slice,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("Playlist fetch failed", { playlistId, error: msg });
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  private serializeCommentsPage(page: any, origin: string, videoId: string) {
    const threads: any[] = page?.contents || [];
    const comments = [];

    for (const thread of threads) {
      let replyToken: string | undefined;
      if (thread?.has_replies) {
        replyToken = this.commentContinuations.put({
          kind: "replies",
          videoId,
          source: thread,
        });
      }
      const mapped = mapCommentThreadToInvidious(thread, origin, replyToken);
      if (mapped) comments.push(mapped);
    }

    const nextToken = page?.has_continuation
      ? this.commentContinuations.put({ kind: "comments", videoId, source: page })
      : null;

    return {
      commentCount: parseCompactNumber(page?.header?.count),
      videoId,
      comments,
      continuation: nextToken,
    };
  }

  private async normalizeChannelId(client: any, idOrHandle: string): Promise<string> {
    if (idOrHandle.startsWith("UC") && idOrHandle.length === 24) {
      return idOrHandle;
    }
    if (idOrHandle.startsWith("@")) {
      const resolved = await client.resolveURL(`https://www.youtube.com/${idOrHandle}`);
      if (resolved?.payload?.browseId) {
        return String(resolved.payload.browseId);
      }
    }
    return idOrHandle;
  }
}

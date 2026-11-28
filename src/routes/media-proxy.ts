import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
// RSS feeds are tiny (~4-40 KiB) and normally finish in ~350 ms (p99 ~1 s).
// Hedge slow/stalled attempts on a fresh connection + alternate IPv4 after 2.5 s so a single
// hung socket doesn't stretch a 300-channel refresh to 20+ s, while keeping attempt 0 alive for
// legitimately slow channels (~3 s) instead of discarding its progress.
const FEED_ATTEMPT_TIMEOUT_MS = 10_000;
const FEED_HEDGE_DELAY_MS = 2_500;
const FEED_RETRY_BACKOFF_MS = 250;
const FEED_HEDGE_WINS_TO_ROTATE_IP = 3;
const SLOW_FEED_THRESHOLD_MS = 1_000;
const FEED_FAMILIES_FILENAME = "rss-families.json";
const FEED_FAMILIES_SAVE_DEBOUNCE_MS = 2_000;
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
// A channel's own playlists: "UU" (all uploads) or "UU" + two letters (UULF videos, UUSH shorts,
// UULV live, ...) followed by the 22 characters that follow "UC" in its channel id.
const CHANNEL_PLAYLIST_ID = /^UU(?:[A-Z]{2})?([A-Za-z0-9_-]{22})$/;

type FeedKind = "playlist" | "channel";

interface RememberedFeed {
  requestedAt: number;
  slowMs: number;
}

interface FeedFamilyState {
  lastRequestAt: number;
  ids: Map<string, RememberedFeed>;
}

interface PersistedFeedFamilies {
  version: 1;
  families: Record<string, Array<{ id: string; requestedAt: number; slowMs?: number }>>;
}

type FeedAttemptOutcome =
  | {
      kind: "response";
      status: number;
      contentType: string;
      body: string;
      attemptElapsedMs: number;
    }
  | {
      kind: "error";
      error: unknown;
      attemptElapsedMs: number;
    };

export interface MediaProxyOptions {
  feedHedgeDelayMs?: number;
  feedAttemptTimeoutMs?: number;
  feedRetryBackoffMs?: number;
  persistFeedFamilies?: boolean;
  canPersistFeedFamilies?: () => boolean;
}

export class MediaProxyRoutes {
  private readonly thumbCache: TtlLruCache<string, CachedBinary>;
  private readonly feedCache: TtlLruCache<string, CachedFeed>;
  private readonly feedInflight = new Map<string, SharedInflightEntry<CachedFeed>>();
  private readonly thumbInflight = new Map<string, SharedInflightEntry<CachedBinary>>();
  private readonly feedSemaphore: Semaphore;
  private readonly thumbSemaphore = new Semaphore(48, MAX_SEMAPHORE_QUEUE_SIZE);
  private readonly feedFamilies = new Map<string, FeedFamilyState>();
  private readonly prefetchQueue: Array<{ kind: FeedKind; id: string }> = [];
  private readonly prefetchQueuedKeys = new Set<string>();
  private prefetchWorkers = 0;
  private activeFeedHedges = 0;
  private consecutiveHedgeWins = 0;
  private readonly hedgeSlotWaiters = new Set<() => void>();
  private readonly maxConcurrentFeedHedges: number;
  private readonly feedHedgeDelayMs: number;
  private readonly feedAttemptTimeoutMs: number;
  private readonly feedRetryBackoffMs: number;
  private readonly persistFeedFamilies: boolean;
  private readonly canPersistFeedFamilies: () => boolean;
  private readonly feedFamiliesPath: string;
  private feedFamiliesDirty = false;
  private feedFamiliesSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchFn: FetchLike = ipv4Fetch,
    private readonly fetchRawFn: FetchLike = ipv4FetchRaw,
    private readonly logger: Logger = noopLogger,
    options: MediaProxyOptions = {},
  ) {
    this.feedHedgeDelayMs = options.feedHedgeDelayMs ?? FEED_HEDGE_DELAY_MS;
    this.feedAttemptTimeoutMs = options.feedAttemptTimeoutMs ?? FEED_ATTEMPT_TIMEOUT_MS;
    this.feedRetryBackoffMs = options.feedRetryBackoffMs ?? FEED_RETRY_BACKOFF_MS;
    this.persistFeedFamilies = options.persistFeedFamilies ?? true;
    this.canPersistFeedFamilies = options.canPersistFeedFamilies ?? (() => true);
    this.maxConcurrentFeedHedges = Math.max(1, Math.floor(config.rss.maxConcurrentUpstream / 4));
    this.feedFamiliesPath = path.join(config.cacheDir, FEED_FAMILIES_FILENAME);
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
    if (this.persistFeedFamilies) {
      this.loadFeedFamiliesFromDisk();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.feedFamiliesSaveTimer) {
      clearTimeout(this.feedFamiliesSaveTimer);
      this.feedFamiliesSaveTimer = null;
    }
    this.flushFeedFamilies();
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

  private getFeedFamilyKey(kind: FeedKind, id: string): string {
    // UULF/UUSH/UULV are a channel's videos/shorts/live playlists, each refreshed by its own FreeTube tab.
    return kind === "playlist" && id.startsWith("UU") ? id.slice(0, 4) : kind;
  }

  private readFeedFamiliesFile(): Map<string, Map<string, RememberedFeed>> {
    const parsedFamilies = new Map<string, Map<string, RememberedFeed>>();
    if (!fs.existsSync(this.feedFamiliesPath)) return parsedFamilies;
    const raw = fs.readFileSync(this.feedFamiliesPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedFeedFamilies>;
    if (!parsed || parsed.version !== 1 || !parsed.families || typeof parsed.families !== "object") {
      return parsedFamilies;
    }
    const now = Date.now();
    for (const [familyKey, entries] of Object.entries(parsed.families)) {
      if (!familyKey || familyKey.length > 32 || !Array.isArray(entries)) continue;
      const ids = new Map<string, RememberedFeed>();
      for (const item of entries) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.id !== "string" || !VALID_FEED_ID.test(item.id)) continue;
        if (typeof item.requestedAt !== "number" || !Number.isFinite(item.requestedAt)) continue;
        if (now - item.requestedAt > FEED_REMEMBER_MS) continue;
        const slowMs =
          typeof item.slowMs === "number" && Number.isFinite(item.slowMs) && item.slowMs > 0
            ? Math.min(Math.round(item.slowMs), 60_000)
            : 0;
        ids.delete(item.id);
        ids.set(item.id, { requestedAt: item.requestedAt, slowMs });
        if (ids.size > FEED_REMEMBER_MAX) {
          ids.delete(ids.keys().next().value!);
        }
      }
      if (ids.size > 0) {
        parsedFamilies.set(familyKey, ids);
      }
    }
    return parsedFamilies;
  }

  private loadFeedFamiliesFromDisk(): void {
    try {
      const parsedFamilies = this.readFeedFamiliesFile();
      for (const [familyKey, ids] of parsedFamilies) {
        // Initialize lastRequestAt to 0 so the very first refresh after a restart prefetches immediately.
        this.feedFamilies.set(familyKey, { lastRequestAt: 0, ids });
      }
    } catch (err) {
      this.logger.debug("Ignoring unreadable persisted RSS feed families file", {
        path: this.feedFamiliesPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleSaveFeedFamilies(): void {
    this.feedFamiliesDirty = true;
    if (!this.persistFeedFamilies || this.stopped) return;
    if (this.feedFamiliesSaveTimer) return;
    this.feedFamiliesSaveTimer = setTimeout(() => {
      this.feedFamiliesSaveTimer = null;
      this.flushFeedFamilies();
    }, FEED_FAMILIES_SAVE_DEBOUNCE_MS);
    this.feedFamiliesSaveTimer.unref?.();
  }

  private flushFeedFamilies(): void {
    if (!this.persistFeedFamilies || !this.feedFamiliesDirty) return;
    // Only the instance owning the cache directory lock may write rss-families.json,
    // preventing standby instances from clobbering the primary's remembered feed history.
    // Keep feedFamiliesDirty set so a standby that later acquires the lock reconciles and flushes.
    if (!this.canPersistFeedFamilies()) return;
    this.feedFamiliesDirty = false;

    const now = Date.now();
    let diskFamilies = new Map<string, Map<string, RememberedFeed>>();
    try {
      diskFamilies = this.readFeedFamiliesFile();
    } catch {
      // Ignore unreadable prior file and overwrite cleanly below.
    }

    const allFamilyKeys = new Set<string>([...diskFamilies.keys(), ...this.feedFamilies.keys()]);
    const families: PersistedFeedFamilies["families"] = {};

    for (const familyKey of allFamilyKeys) {
      const combined = new Map<string, RememberedFeed>();
      const diskIds = diskFamilies.get(familyKey);
      if (diskIds) {
        for (const [id, meta] of diskIds) {
          if (now - meta.requestedAt <= FEED_REMEMBER_MS) {
            combined.set(id, { ...meta });
          }
        }
      }
      const memFamily = this.feedFamilies.get(familyKey);
      if (memFamily) {
        for (const [id, memMeta] of memFamily.ids) {
          if (now - memMeta.requestedAt > FEED_REMEMBER_MS) continue;
          const prev = combined.get(id);
          if (!prev) {
            combined.set(id, { ...memMeta });
          } else {
            const requestedAt = Math.max(prev.requestedAt, memMeta.requestedAt);
            const slowMs =
              memMeta.requestedAt >= prev.requestedAt
                ? (memMeta.slowMs > 0 ? memMeta.slowMs : prev.slowMs)
                : (prev.slowMs > 0 ? prev.slowMs : memMeta.slowMs);
            combined.set(id, { requestedAt, slowMs });
          }
        }
      }
      if (combined.size === 0) continue;

      // Sort least-recently-requested first so the cap evicts the stalest entries consistently.
      const sorted = Array.from(combined.entries()).sort((a, b) => a[1].requestedAt - b[1].requestedAt);
      const bounded = sorted.length > FEED_REMEMBER_MAX ? sorted.slice(-FEED_REMEMBER_MAX) : sorted;

      if (!this.stopped) {
        this.feedFamilies.set(familyKey, {
          lastRequestAt: memFamily?.lastRequestAt ?? 0,
          ids: new Map(bounded),
        });
      }

      families[familyKey] = bounded.map(([id, meta]) => ({
        id,
        requestedAt: meta.requestedAt,
        ...(meta.slowMs > 0 ? { slowMs: meta.slowMs } : {}),
      }));
    }

    const payload: PersistedFeedFamilies = { version: 1, families };
    const tmpPath = `${this.feedFamiliesPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(this.config.cacheDir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmpPath, this.feedFamiliesPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup errors
      }
      this.logger.debug("Failed to persist RSS feed families", {
        path: this.feedFamiliesPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recordFeedLatency(kind: FeedKind, id: string, elapsedMs: number): void {
    const family = this.feedFamilies.get(this.getFeedFamilyKey(kind, id));
    if (!family) return;
    const entry = family.ids.get(id);
    if (!entry) return;
    const measured = Math.max(0, Math.min(Math.round(elapsedMs), 60_000));
    // Jump immediately on slow measurements, decay gradually on fast ones so intermittently slow
    // channels (e.g. 3+ s when cold on YouTube's edge, 350 ms when warm) keep getting prefetched first.
    const nextSlowMs =
      measured > entry.slowMs ? measured : Math.round(entry.slowMs * 0.7 + measured * 0.3);
    if (nextSlowMs !== entry.slowMs) {
      entry.slowMs = nextSlowMs;
      this.scheduleSaveFeedFamilies();
    }
  }

  /**
   * FreeTube sends a whole subscription refresh at once, but Chromium only opens ~6 connections
   * per host, so ~300 feeds at ~370 ms upstream each take 20+ s. On the first request of a
   * refresh, fetch every feed of the same family that earlier refreshes asked for, at full
   * upstream concurrency; FreeTube's queued requests then join those fetches or hit the cache.
   */
  private prefetchFeedFamily(kind: FeedKind, id: string): void {
    const familyKey = this.getFeedFamilyKey(kind, id);
    const now = Date.now();
    let family = this.feedFamilies.get(familyKey);
    if (!family) {
      family = { lastRequestAt: 0, ids: new Map() };
      this.feedFamilies.set(familyKey, family);
    }
    const startsRefresh = now - family.lastRequestAt > FEED_REFRESH_GAP_MS;
    family.lastRequestAt = now;
    // Re-insert so Map order stays least-recently-requested first for the size cap.
    const existing = family.ids.get(id);
    family.ids.delete(id);
    family.ids.set(id, { requestedAt: now, slowMs: existing?.slowMs ?? 0 });
    if (family.ids.size > FEED_REMEMBER_MAX) family.ids.delete(family.ids.keys().next().value!);
    this.scheduleSaveFeedFamilies();
    if (!startsRefresh) return;

    const candidates: Array<{ id: string; slowMs: number }> = [];
    for (const [knownId, meta] of family.ids) {
      if (now - meta.requestedAt > FEED_REMEMBER_MS) {
        family.ids.delete(knownId);
        this.scheduleSaveFeedFamilies();
        continue;
      }
      if (knownId !== id) {
        candidates.push({ id: knownId, slowMs: meta.slowMs });
      }
    }

    // Start the slowest known feeds (e.g. 2-4 s channels) immediately at t=0 so they run in
    // parallel with the bulk of the refresh instead of adding seconds to the tail, while capping
    // promotions to 25% of workers so FreeTube's front-of-list requests still get prefetched first.
    const maxPromotedSlow = Math.max(1, Math.floor(this.config.rss.maxConcurrentUpstream / 4));
    const promotedSlow = candidates
      .filter((c) => c.slowMs >= SLOW_FEED_THRESHOLD_MS)
      .sort((a, b) => b.slowMs - a.slowMs)
      .slice(0, maxPromotedSlow);
    const promotedSet = new Set(promotedSlow.map((c) => c.id));

    for (const item of promotedSlow) {
      this.queuePrefetch(kind, item.id);
    }
    for (const item of candidates) {
      if (!promotedSet.has(item.id)) {
        this.queuePrefetch(kind, item.id);
      }
    }
  }

  /**
   * Prefetches run on at most `maxConcurrentUpstream` workers, so they hold at most that many
   * feed-semaphore slots. Calling loadFeed for every feed of a 300-channel refresh at once would
   * overflow the semaphore's bounded queue and turn FreeTube's own requests into 503 "proxy busy".
   * `first` jumps the queue, for a feed FreeTube is about to ask for.
   */
  private queuePrefetch(kind: FeedKind, id: string, first = false): void {
    const cacheKey = `feed:${kind}:${id}`;
    if (this.feedCache.get(cacheKey) !== undefined || this.feedInflight.has(cacheKey)) {
      return;
    }
    const queueKey = `${kind}:${id}`;
    if (this.prefetchQueuedKeys.has(queueKey)) {
      if (first) {
        const idx = this.prefetchQueue.findIndex((item) => item.kind === kind && item.id === id);
        if (idx > 0) {
          const [item] = this.prefetchQueue.splice(idx, 1);
          this.prefetchQueue.unshift(item!);
        }
      }
      return;
    }
    this.prefetchQueuedKeys.add(queueKey);
    if (first) this.prefetchQueue.unshift({ kind, id });
    else this.prefetchQueue.push({ kind, id });
    if (this.prefetchWorkers >= this.config.rss.maxConcurrentUpstream) return;
    this.prefetchWorkers++;
    void (async () => {
      for (let job = this.prefetchQueue.shift(); job; job = this.prefetchQueue.shift()) {
        this.prefetchQueuedKeys.delete(`${job.kind}:${job.id}`);
        // A failed prefetch is not cached, so FreeTube's own request for that feed retries it.
        await this.loadFeed(job.kind, job.id).catch(() => {});
      }
      this.prefetchWorkers--;
    })();
  }

  private tryAcquireHedgePermit(): (() => void) | null {
    if (this.activeFeedHedges >= this.maxConcurrentFeedHedges) {
      return null;
    }
    const releaseSemaphore = this.feedSemaphore.tryAcquireSparePermit();
    if (!releaseSemaphore) {
      return null;
    }
    this.activeFeedHedges++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeFeedHedges--;
      if (this.hedgeSlotWaiters.size > 0) {
        const waiters = [...this.hedgeSlotWaiters];
        this.hedgeSlotWaiters.clear();
        for (const wake of waiters) wake();
      }
      releaseSemaphore();
    };
  }

  private waitForHedgeSlot(signal: AbortSignal): Promise<boolean> {
    if (this.activeFeedHedges < this.maxConcurrentFeedHedges) {
      return Promise.resolve(true);
    }
    if (signal.aborted) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        this.hedgeSlotWaiters.delete(onFree);
        signal.removeEventListener("abort", onAbort);
      };
      const onFree = () => {
        cleanup();
        resolve(true);
      };
      const onAbort = () => {
        cleanup();
        resolve(false);
      };
      this.hedgeSlotWaiters.add(onFree);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async waitForHedgePermit(signal: AbortSignal): Promise<(() => void) | null> {
    const immediate = this.tryAcquireHedgePermit();
    if (immediate) return immediate;
    // A concurrent hedge requires spare upstream capacity beyond attempt 0's own permit.
    if (this.config.rss.maxConcurrentUpstream < 2) {
      return null;
    }
    while (!signal.aborted) {
      const ready =
        this.activeFeedHedges >= this.maxConcurrentFeedHedges
          ? await this.waitForHedgeSlot(signal)
          : await this.feedSemaphore.waitForSpareCapacity(signal);
      if (!ready || signal.aborted) {
        return null;
      }
      const permit = this.tryAcquireHedgePermit();
      if (permit) return permit;
    }
    return null;
  }

  private async fetchFeedUpstream(
    kind: FeedKind,
    id: string,
    upstreamUrl: string,
    sharedSignal: AbortSignal,
  ): Promise<{ status: number; contentType: string; body: string; attemptElapsedMs: number }> {
    if (sharedSignal.aborted) {
      throw getAbortError(sharedSignal);
    }

    const logOutcome = (message: string, outcome: FeedAttemptOutcome, attempt?: 0 | 1) => {
      this.logger.debug(message, {
        kind,
        id,
        ...(attempt !== undefined ? { attempt } : {}),
        ...(outcome.kind === "response"
          ? { status: outcome.status }
          : { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }),
        elapsedMs: outcome.attemptElapsedMs,
      });
    };

    const finishOutcome = (outcome: FeedAttemptOutcome) => {
      if (sharedSignal.aborted) {
        throw getAbortError(sharedSignal);
      }
      if (outcome.kind === "response") {
        return {
          status: outcome.status,
          contentType: outcome.contentType,
          body: outcome.body,
          attemptElapsedMs: outcome.attemptElapsedMs,
        };
      }
      throw outcome.error instanceof Error
        ? outcome.error
        : new Error(String(outcome.error ?? "Upstream feed fetch failed"));
    };

    const outcomeRank = (outcome: FeedAttemptOutcome): number => {
      if (outcome.kind !== "response") return 0;
      if (outcome.status === 200) return 4;
      if (outcome.status === 404) return 3;
      if (outcome.status < 500) return 2;
      return 1;
    };

    const pickBestOutcome = (
      first: FeedAttemptOutcome | undefined,
      second: FeedAttemptOutcome | undefined,
    ): FeedAttemptOutcome => {
      if (!first) {
        return second ?? { kind: "error", error: new Error("Upstream feed fetch failed"), attemptElapsedMs: 0 };
      }
      if (!second) return first;
      return outcomeRank(second) >= outcomeRank(first) ? second : first;
    };

    const runAttempt = async (
      ctrl: AbortController,
      opts: { freshConnection: boolean; alternateIpv4: boolean },
    ): Promise<FeedAttemptOutcome> => {
      const attemptStartedAt = Date.now();
      const timeoutSignal = AbortSignal.timeout(this.feedAttemptTimeoutMs);
      const attemptSignal = AbortSignal.any([sharedSignal, ctrl.signal, timeoutSignal]);
      try {
        const res = await this.fetchFn(upstreamUrl, {
          method: "GET",
          timeoutMs: this.feedAttemptTimeoutMs,
          signal: attemptSignal,
          httpsOnly: true,
          publicIpv4Only: true,
          freshConnection: opts.freshConnection,
          alternateIpv4: opts.alternateIpv4,
          allowedHost: (h) => ALLOWED_FEED_HOST.test(h),
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            Accept: "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          },
        });
        const status = res.status;
        const contentType = res.headers.get("content-type") || "application/atom+xml; charset=utf-8";

        if (status === 404) {
          await res.body?.cancel().catch(() => {});
          return {
            kind: "response",
            status: 404,
            contentType,
            body: "Not Found",
            attemptElapsedMs: Date.now() - attemptStartedAt,
          };
        }
        if (status >= 500) {
          let body = "";
          try {
            const bodyBytes = await readBoundedResponseBytes(res, MAX_FEED_BODY_BYTES);
            body = new TextDecoder("utf-8").decode(bodyBytes);
          } catch {
            // Preserve the upstream 5xx status even if its error body stream fails or exceeds bounds.
          }
          return {
            kind: "response",
            status,
            contentType,
            body,
            attemptElapsedMs: Date.now() - attemptStartedAt,
          };
        }

        const bodyBytes = await readBoundedResponseBytes(res, MAX_FEED_BODY_BYTES);
        return {
          kind: "response",
          status,
          contentType,
          body: new TextDecoder("utf-8").decode(bodyBytes),
          attemptElapsedMs: Date.now() - attemptStartedAt,
        };
      } catch (err) {
        return {
          kind: "error",
          error: err,
          attemptElapsedMs: Date.now() - attemptStartedAt,
        };
      }
    };

    const ctrl0 = new AbortController();
    const ctrl1 = new AbortController();
    const attempt0Done = new AbortController();
    let attempt0Settled = false;

    const attempt0Promise = runAttempt(ctrl0, {
      freshConnection: false,
      alternateIpv4: false,
    }).then((outcome) => {
      attempt0Settled = true;
      attempt0Done.abort();
      return outcome;
    });

    const handleUnhedgedOutcome = async (r0: FeedAttemptOutcome) => {
      if (sharedSignal.aborted) {
        throw getAbortError(sharedSignal);
      }
      if (r0.kind === "response" && r0.status < 500) {
        this.consecutiveHedgeWins = 0;
        return finishOutcome(r0);
      }
      logOutcome("RSS feed upstream attempt failed; retrying", r0, 0);
      await sleepWithAbort(this.feedRetryBackoffMs, sharedSignal);
      // A transport error/timeout in ipv4Fetch already rotated the sticky IPv4 A -> B, so
      // keep alternateIpv4 false to dial B rather than wrapping back to A on two-IP hosts.
      // An HTTP 5xx did not rotate the sticky IP, so request alternateIpv4: true there.
      const r1 = await runAttempt(ctrl1, {
        freshConnection: true,
        alternateIpv4: r0.kind === "response",
      });
      return finishOutcome(pickBestOutcome(r0, r1));
    };

    const waitSignal = AbortSignal.any([sharedSignal, attempt0Done.signal]);

    try {
      if (this.feedHedgeDelayMs > 0) {
        await sleepWithAbort(this.feedHedgeDelayMs, waitSignal).catch(() => {});
      }

      if (sharedSignal.aborted) {
        throw getAbortError(sharedSignal);
      }
      if (attempt0Settled) {
        return await handleUnhedgedOutcome(await attempt0Promise);
      }

      // Attempt 0 is still pending past the hedge threshold: acquire spare upstream capacity
      // (without blocking normal queued requests or exceeding maxConcurrentUpstream) and launch
      // a hedged attempt on a fresh connection + alternate IPv4 while keeping attempt 0 alive.
      const releaseHedgePermit = await this.waitForHedgePermit(waitSignal);
      if (sharedSignal.aborted) {
        releaseHedgePermit?.();
        throw getAbortError(sharedSignal);
      }
      if (attempt0Settled || !releaseHedgePermit) {
        releaseHedgePermit?.();
        return await handleUnhedgedOutcome(await attempt0Promise);
      }

      this.logger.debug("RSS feed upstream attempt slow; hedging on fresh connection", {
        kind,
        id,
        elapsedMs: this.feedHedgeDelayMs,
      });
      const attempt1Promise = runAttempt(ctrl1, {
        freshConnection: true,
        alternateIpv4: true,
      }).finally(() => {
        releaseHedgePermit();
      });

      let non200Count = 0;
      const toWinning200 = (attemptIndex: 0 | 1, promise: Promise<FeedAttemptOutcome>) =>
        promise.then((outcome) => {
          if (outcome.kind === "response" && outcome.status === 200) {
            return { attemptIndex, outcome };
          }
          if (++non200Count === 1 && !sharedSignal.aborted) {
            logOutcome("RSS feed upstream attempt failed; waiting on other attempt", outcome, attemptIndex);
          }
          throw outcome;
        });

      try {
        const { attemptIndex, outcome } = await Promise.any([
          toWinning200(0, attempt0Promise),
          toWinning200(1, attempt1Promise),
        ]);
        if (attemptIndex === 0) {
          this.consecutiveHedgeWins = 0;
          ctrl1.abort(new DOMException("Primary feed attempt won", "AbortError"));
        } else {
          const rotateStickyIp =
            !attempt0Settled && ++this.consecutiveHedgeWins >= FEED_HEDGE_WINS_TO_ROTATE_IP;
          if (rotateStickyIp) {
            this.consecutiveHedgeWins = 0;
          }
          ctrl0.abort(
            rotateStickyIp
              ? new DOMException("Repeated hedge wins; rotating sticky IPv4", "TimeoutError")
              : new DOMException("Hedged feed attempt won", "AbortError"),
          );
        }
        return finishOutcome(outcome);
      } catch (aggErr) {
        const outcomes =
          aggErr instanceof AggregateError
            ? (aggErr.errors as FeedAttemptOutcome[])
            : [];
        return finishOutcome(pickBestOutcome(outcomes[0], outcomes[1]));
      }
    } finally {
      attempt0Done.abort();
      ctrl0.abort();
      ctrl1.abort();
    }
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
            const result = await this.fetchFeedUpstream(kind, id, upstreamUrl, sharedSignal);

            if (result.status === 200) {
              this.recordFeedLatency(kind, id, result.attemptElapsedMs);
              return {
                value: { status: 200, contentType: result.contentType, body: result.body },
                ttlMs: this.config.rss.cacheTtlSec * 1000,
                cache: true,
              };
            }
            if (result.status === 404) {
              this.recordFeedLatency(kind, id, result.attemptElapsedMs);
              // FreeTube falls back to the channel feed when a channel's UU… playlist 404s; start it now
              // so it is ready when FreeTube asks, instead of costing another upstream round trip then.
              const channelSuffix = kind === "playlist" ? CHANNEL_PLAYLIST_ID.exec(id)?.[1] : undefined;
              if (channelSuffix) this.queuePrefetch("channel", `UC${channelSuffix}`, true);
              return {
                value: { status: 404, contentType: "text/plain; charset=utf-8", body: "Not Found" },
                ttlMs: this.config.rss.negativeCacheTtlSec * 1000,
                cache: true,
              };
            }
            return {
              value: { status: result.status, contentType: result.contentType, body: result.body },
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

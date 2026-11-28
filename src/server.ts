import type { AppConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { EphemeralStore } from "./cache/ephemeral-store.ts";
import { AnonymousInnertubeProvider } from "./innertube/client.ts";
import { createYtDlpRunner, type YtDlpRunner } from "./media/ytdlp.ts";
import { VideoResolver } from "./media/video-resolver.ts";
import { ipv4Fetch, ipv4FetchRaw, type FetchLike } from "./net/ipv4-fetch.ts";
import { BrowseRoutes } from "./routes/browse.ts";
import { MediaProxyRoutes, type MediaProxyOptions } from "./routes/media-proxy.ts";
import { createRequestHandler } from "./routes/router.ts";
import { VideoRoutes } from "./routes/video.ts";
import { VideoPlaybackRoute } from "./routes/videoplayback.ts";

export interface AppOverrides {
  logger?: Logger;
  ytDlp?: YtDlpRunner;
  innertube?: AnonymousInnertubeProvider;
  fetchFn?: FetchLike;
  fetchRawFn?: FetchLike;
  deferCacheScan?: boolean;
  mediaProxyOptions?: MediaProxyOptions;
}

export interface RunningApp {
  config: AppConfig;
  logger: Logger;
  ephemeralStore: EphemeralStore;
  resolver: VideoResolver;
  fetch: (req: Request) => Promise<Response>;
  stop(): void;
  awaitShutdown(timeoutMs?: number): Promise<void>;
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): RunningApp {
  const logger =
    overrides.logger ??
    createLogger({
      level: config.logLevel,
      logDir: config.logDir,
      writeToConsole: true,
    });

  const fetchFn = overrides.fetchFn ?? ipv4Fetch;
  const fetchRawFn = overrides.fetchRawFn ?? ipv4FetchRaw;

  const ephemeralStore = new EphemeralStore(
    config.cacheDir,
    config.playback.ephemeralBuffer.maxCacheBytes,
    config.playback.ephemeralBuffer.ttlSeconds * 1000,
    logger,
    { deferScan: overrides.deferCacheScan },
  );

  const innertube = overrides.innertube ?? new AnonymousInnertubeProvider(logger);
  const ytDlp = overrides.ytDlp ?? createYtDlpRunner(config, logger);
  const resolver = new VideoResolver(config, ytDlp, innertube, ephemeralStore, fetchRawFn, logger);

  const mediaProxy = new MediaProxyRoutes(
    config,
    fetchFn,
    fetchRawFn,
    logger,
    overrides.mediaProxyOptions,
  );
  const videoRoutes = new VideoRoutes(resolver, fetchFn, logger);
  const playbackRoute = new VideoPlaybackRoute(config, resolver, ephemeralStore, fetchRawFn, logger);
  const browseRoutes = new BrowseRoutes(innertube, logger);

  const startedAtSec = Math.floor(Date.now() / 1000);
  const handler = createRequestHandler({
    resolver,
    ephemeralStore,
    mediaProxy,
    videoRoutes,
    playbackRoute,
    browseRoutes,
    startedAtSec,
    allowRemoteBind: config.allowRemoteBind,
    logger,
  });

  let drainClosePromise: Promise<void> | null = null;
  const scheduleDrainClose = (): Promise<void> => {
    if (!drainClosePromise) {
      drainClosePromise = resolver.waitForAllDiskWorkSettled().finally(() => {
        ephemeralStore.close();
      });
    }
    return drainClosePromise;
  };

  return {
    config,
    logger,
    ephemeralStore,
    resolver,
    fetch: handler,
    stop() {
      mediaProxy.stop();
      resolver.stop();
      if (resolver.hasActiveDiskWork()) {
        // Keep the cache lock held until ALL active disk jobs actually settle,
        // while immediately blocking all new lock acquisitions, reservations, and registrations.
        ephemeralStore.beginShutdown();
        void scheduleDrainClose();
      } else {
        ephemeralStore.close();
      }
    },
    async awaitShutdown(timeoutMs = 1000): Promise<void> {
      if (!resolver.hasActiveDiskWork()) {
        await resolver.awaitShutdown(timeoutMs);
        if (!resolver.hasActiveDiskWork()) {
          ephemeralStore.close();
        } else {
          void scheduleDrainClose();
        }
        return;
      }
      const drain = scheduleDrainClose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        drain,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      // Do NOT close ephemeralStore on timeout — `drain.finally` releases the lock
      // strictly after all active disk work has settled.
    },
  };
}

export function startServer(config: AppConfig, overrides: AppOverrides = {}) {
  // Defer destructive startup staging-dir cleanup until AFTER the listening port is bound
  // so an accidental second daemon failing with EADDRINUSE never touches live downloads.
  const app = createApp(config, { ...overrides, deferCacheScan: true });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    fetch: app.fetch,
  });

  app.ephemeralStore.initialize();
  // Always arm periodic cleanup (no-op while standby without lock, active immediately on takeover)
  app.ephemeralStore.startPeriodicCleanup();
  if (!app.ephemeralStore.hasExclusiveLock()) {
    app.logger.warn(
      "Ephemeral cache directory is locked by another live SteadyTube instance; Tier 3 disk writes and cleanup are disabled until lock acquisition",
      { cacheDir: config.cacheDir },
    );
  }

  app.logger.info("steadytube listening", {
    url: `http://${server.hostname}:${server.port}`,
    configPath: config.configPath,
    cacheDir: config.cacheDir,
    logDir: config.logDir,
    ytDlp: config.binaries.ytDlp,
    deno: config.binaries.deno,
    ffmpeg: config.binaries.ffmpeg,
    tier2AuthConfigured: config.playback.authFallback.enabled,
    tier3BufferEnabled: config.playback.ephemeralBuffer.enabled,
  });

  return {
    server,
    app,
    stop() {
      app.stop();
      server.stop(true);
    },
    async awaitShutdown(timeoutMs = 1000): Promise<void> {
      await app.awaitShutdown(timeoutMs);
    },
  };
}

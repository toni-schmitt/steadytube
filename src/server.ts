import type { AppConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { EphemeralStore } from "./cache/ephemeral-store.ts";
import { AnonymousInnertubeProvider } from "./innertube/client.ts";
import { createYtDlpRunner, type YtDlpRunner } from "./media/ytdlp.ts";
import { VideoResolver } from "./media/video-resolver.ts";
import { ipv4Fetch, ipv4FetchRaw, type FetchLike } from "./net/ipv4-fetch.ts";
import { BrowseRoutes } from "./routes/browse.ts";
import { MediaProxyRoutes } from "./routes/media-proxy.ts";
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

  const mediaProxy = new MediaProxyRoutes(config, fetchFn, fetchRawFn, logger);
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

  return {
    config,
    logger,
    ephemeralStore,
    resolver,
    fetch: handler,
    stop() {
      resolver.stop();
      ephemeralStore.close();
    },
    async awaitShutdown(timeoutMs = 1000): Promise<void> {
      await resolver.awaitShutdown(timeoutMs);
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
  if (app.ephemeralStore.hasExclusiveLock()) {
    app.ephemeralStore.startPeriodicCleanup();
  } else {
    app.logger.warn(
      "Ephemeral cache directory is locked by another live SteadyTube instance; Tier 3 disk writes and cleanup are disabled for this instance",
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AuthFallbackConfig {
  enabled: boolean;
  cookiesFromBrowser: string;
  firefoxProfile: string;
}

export interface EphemeralBufferConfig {
  enabled: boolean;
  maxCacheBytes: number;
  ttlSeconds: number;
  maxFormatHeight: number;
}

export interface AppConfig {
  host: string;
  port: number;
  allowRemoteBind: boolean;
  logLevel: LogLevel;
  configPath: string;
  cacheDir: string;
  logDir: string;
  binaries: {
    ytDlp: string;
    deno: string | null;
    ffmpeg: string | null;
  };
  playback: {
    videoCacheTtlSec: number;
    ytDlpTimeoutMs: number;
    streamStallTimeoutMs: number;
    bgutilPotUrl: string;
    enableBgutilPot: boolean;
    authFallback: AuthFallbackConfig;
    ephemeralBuffer: EphemeralBufferConfig;
  };
  rss: {
    cacheTtlSec: number;
    negativeCacheTtlSec: number;
    maxConcurrentUpstream: number;
  };
  thumbnails: {
    cacheTtlSec: number;
    maxEntries: number;
    maxEntryBytes: number;
  };
}

export interface PartialAppConfig {
  host?: string;
  port?: number;
  allowRemoteBind?: boolean;
  logLevel?: LogLevel;
  cacheDir?: string;
  logDir?: string;
  binaries?: {
    ytDlp?: string;
    deno?: string | null;
    ffmpeg?: string | null;
  };
  playback?: {
    videoCacheTtlSec?: number;
    ytDlpTimeoutMs?: number;
    streamStallTimeoutMs?: number;
    bgutilPotUrl?: string;
    enableBgutilPot?: boolean;
    authFallback?: Partial<AuthFallbackConfig>;
    ephemeralBuffer?: Partial<EphemeralBufferConfig>;
  };
  rss?: {
    cacheTtlSec?: number;
    negativeCacheTtlSec?: number;
    maxConcurrentUpstream?: number;
  };
  thumbnails?: {
    cacheTtlSec?: number;
    maxEntries?: number;
    maxEntryBytes?: number;
  };
}

const APP_NAME = "steadytube";

export function getDefaultConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const baseDir = xdgConfig && xdgConfig.trim() !== ""
    ? xdgConfig
    : path.join(os.homedir(), ".config");
  return path.join(baseDir, APP_NAME, "config.json");
}

export function getDefaultCacheDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", APP_NAME);
  }
  const xdgCache = process.env.XDG_CACHE_HOME;
  const baseDir = xdgCache && xdgCache.trim() !== ""
    ? xdgCache
    : path.join(os.homedir(), ".cache");
  return path.join(baseDir, APP_NAME);
}

export function getDefaultLogDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", APP_NAME);
  }
  const xdgState = process.env.XDG_STATE_HOME;
  const baseDir = xdgState && xdgState.trim() !== ""
    ? xdgState
    : path.join(os.homedir(), ".local", "state");
  return path.join(baseDir, APP_NAME, "logs");
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function resolveBinary(name: string, configured?: string | null): string | null {
  if (configured === null) return null;
  if (configured && configured.trim() !== "") {
    const expanded = expandHome(configured.trim());
    if (expanded.includes("/")) {
      return expanded;
    }
    name = expanded;
  }

  const fromBunWhich = Bun.which(name);
  if (fromBunWhich) return fromBunWhich;

  const extraDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".deno", "bin"),
    "/usr/bin",
    "/bin",
  ];

  for (const dir of extraDirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function loadConfig(overridePath?: string): AppConfig {
  const configPath = expandHome(
    overridePath || process.env.STEADYTUBE_CONFIG || getDefaultConfigPath(),
  );

  let fileConfig: PartialAppConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      fileConfig = JSON.parse(raw) as PartialAppConfig;
    } catch (err) {
      throw new Error(
        `Failed to parse config file at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const host = process.env.STEADYTUBE_HOST || fileConfig.host || "127.0.0.1";
  const allowRemoteBind =
    process.env.STEADYTUBE_ALLOW_REMOTE_BIND === "1" ||
    process.env.STEADYTUBE_ALLOW_REMOTE_BIND === "true" ||
    Boolean(fileConfig.allowRemoteBind);
  const isLoopbackHost =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!isLoopbackHost && !allowRemoteBind) {
    throw new Error(
      `Refusing non-loopback bind host "${host}". Set allowRemoteBind: true in config.json or STEADYTUBE_ALLOW_REMOTE_BIND=1 to override.`,
    );
  }
  const envPort = process.env.STEADYTUBE_PORT ? Number(process.env.STEADYTUBE_PORT) : undefined;
  const port = envPort && Number.isInteger(envPort) && envPort > 0 && envPort <= 65535
    ? envPort
    : (fileConfig.port ?? 8787);

  const logLevel = (process.env.STEADYTUBE_LOG_LEVEL as LogLevel | undefined)
    || fileConfig.logLevel
    || "info";

  const cacheDir = expandHome(
    process.env.STEADYTUBE_CACHE_DIR || fileConfig.cacheDir || getDefaultCacheDir(),
  );
  const logDir = expandHome(
    process.env.STEADYTUBE_LOG_DIR || fileConfig.logDir || getDefaultLogDir(),
  );

  const ytDlp = resolveBinary("yt-dlp", fileConfig.binaries?.ytDlp) || "yt-dlp";
  const deno = resolveBinary("deno", fileConfig.binaries?.deno);
  const ffmpeg = resolveBinary("ffmpeg", fileConfig.binaries?.ffmpeg);

  const authFile = fileConfig.playback?.authFallback;
  const envFirefoxProfile = process.env.STEADYTUBE_FIREFOX_PROFILE;
  const firefoxProfile = (envFirefoxProfile ?? authFile?.firefoxProfile ?? "").trim();
  const cookiesFromBrowser = (authFile?.cookiesFromBrowser || "firefox").trim();
  // Auto-enable auth fallback when firefoxProfile is explicitly provided unless enabled is explicitly false
  const authEnabled = authFile?.enabled !== undefined
    ? Boolean(authFile.enabled && firefoxProfile.length > 0)
    : firefoxProfile.length > 0;

  const ephemFile = fileConfig.playback?.ephemeralBuffer;

  return {
    host,
    port,
    allowRemoteBind,
    logLevel,
    configPath,
    cacheDir,
    logDir,
    binaries: {
      ytDlp,
      deno,
      ffmpeg,
    },
    playback: {
      videoCacheTtlSec: fileConfig.playback?.videoCacheTtlSec ?? 1800,
      ytDlpTimeoutMs: fileConfig.playback?.ytDlpTimeoutMs ?? 25_000,
      streamStallTimeoutMs: fileConfig.playback?.streamStallTimeoutMs ?? 15_000,
      bgutilPotUrl: fileConfig.playback?.bgutilPotUrl ?? "http://127.0.0.1:4416",
      enableBgutilPot: fileConfig.playback?.enableBgutilPot ?? true,
      authFallback: {
        enabled: authEnabled,
        cookiesFromBrowser,
        firefoxProfile,
      },
      ephemeralBuffer: {
        enabled: ephemFile?.enabled ?? true,
        maxCacheBytes: ephemFile?.maxCacheBytes ?? 2 * 1024 * 1024 * 1024, // 2 GiB
        ttlSeconds: ephemFile?.ttlSeconds ?? 3600,
        maxFormatHeight: ephemFile?.maxFormatHeight ?? 1080,
      },
    },
    rss: {
      cacheTtlSec: fileConfig.rss?.cacheTtlSec ?? 300,
      negativeCacheTtlSec: fileConfig.rss?.negativeCacheTtlSec ?? 60,
      maxConcurrentUpstream: fileConfig.rss?.maxConcurrentUpstream ?? 32,
    },
    thumbnails: {
      cacheTtlSec: fileConfig.thumbnails?.cacheTtlSec ?? 1800,
      maxEntries: fileConfig.thumbnails?.maxEntries ?? 1000,
      maxEntryBytes: fileConfig.thumbnails?.maxEntryBytes ?? 2 * 1024 * 1024,
    },
  };
}

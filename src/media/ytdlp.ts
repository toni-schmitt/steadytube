import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { ipv4Fetch } from "../net/ipv4-fetch.ts";

export const VALID_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export function assertValidVideoId(videoId: string): string {
  if (!VALID_VIDEO_ID_RE.test(videoId)) {
    throw new Error(`Invalid video ID: ${videoId}`);
  }
  return videoId;
}

export function buildWatchUrl(videoId: string): string {
  assertValidVideoId(videoId);
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  return url.toString();
}

export interface YtDlpFormat {
  format_id: string;
  ext?: string;
  protocol?: string;
  container?: string;
  vcodec?: string | null;
  acodec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  abr?: number | null;
  vbr?: number | null;
  asr?: number | null;
  audio_channels?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string | null;
  dynamic_range?: string | null;
  language?: string | null;
  url?: string;
  http_headers?: Record<string, string>;
}

export interface YtDlpSubtitleTrack {
  ext?: string;
  url?: string;
  name?: string;
}

export interface YtDlpChapter {
  start_time: number;
  end_time: number;
  title: string;
}

export interface YtDlpVideoInfo {
  id: string;
  title?: string;
  description?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  uploader?: string;
  channel?: string;
  channel_id?: string;
  channel_follower_count?: number;
  view_count?: number;
  like_count?: number;
  timestamp?: number;
  upload_date?: string;
  categories?: string[];
  age_limit?: number;
  is_live?: boolean;
  was_live?: boolean;
  live_status?: string;
  availability?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url: string; width?: number; height?: number; id?: string }>;
  formats?: YtDlpFormat[];
  subtitles?: Record<string, YtDlpSubtitleTrack[]>;
  automatic_captions?: Record<string, YtDlpSubtitleTrack[]>;
  chapters?: YtDlpChapter[];
}

export type YtDlpErrorKind =
  | "bot_check"
  | "auth_required"
  | "age_restricted"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "unknown";

export class YtDlpError extends Error {
  constructor(
    message: string,
    public readonly kind: YtDlpErrorKind,
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "YtDlpError";
  }

  get shouldEscalateToAuth(): boolean {
    return (
      this.kind === "bot_check" ||
      this.kind === "auth_required" ||
      this.kind === "age_restricted" ||
      this.kind === "rate_limited"
    );
  }
}

export function classifyYtDlpError(stderr: string): YtDlpErrorKind {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("not a bot") ||
    lower.includes("confirm you're not a bot") ||
    lower.includes("confirm you’re not a bot") ||
    lower.includes("bot detection")
  ) {
    return "bot_check";
  }
  if (
    lower.includes("confirm your age") ||
    lower.includes("inappropriate for some users") ||
    lower.includes("age-restricted")
  ) {
    return "age_restricted";
  }
  if (
    lower.includes("sign in") ||
    lower.includes("login_required") ||
    lower.includes("members-only") ||
    lower.includes("join this channel") ||
    lower.includes("use --cookies")
  ) {
    return "auth_required";
  }
  if (
    lower.includes("http error 429") ||
    lower.includes("http error 403") ||
    lower.includes("too many requests") ||
    lower.includes("ip has been blocked")
  ) {
    return "rate_limited";
  }
  if (
    lower.includes("video unavailable") ||
    lower.includes("private video") ||
    lower.includes("this video has been removed") ||
    lower.includes("account associated with this video has been terminated")
  ) {
    return "unavailable";
  }
  return "unknown";
}

/**
 * Resolve a logical Firefox profile name (e.g. "yt-fallback") via Firefox's
 * profiles.ini into its actual salted profile directory path, since yt-dlp
 * expects a directory name/path rather than the logical Name= field.
 */
export function resolveFirefoxProfileFromIni(
  profileSpec: string,
  firefoxRootDirs?: string[],
): string {
  const trimmed = profileSpec.trim();
  if (!trimmed) return trimmed;

  // Already an explicit path
  const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  if (expanded.includes("/") || fs.existsSync(expanded)) {
    return expanded;
  }

  const roots = firefoxRootDirs ?? [
    path.join(os.homedir(), "Library", "Application Support", "Firefox"),
    path.join(os.homedir(), ".mozilla", "firefox"),
  ];

  for (const root of roots) {
    const iniPath = path.join(root, "profiles.ini");
    if (!fs.existsSync(iniPath)) continue;
    try {
      const content = fs.readFileSync(iniPath, "utf8");
      const sections = content.split(/\r?\n(?=\[)/);
      for (const section of sections) {
        if (!/^\[Profile/i.test(section.trim())) continue;
        let name = "";
        let relPath = "";
        let isRelative = true;
        for (const line of section.split(/\r?\n/)) {
          const idx = line.indexOf("=");
          if (idx === -1) continue;
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k === "Name") name = v;
          else if (k === "Path") relPath = v;
          else if (k === "IsRelative") isRelative = v !== "0";
        }
        if (name === trimmed && relPath) {
          return isRelative ? path.join(root, relPath) : relPath;
        }
      }
    } catch {
      // Ignore unreadable profiles.ini
    }
  }

  return trimmed;
}

export interface YtDlpArgOptions {
  useAuth: boolean;
  bgutilAvailable: boolean;
  extraArgs?: string[];
}

export function buildYtDlpBaseArgs(config: AppConfig, opts: YtDlpArgOptions): string[] {
  const args: string[] = [
    "--ignore-config", // Isolate from personal ~/.config/yt-dlp/config postprocessors/options
    "-4", // Strictly IPv4
    "--no-mark-watched", // Privacy: NEVER mark watched
    "--no-playlist",
    "--no-warnings",
  ];

  if (config.binaries.deno) {
    args.push("--js-runtimes", `deno:${config.binaries.deno}`);
  }

  const extractorParts: string[] = [];
  if (!opts.useAuth) {
    // Prefer visionos (no 60s cap, no TVHTML5 403) while keeping default fallback excluding tv_samsung
    extractorParts.push("youtube:player_client=visionos,default,-tv_samsung");
  }
  if (opts.bgutilAvailable && config.playback.enableBgutilPot && config.playback.bgutilPotUrl) {
    extractorParts.push(`youtubepot-bgutilhttp:base_url=${config.playback.bgutilPotUrl}`);
  }
  for (const part of extractorParts) {
    args.push("--extractor-args", part);
  }

  if (opts.useAuth) {
    const auth = config.playback.authFallback;
    if (!auth.enabled || !auth.firefoxProfile) {
      throw new Error("Auth fallback requested but not configured");
    }
    const resolvedProfile =
      auth.cookiesFromBrowser.toLowerCase() === "firefox"
        ? resolveFirefoxProfileFromIni(auth.firefoxProfile)
        : auth.firefoxProfile;
    const browserSpec = `${auth.cookiesFromBrowser}:${resolvedProfile}`;
    args.push("--cookies-from-browser", browserSpec);
  } else {
    args.push("--no-cookies-from-browser");
  }

  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  return args;
}

export interface YtDlpRunner {
  extractVideoInfo(videoId: string, opts: { useAuth: boolean }): Promise<YtDlpVideoInfo>;
  downloadFormat(
    videoId: string,
    formatSelector: string,
    outputPath: string,
    opts: { useAuth: boolean; timeoutMs?: number },
  ): Promise<string>;
  isBgutilAvailable(): Promise<boolean>;
}

export function createYtDlpRunner(
  config: AppConfig,
  logger: Logger = noopLogger,
): YtDlpRunner {
  let bgutilCheckCache: { available: boolean; expiresAt: number } | null = null;

  async function isBgutilAvailable(): Promise<boolean> {
    if (!config.playback.enableBgutilPot || !config.playback.bgutilPotUrl) {
      return false;
    }
    const now = Date.now();
    if (bgutilCheckCache && now < bgutilCheckCache.expiresAt) {
      return bgutilCheckCache.available;
    }

    let available = false;
    try {
      const pingUrl = new URL("/ping", config.playback.bgutilPotUrl).toString();
      const res = await ipv4Fetch(pingUrl, { method: "GET", timeoutMs: 350 });
      available = res.ok;
      await res.body?.cancel().catch(() => {});
    } catch {
      available = false;
    }

    bgutilCheckCache = { available, expiresAt: now + 60_000 };
    if (available) {
      logger.debug("bgutil PO-token provider detected", { url: config.playback.bgutilPotUrl });
    }
    return available;
  }

  async function spawnYtDlp(
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = [config.binaries.ytDlp, ...args];
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          `${process.env.HOME || ""}/.local/bin`,
          `${process.env.HOME || ""}/.bun/bin`,
          process.env.PATH || "/usr/bin:/bin",
        ].join(":"),
      },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore
      }
    }, timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      if (timedOut) {
        throw new YtDlpError(
          `yt-dlp timed out after ${timeoutMs}ms`,
          "timeout",
          stderr,
          null,
        );
      }

      return { stdout, stderr, exitCode };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof YtDlpError) throw err;
      throw new YtDlpError(
        `Failed to run yt-dlp: ${err instanceof Error ? err.message : String(err)}`,
        "unknown",
        "",
        null,
      );
    }
  }

  return {
    isBgutilAvailable,

    async extractVideoInfo(videoId: string, opts: { useAuth: boolean }): Promise<YtDlpVideoInfo> {
      const watchUrl = buildWatchUrl(videoId);
      const bgutilAvailable = await isBgutilAvailable();
      const args = buildYtDlpBaseArgs(config, {
        useAuth: opts.useAuth,
        bgutilAvailable,
        extraArgs: ["-J", "--skip-download", "--", watchUrl],
      });

      const startMs = Date.now();
      const { stdout, stderr, exitCode } = await spawnYtDlp(args, config.playback.ytDlpTimeoutMs);
      const elapsedMs = Date.now() - startMs;

      if (exitCode !== 0 || !stdout.trim()) {
        const kind = classifyYtDlpError(stderr);
        logger.warn("yt-dlp extraction failed", {
          videoId,
          useAuth: opts.useAuth,
          exitCode,
          kind,
          elapsedMs,
          stderr: stderr.slice(0, 400),
        });
        throw new YtDlpError(
          stderr.trim().split("\n").pop() || `yt-dlp exited with code ${exitCode}`,
          kind,
          stderr,
          exitCode,
        );
      }

      const parsed = JSON.parse(stdout) as YtDlpVideoInfo;
      logger.info("yt-dlp extracted video info", {
        videoId,
        tier: opts.useAuth ? 2 : 1,
        formats: parsed.formats?.length ?? 0,
        elapsedMs,
      });
      return parsed;
    },

    async downloadFormat(
      videoId: string,
      formatSelector: string,
      outputPath: string,
      opts: { useAuth: boolean; timeoutMs?: number },
    ): Promise<string> {
      const watchUrl = buildWatchUrl(videoId);
      const bgutilAvailable = await isBgutilAvailable();

      // Keep container extension (.mp4/.webm/.m4a) at the end and include unique suffix to avoid collisions
      const dotIdx = outputPath.lastIndexOf(".");
      const uniq = `${process.pid}-${Date.now()}`;
      const tmpPath =
        dotIdx > outputPath.lastIndexOf("/")
          ? `${outputPath.slice(0, dotIdx)}.${uniq}.tmp${outputPath.slice(dotIdx)}`
          : `${outputPath}.${uniq}.tmp.bin`;

      const args = buildYtDlpBaseArgs(config, {
        useAuth: opts.useAuth,
        bgutilAvailable,
        extraArgs: [
          "-f",
          formatSelector,
          "--fixup",
          "never", // Keep exact untouched DASH bytes so Shaka sidx/Cues byte offsets match 1:1
          "--no-part",
          "--no-continue",
          "--force-overwrites",
          "-o",
          tmpPath,
          "--",
          watchUrl,
        ],
      });

      const timeoutMs = opts.timeoutMs ?? 180_000;
      const startMs = Date.now();
      let promoted = false;

      try {
        const { stderr, exitCode } = await spawnYtDlp(args, timeoutMs);
        const elapsedMs = Date.now() - startMs;

        if (exitCode !== 0 || !fs.existsSync(tmpPath)) {
          const kind = classifyYtDlpError(stderr);
          throw new YtDlpError(
            stderr.trim().split("\n").pop() || `yt-dlp download exited with code ${exitCode}`,
            kind,
            stderr,
            exitCode,
          );
        }

        fs.renameSync(tmpPath, outputPath);
        promoted = true;
        logger.info("Tier 3 ephemeral buffer download completed", {
          videoId,
          formatSelector,
          outputPath,
          elapsedMs,
        });
        return outputPath;
      } finally {
        // Always clean up partial/staging file on failure or timeout
        if (!promoted) {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch {
            // Ignore
          }
        }
      }
    },
  };
}

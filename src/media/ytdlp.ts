import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerActiveStagingDir,
  unregisterActiveStagingDir,
  type ProgressiveStreamSource,
} from "../cache/ephemeral-store.ts";
import { Semaphore } from "../cache/memory-cache.ts";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { ipv4Fetch } from "../net/ipv4-fetch.ts";

const MAX_EXTRACT_STDOUT_BYTES = 32 * 1024 * 1024; // 32 MiB cap on yt-dlp -J JSON
const MAX_STDERR_BYTES = 2 * 1024 * 1024; // 2 MiB cap on stderr logs
const MAX_CONCURRENT_EXTRACTIONS = 4;

export interface ProcessGroupHandle {
  child: ChildProcess;
  exited: Promise<number>;
  stdoutPromise: Promise<string>;
  stderrPromise: Promise<string>;
  killGroupSync(): void;
}

/**
 * Terminate a detached process and its entire POSIX process group (`-pid`)
 * so descendant processes (e.g. deno/ffmpeg/subshells) never outlive timeout or shutdown.
 */
export function killProcessGroupSync(child: ChildProcess): void {
  const pid = child.pid;
  if (pid && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall back to direct child kill (e.g. already exited or non-leader)
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited
  }
}

function collectBoundedStream(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total).toString("utf8"));
    };
    stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const remaining = maxBytes - total;
      if (remaining > 0) {
        const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf;
        chunks.push(slice);
        total += slice.byteLength;
      }
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

export function spawnProcessGroup(
  cmd: string[],
  opts: {
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
    env?: Record<string, string | undefined>;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
  },
): ProcessGroupHandle {
  const child = spawn(cmd[0]!, cmd.slice(1), {
    detached: true,
    stdio: ["ignore", opts.stdout, opts.stderr],
    env: opts.env,
  });

  const stdoutPromise = collectBoundedStream(
    child.stdout,
    opts.maxStdoutBytes ?? MAX_EXTRACT_STDOUT_BYTES,
  );
  const stderrPromise = collectBoundedStream(
    child.stderr,
    opts.maxStderrBytes ?? MAX_STDERR_BYTES,
  );

  const exited = new Promise<number>((resolve, reject) => {
    let done = false;
    child.once("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    child.once("exit", (code) => {
      if (done) return;
      done = true;
      resolve(code ?? -1);
    });
  });

  return {
    child,
    exited,
    stdoutPromise,
    stderrPromise,
    killGroupSync: () => killProcessGroupSync(child),
  };
}

export const VALID_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
// Allows yt-dlp format filter operators including ^= (prefix match, e.g. [vcodec^=avc1]);
// always passed as a single argv element to `-f` (never via shell) and must start alphanumeric.
const SAFE_FORMAT_SELECTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._+/[\]<=>^,-]{0,199}$/;

export function assertValidVideoId(videoId: string): string {
  if (!VALID_VIDEO_ID_RE.test(videoId)) {
    throw new Error(`Invalid video ID: ${videoId}`);
  }
  return videoId;
}

export function assertSafeFormatSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!SAFE_FORMAT_SELECTOR_RE.test(trimmed)) {
    throw new Error(`Invalid yt-dlp format selector: ${selector}`);
  }
  return trimmed;
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

export interface ProgressiveDownloadOptions {
  useAuth: boolean;
  mimeType: string;
  expectedSize: number;
  maxBytes: number;
  /** Optional logical cache formatId when yt-dlp selector differs from client fid */
  cacheFormatId?: string;
  /** Called with total bytes inside the job's staging dir; return false to abort download */
  onStagingBytes?: (bytes: number) => boolean;
  stallTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxTotalTimeoutMs?: number;
}

export interface ProgressiveDownloadHandle extends ProgressiveStreamSource {
  readonly done: Promise<{ filePath: string; size: number }>;
  cancel(reason?: string): void;
}

export interface DownloadFormatOptions {
  useAuth: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Called periodically with total bytes inside the job's staging dir; return false to abort download */
  onStagingBytes?: (bytes: number) => boolean;
}

export interface YtDlpRunner {
  extractVideoInfo(videoId: string, opts: { useAuth: boolean }): Promise<YtDlpVideoInfo>;
  downloadFormat(
    videoId: string,
    formatSelector: string,
    outputPath: string,
    opts: DownloadFormatOptions,
  ): Promise<string>;
  startProgressiveDownload?(
    videoId: string,
    formatSelector: string,
    outputPath: string,
    opts: ProgressiveDownloadOptions,
  ): Promise<ProgressiveDownloadHandle>;
  isBgutilAvailable(): Promise<boolean>;
  stop?(): void;
  awaitShutdown?(timeoutMs?: number): Promise<void>;
}

function getDirectoryBytes(dirPath: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Concurrent rename/delete by yt-dlp
        }
      } else if (entry.isDirectory()) {
        total += getDirectoryBytes(full);
      }
    }
  } catch {
    // Staging dir not yet created or already removed
  }
  return total;
}

export function createYtDlpRunner(
  config: AppConfig,
  logger: Logger = noopLogger,
): YtDlpRunner {
  let bgutilCheckCache: { available: boolean; expiresAt: number } | null = null;
  let stagingSeq = 0;
  let stopped = false;
  const stopController = new AbortController();
  const extractSemaphore = new Semaphore(MAX_CONCURRENT_EXTRACTIONS, 256);

  interface TrackedJob {
    killSync: () => void;
    exited: Promise<unknown>;
  }
  const activeJobs = new Set<TrackedJob>();

  function createStagingLocation(outputPath: string): { stagingDir: string; stagingFile: string } {
    const parentDir = path.dirname(outputPath);
    fs.mkdirSync(parentDir, { recursive: true });
    const ext = path.extname(outputPath).replace(/[^.A-Za-z0-9]/g, "") || ".bin";
    const uniq = `${process.pid}-${Date.now()}-${++stagingSeq}`;
    const stagingDir = path.join(parentDir, `.stage-${uniq}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    registerActiveStagingDir(stagingDir);
    return {
      stagingDir,
      stagingFile: path.join(stagingDir, `media${ext}`),
    };
  }

  function removeStagingDir(stagingDir: string): void {
    unregisterActiveStagingDir(stagingDir);
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  function buildSpawnEnv(): Record<string, string | undefined> {
    return {
      ...process.env,
      PATH: [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${process.env.HOME || ""}/.local/bin`,
        `${process.env.HOME || ""}/.bun/bin`,
        process.env.PATH || "/usr/bin:/bin",
      ].join(":"),
    };
  }

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
      const pingUrl = new URL("/ping", config.playback.bgutilPotUrl);
      if (pingUrl.hostname !== "127.0.0.1" && pingUrl.hostname !== "localhost") {
        return false;
      }
      const res = await ipv4Fetch(pingUrl.toString(), {
        method: "GET",
        timeoutMs: 350,
        allowedHost: (h) => h === "127.0.0.1" || h === "localhost",
      });
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

  async function awaitWithGrace<T>(promise: Promise<T>, graceMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), graceMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function spawnYtDlp(
    args: string[],
    timeoutMs: number,
    monitor?: {
      stagingDir: string;
      maxBytes?: number;
      onStagingBytes?: (bytes: number) => boolean;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (stopped) {
      throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
    }

    const cmd = [config.binaries.ytDlp, ...args];
    const proc = spawnProcessGroup(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: buildSpawnEnv(),
    });

    let timedOut = false;
    let abortedReason: Error | null = null;

    const killProc = (reason?: Error) => {
      if (reason && !abortedReason) abortedReason = reason;
      proc.killGroupSync();
    };

    const job: TrackedJob = {
      killSync: () => {
        killProc(new YtDlpError("yt-dlp cancelled during shutdown", "unknown", "", null));
        if (monitor?.stagingDir) {
          removeStagingDir(monitor.stagingDir);
        }
      },
      exited: proc.exited.catch(() => {}),
    };
    activeJobs.add(job);

    const timer = setTimeout(() => {
      timedOut = true;
      killProc();
    }, timeoutMs);
    timer.unref?.();

    let sizePollTimer: ReturnType<typeof setInterval> | null = null;
    if (monitor && ((monitor.maxBytes && monitor.maxBytes > 0) || monitor.onStagingBytes)) {
      let highWater = 0;
      sizePollTimer = setInterval(() => {
        const dirBytes = getDirectoryBytes(monitor.stagingDir);
        if (monitor.maxBytes && monitor.maxBytes > 0 && dirBytes > monitor.maxBytes) {
          const budgetErr = new Error(
            `Tier 3 download exceeded maxCacheBytes (${dirBytes} > ${monitor.maxBytes})`,
          );
          budgetErr.name = "BudgetExceededError";
          killProc(budgetErr);
          return;
        }
        if (dirBytes > highWater && monitor.onStagingBytes) {
          highWater = dirBytes;
          if (!monitor.onStagingBytes(dirBytes)) {
            const budgetErr = new Error(
              `Tier 3 download exceeded shared ephemeral disk budget (${dirBytes} bytes)`,
            );
            budgetErr.name = "BudgetExceededError";
            killProc(budgetErr);
          }
        }
      }, 100);
      sizePollTimer.unref?.();
    }

    try {
      const exitCode = await proc.exited;
      clearTimeout(timer);
      if (sizePollTimer) clearInterval(sizePollTimer);

      // Ensure no detached descendants remain alive after the direct child exits
      proc.killGroupSync();

      const graceMs = timedOut || abortedReason ? 100 : 500;
      const [stdout, stderr] = await Promise.all([
        awaitWithGrace(proc.stdoutPromise, graceMs, ""),
        awaitWithGrace(proc.stderrPromise, graceMs, ""),
      ]);

      if (abortedReason) {
        throw abortedReason;
      }

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
      if (sizePollTimer) clearInterval(sizePollTimer);
      proc.killGroupSync();
      if (err instanceof YtDlpError) throw err;
      if (abortedReason && err === abortedReason) throw err;
      throw new YtDlpError(
        `Failed to run yt-dlp: ${err instanceof Error ? err.message : String(err)}`,
        "unknown",
        "",
        null,
      );
    } finally {
      clearTimeout(timer);
      if (sizePollTimer) clearInterval(sizePollTimer);
      activeJobs.delete(job);
    }
  }

  return {
    isBgutilAvailable,

    stop(): void {
      stopped = true;
      if (!stopController.signal.aborted) {
        stopController.abort(new YtDlpError("yt-dlp runner stopped", "unknown", "", null));
      }
      for (const job of [...activeJobs]) {
        job.killSync();
      }
    },

    async awaitShutdown(timeoutMs = 1000): Promise<void> {
      const pending = [...activeJobs].map((j) => j.exited);
      if (pending.length === 0) return;
      await awaitWithGrace(Promise.allSettled(pending), timeoutMs, []);
    },

    async extractVideoInfo(videoId: string, opts: { useAuth: boolean }): Promise<YtDlpVideoInfo> {
      if (stopped) {
        throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
      }
      const watchUrl = buildWatchUrl(videoId);
      const release = await extractSemaphore.acquirePermit(
        config.playback.ytDlpTimeoutMs,
        stopController.signal,
      );
      try {
        if (stopped) {
          throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
        }
        const bgutilAvailable = await isBgutilAvailable();
        if (stopped) {
          throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
        }
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
      } finally {
        release();
      }
    },

    async downloadFormat(
      videoId: string,
      formatSelector: string,
      outputPath: string,
      opts: DownloadFormatOptions,
    ): Promise<string> {
      if (stopped) {
        throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
      }
      const watchUrl = buildWatchUrl(videoId);
      const safeSelector = assertSafeFormatSelector(formatSelector);
      const bgutilAvailable = await isBgutilAvailable();
      if (stopped) {
        throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
      }
      const { stagingDir, stagingFile } = createStagingLocation(outputPath);

      try {
        const args = buildYtDlpBaseArgs(config, {
          useAuth: opts.useAuth,
          bgutilAvailable,
          extraArgs: [
            "-f",
            safeSelector,
            "--fixup",
            "never", // Keep exact untouched DASH bytes so Shaka sidx/Cues byte offsets match 1:1
            "--no-part",
            "--no-continue",
            "--force-overwrites",
            "-o",
            stagingFile,
            "--",
            watchUrl,
          ],
        });

        const timeoutMs = opts.timeoutMs ?? 180_000;
        const startMs = Date.now();

        const { stderr, exitCode } = await spawnYtDlp(args, timeoutMs, {
          stagingDir,
          maxBytes: opts.maxBytes,
          onStagingBytes: opts.onStagingBytes,
        });
        const elapsedMs = Date.now() - startMs;

        if (exitCode !== 0 || !fs.existsSync(stagingFile)) {
          const kind = classifyYtDlpError(stderr);
          throw new YtDlpError(
            stderr.trim().split("\n").pop() || `yt-dlp download exited with code ${exitCode}`,
            kind,
            stderr,
            exitCode,
          );
        }

        const finalSize = fs.statSync(stagingFile).size;
        const totalStagedBytes = Math.max(finalSize, getDirectoryBytes(stagingDir));
        if (opts.maxBytes && opts.maxBytes > 0 && totalStagedBytes > opts.maxBytes) {
          const budgetErr = new Error(
            `Tier 3 download exceeded maxCacheBytes (${totalStagedBytes} > ${opts.maxBytes})`,
          );
          budgetErr.name = "BudgetExceededError";
          throw budgetErr;
        }
        // Final shared accounting check against full staging dir (media + any sidecars) before rename
        if (opts.onStagingBytes && !opts.onStagingBytes(totalStagedBytes)) {
          const budgetErr = new Error(
            `Tier 3 download exceeded shared ephemeral disk budget (${totalStagedBytes} bytes)`,
          );
          budgetErr.name = "BudgetExceededError";
          throw budgetErr;
        }

        fs.renameSync(stagingFile, outputPath);
        logger.info("Tier 3 ephemeral buffer download completed", {
          videoId,
          formatSelector,
          outputPath,
          elapsedMs,
        });
        return outputPath;
      } finally {
        // Always wipe private staging directory (including any -FragN sidecars, .part, .ytdl)
        // after child process has exited.
        removeStagingDir(stagingDir);
      }
    },

    async startProgressiveDownload(
      videoId: string,
      formatSelector: string,
      outputPath: string,
      opts: ProgressiveDownloadOptions,
    ): Promise<ProgressiveDownloadHandle> {
      if (stopped) {
        throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
      }
      const watchUrl = buildWatchUrl(videoId);
      const safeSelector = assertSafeFormatSelector(formatSelector);
      const bgutilAvailable = await isBgutilAvailable();
      // Recheck stopped immediately after async bgutil probe so stop() never races startup
      if (stopped) {
        throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
      }

      const { stagingDir, stagingFile } = createStagingLocation(outputPath);
      let proc: ProcessGroupHandle;
      try {
        const args = buildYtDlpBaseArgs(config, {
          useAuth: opts.useAuth,
          bgutilAvailable,
          extraArgs: [
            "-f",
            safeSelector,
            "--fixup",
            "never",
            "--no-part",
            "--no-continue",
            "--force-overwrites",
            "-o",
            stagingFile,
            "--",
            watchUrl,
          ],
        });
        if (stopped) {
          throw new YtDlpError("yt-dlp runner stopped", "unknown", "", null);
        }
        const cmd = [config.binaries.ytDlp, ...args];
        proc = spawnProcessGroup(cmd, {
          stdout: "ignore",
          stderr: "pipe",
          env: buildSpawnEnv(),
        });
      } catch (err) {
        removeStagingDir(stagingDir);
        throw err;
      }

      const stallTimeoutMs = opts.stallTimeoutMs ?? Math.max(30_000, config.playback.streamStallTimeoutMs * 2);
      const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
      const maxTotalTimeoutMs = opts.maxTotalTimeoutMs ?? 10 * 60_000;

      let readablePath = stagingFile;
      let availableBytes = 0;
      let status: "downloading" | "completed" | "failed" = "downloading";
      let failureError: Error | null = null;
      let killReason: Error | null = null;
      const startedAt = Date.now();
      let lastProgressAt = startedAt;
      let lastTouchedAt = startedAt;
      let activeReaders = 0;
      let promoted = false;

      type Waiter = {
        minBytes: number;
        resolve: () => void;
        reject: (err: Error) => void;
        cleanup: () => void;
      };
      const waiters = new Set<Waiter>();

      const notifyWaiters = () => {
        for (const w of [...waiters]) {
          if (status === "failed") {
            waiters.delete(w);
            w.cleanup();
            w.reject(failureError ?? new Error("Tier 3 progressive download failed"));
          } else if (status === "completed" || availableBytes >= w.minBytes) {
            waiters.delete(w);
            w.cleanup();
            w.resolve();
          }
        }
      };

      const terminateProc = (err: Error, cleanupSyncNow = false) => {
        if (status !== "downloading") return;
        if (!killReason) killReason = err;
        status = "failed";
        failureError = killReason;
        clearInterval(pollTimer);
        proc.killGroupSync();
        if (cleanupSyncNow && !promoted) {
          removeStagingDir(stagingDir);
        }
        notifyWaiters();
      };

      const trackedJob: TrackedJob = {
        killSync: () => terminateProc(new Error("Server shutting down"), true),
        exited: proc.exited.catch(() => {}),
      };
      activeJobs.add(trackedJob);

      let stagingHighWater = 0;
      const pollTimer = setInterval(() => {
        if (status !== "downloading") return;
        const now = Date.now();
        try {
          const stat = fs.statSync(stagingFile);
          if (stat.size < availableBytes) {
            terminateProc(
              new Error(
                `Tier 3 staging file truncated mid-download (${stat.size} < ${availableBytes})`,
              ),
            );
            return;
          }
          if (stat.size > availableBytes) {
            availableBytes = stat.size;
            lastProgressAt = now;
            notifyWaiters();
          }
        } catch {
          if (availableBytes > 0) {
            terminateProc(new Error("Tier 3 staging file disappeared mid-download"));
            return;
          }
          // File not yet created
        }

        const dirBytes = getDirectoryBytes(stagingDir);
        const totalBytes = Math.max(availableBytes, dirBytes);
        if (opts.maxBytes > 0 && totalBytes > opts.maxBytes) {
          const budgetErr = new Error(
            `Tier 3 progressive download exceeded maxCacheBytes (${totalBytes} > ${opts.maxBytes})`,
          );
          budgetErr.name = "BudgetExceededError";
          terminateProc(budgetErr);
          return;
        }
        if (totalBytes > stagingHighWater && opts.onStagingBytes) {
          stagingHighWater = totalBytes;
          if (!opts.onStagingBytes(totalBytes)) {
            const budgetErr = new Error(
              `Tier 3 progressive download exceeded shared cache budget (${totalBytes} bytes)`,
            );
            budgetErr.name = "BudgetExceededError";
            terminateProc(budgetErr);
            return;
          }
        }
        if (opts.expectedSize > 0 && availableBytes > opts.expectedSize) {
          terminateProc(
            new Error(
              `Tier 3 progressive download exceeded expected size (${availableBytes} > ${opts.expectedSize})`,
            ),
          );
          return;
        }
        if (now - lastProgressAt >= stallTimeoutMs) {
          terminateProc(
            new YtDlpError(
              `Tier 3 progressive download stalled for ${stallTimeoutMs}ms`,
              "timeout",
              "",
              null,
            ),
          );
          return;
        }
        if (activeReaders === 0 && now - lastTouchedAt >= idleTimeoutMs) {
          const idleErr = new Error(`Tier 3 progressive download idle for ${idleTimeoutMs}ms; cancelling`);
          idleErr.name = "IdleCancelledError";
          terminateProc(idleErr);
          return;
        }
        if (now - startedAt >= maxTotalTimeoutMs) {
          terminateProc(
            new YtDlpError(
              `Tier 3 progressive download exceeded max duration (${maxTotalTimeoutMs}ms)`,
              "timeout",
              "",
              null,
            ),
          );
        }
      }, 50);
      pollTimer.unref?.();

      const done = (async (): Promise<{ filePath: string; size: number }> => {
        try {
          const exitCode = await proc.exited;
          clearInterval(pollTimer);
          proc.killGroupSync();

          if (killReason) {
            throw killReason;
          }

          const stderr = await awaitWithGrace(proc.stderrPromise, 500, "");

          if (exitCode !== 0 || !fs.existsSync(stagingFile)) {
            const kind = classifyYtDlpError(stderr);
            throw new YtDlpError(
              stderr.trim().split("\n").pop() || `yt-dlp download exited with code ${exitCode}`,
              kind,
              stderr,
              exitCode,
            );
          }

          const finalSize = fs.statSync(stagingFile).size;
          const totalStagedBytes = Math.max(finalSize, getDirectoryBytes(stagingDir));
          if (finalSize <= 0) {
            throw new Error("Tier 3 progressive download produced empty file");
          }
          if (opts.maxBytes > 0 && totalStagedBytes > opts.maxBytes) {
            const budgetErr = new Error(
              `Tier 3 progressive download exceeded maxCacheBytes (${totalStagedBytes} > ${opts.maxBytes})`,
            );
            budgetErr.name = "BudgetExceededError";
            throw budgetErr;
          }
          if (opts.onStagingBytes && !opts.onStagingBytes(totalStagedBytes)) {
            const budgetErr = new Error(
              `Tier 3 progressive download exceeded shared cache budget (${totalStagedBytes} bytes)`,
            );
            budgetErr.name = "BudgetExceededError";
            throw budgetErr;
          }
          if (opts.expectedSize > 0 && finalSize !== opts.expectedSize) {
            const mismatchErr = new Error(
              `Tier 3 progressive download size mismatch (expected ${opts.expectedSize}, got ${finalSize})`,
            );
            mismatchErr.name = "SizeMismatchError";
            throw mismatchErr;
          }

          fs.renameSync(stagingFile, outputPath);
          promoted = true;
          readablePath = outputPath;
          availableBytes = finalSize;
          status = "completed";
          notifyWaiters();

          logger.info("Tier 3 progressive download completed", {
            videoId,
            formatSelector: safeSelector,
            outputPath,
            size: finalSize,
            elapsedMs: Date.now() - startedAt,
          });
          return { filePath: outputPath, size: finalSize };
        } catch (err) {
          clearInterval(pollTimer);
          proc.killGroupSync();
          const errorObj = err instanceof Error ? err : new Error(String(err));
          status = "failed";
          failureError = errorObj;
          notifyWaiters();
          throw errorObj;
        } finally {
          clearInterval(pollTimer);
          activeJobs.delete(trackedJob);
          // Always remove private staging dir (and any sidecars) after child process has exited
          removeStagingDir(stagingDir);
        }
      })();
      trackedJob.exited = done.catch(() => {});

      return {
        videoId,
        formatId: opts.cacheFormatId || safeSelector,
        mimeType: opts.mimeType,
        expectedSize: opts.expectedSize,
        done,
        getReadablePath: () => readablePath,
        getAvailableBytes: () => availableBytes,
        getStatus: () => status,
        getError: () => failureError,
        touch: () => {
          lastTouchedAt = Date.now();
        },
        onReaderStart: () => {
          activeReaders++;
          lastTouchedAt = Date.now();
        },
        onReaderEnd: () => {
          activeReaders = Math.max(0, activeReaders - 1);
          lastTouchedAt = Date.now();
        },
        cancel: (reason = "Cancelled") => {
          if (status !== "downloading") return;
          terminateProc(new Error(reason), true);
        },
        waitForBytes(minBytes: number, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
          lastTouchedAt = Date.now();
          if (status === "failed") {
            return Promise.reject(failureError ?? new Error("Tier 3 progressive download failed"));
          }
          if (status === "completed" || availableBytes >= minBytes) {
            return Promise.resolve();
          }
          if (signal?.aborted) {
            return Promise.reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError"),
            );
          }

          return new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              waiters.delete(waiter);
              waiter.cleanup();
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new DOMException("The operation was aborted.", "AbortError"),
              );
            };
            const timer = setTimeout(() => {
              waiters.delete(waiter);
              waiter.cleanup();
              reject(new Error(`Timed out waiting ${timeoutMs}ms for Tier 3 bytes (${minBytes})`));
            }, timeoutMs);
            timer.unref?.();

            const waiter: Waiter = {
              minBytes,
              resolve,
              reject,
              cleanup: () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
              },
            };

            signal?.addEventListener("abort", onAbort, { once: true });
            waiters.add(waiter);
          });
        },
      };
    },
  };
}

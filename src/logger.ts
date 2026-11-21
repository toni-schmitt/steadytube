import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "./config.ts";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

export function createLogger(options: {
  level: LogLevel;
  logDir?: string;
  writeToConsole?: boolean;
}): Logger {
  const minWeight = LEVEL_WEIGHT[options.level] ?? LEVEL_WEIGHT.info;
  const writeToConsole = options.writeToConsole ?? true;
  let logFilePath: string | null = null;

  if (options.logDir) {
    try {
      fs.mkdirSync(options.logDir, { recursive: true });
      logFilePath = path.join(options.logDir, "daemon.log");
    } catch {
      logFilePath = null;
    }
  }

  function rotateIfNeeded(): void {
    if (!logFilePath) return;
    try {
      if (fs.existsSync(logFilePath)) {
        const stat = fs.statSync(logFilePath);
        if (stat.size >= MAX_LOG_FILE_BYTES) {
          const prev = `${logFilePath}.1`;
          fs.renameSync(logFilePath, prev);
        }
      }
    } catch {
      // Best-effort log rotation
    }
  }

  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < minWeight) return;
    const ts = new Date().toISOString();
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    const line = `${ts} [${level.toUpperCase()}] ${msg}${metaStr}\n`;

    if (writeToConsole) {
      if (level === "error" || level === "warn") {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    }

    if (logFilePath) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(logFilePath, line);
      } catch {
        // Ignore logging IO errors to avoid crashing daemon
      }
    }
  }

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";

export interface EphemeralFileEntry {
  key: string;
  filePath: string;
  size: number;
  mimeType: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface ParsedByteRange {
  start: number;
  end: number;
  isPartial: boolean;
}

export function parseHttpRangeHeader(
  rangeHeader: string | null,
  totalSize: number,
): ParsedByteRange | "unsatisfiable" {
  if (!rangeHeader || !rangeHeader.trim()) {
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return "unsatisfiable";
  }
  const [, rawStart, rawEnd] = match;
  if (totalSize === 0) {
    return "unsatisfiable";
  }

  let start: number;
  let end: number;

  if (rawStart === "" && rawEnd === "") {
    return "unsatisfiable";
  } else if (rawStart === "") {
    // Suffix byte range: bytes=-500
    const suffixLen = Number(rawEnd);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return "unsatisfiable";
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? totalSize - 1 : Math.min(Number(rawEnd), totalSize - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
    return "unsatisfiable";
  }

  return { start, end, isPartial: true };
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

export class EphemeralStore {
  private readonly entries = new Map<string, EphemeralFileEntry>();
  private readonly pinnedKeys = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly maxCacheBytes: number,
    private readonly ttlMs: number,
    private readonly logger: Logger = noopLogger,
  ) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.scanExistingFiles();
  }

  startPeriodicCleanup(intervalMs = 5 * 60 * 1000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getPathFor(videoId: string, formatId: string, ext: string): string {
    const safeVideo = sanitizeSegment(videoId);
    const safeFormat = sanitizeSegment(formatId);
    const safeExt = sanitizeSegment(ext.replace(/^\./, "")) || "bin";
    const videoDir = path.join(this.baseDir, safeVideo);
    fs.mkdirSync(videoDir, { recursive: true });
    return path.join(videoDir, `${safeFormat}.${safeExt}`);
  }

  makeKey(videoId: string, formatId: string): string {
    return `${videoId}:${formatId}`;
  }

  pin(key: string): void {
    this.pinnedKeys.add(key);
  }

  unpin(key: string): void {
    this.pinnedKeys.delete(key);
  }

  register(videoId: string, formatId: string, filePath: string, mimeType: string): EphemeralFileEntry {
    const stat = fs.statSync(filePath);
    const now = Date.now();
    const key = this.makeKey(videoId, formatId);
    const entry: EphemeralFileEntry = {
      key,
      filePath,
      size: stat.size,
      mimeType,
      createdAt: now,
      lastAccessedAt: now,
    };
    this.entries.set(key, entry);
    this.cleanup();
    return entry;
  }

  get(videoId: string, formatId: string): EphemeralFileEntry | null {
    const key = this.makeKey(videoId, formatId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!fs.existsSync(entry.filePath)) {
      this.entries.delete(key);
      return null;
    }
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  serveFile(entry: EphemeralFileEntry, req: Request): Response {
    entry.lastAccessedAt = Date.now();
    const file = Bun.file(entry.filePath);
    const totalSize = entry.size;
    const rangeHeader = req.headers.get("range");
    const parsed = parseHttpRangeHeader(rangeHeader, totalSize);

    const commonHeaders: Record<string, string> = {
      "Content-Type": entry.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "X-SteadyTube-Tier": "3-buffer",
    };

    if (parsed === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          ...commonHeaders,
          "Content-Range": `bytes */${totalSize}`,
        },
      });
    }

    const contentLength = parsed.end - parsed.start + 1;

    if (req.method === "HEAD") {
      return new Response(null, {
        status: parsed.isPartial ? 206 : 200,
        headers: {
          ...commonHeaders,
          "Content-Length": String(contentLength),
          ...(parsed.isPartial
            ? { "Content-Range": `bytes ${parsed.start}-${parsed.end}/${totalSize}` }
            : {}),
        },
      });
    }

    if (parsed.isPartial) {
      const nodeStream = fs.createReadStream(entry.filePath, {
        start: parsed.start,
        end: parsed.end,
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          nodeStream.on("data", (chunk: string | Buffer) => {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          });
          nodeStream.on("end", () => controller.close());
          nodeStream.on("error", (err) => controller.error(err));
        },
        cancel() {
          nodeStream.destroy();
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          ...commonHeaders,
          "Content-Length": String(contentLength),
          "Content-Range": `bytes ${parsed.start}-${parsed.end}/${totalSize}`,
        },
      });
    }

    return new Response(file, {
      status: 200,
      headers: {
        ...commonHeaders,
        "Content-Length": String(totalSize),
      },
    });
  }

  cleanup(): { removedCount: number; freedBytes: number } {
    const now = Date.now();
    let removedCount = 0;
    let freedBytes = 0;

    // 1. Remove expired unpinned entries
    for (const [key, entry] of this.entries) {
      if (this.pinnedKeys.has(key)) continue;
      if (now - entry.lastAccessedAt >= this.ttlMs) {
        freedBytes += this.removeEntry(key, entry);
        removedCount++;
      }
    }

    // 2. Enforce max disk size by LRU
    let totalBytes = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.size;
    }

    if (totalBytes > this.maxCacheBytes) {
      const sorted = [...this.entries.values()].sort(
        (a, b) => a.lastAccessedAt - b.lastAccessedAt,
      );
      for (const entry of sorted) {
        if (totalBytes <= this.maxCacheBytes) break;
        if (this.pinnedKeys.has(entry.key)) continue;
        const freed = this.removeEntry(entry.key, entry);
        totalBytes -= freed;
        freedBytes += freed;
        removedCount++;
      }
    }

    this.pruneEmptySubdirs();

    if (removedCount > 0) {
      this.logger.info("Ephemeral cache cleaned up", { removedCount, freedBytes });
    }
    return { removedCount, freedBytes };
  }

  getStats(): { fileCount: number; totalBytes: number; baseDir: string } {
    let totalBytes = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.size;
    }
    return {
      fileCount: this.entries.size,
      totalBytes,
      baseDir: this.baseDir,
    };
  }

  private removeEntry(key: string, entry: EphemeralFileEntry): number {
    this.entries.delete(key);
    try {
      if (fs.existsSync(entry.filePath)) {
        fs.unlinkSync(entry.filePath);
      }
    } catch (err) {
      this.logger.warn("Failed to delete ephemeral cache file", {
        filePath: entry.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return entry.size;
  }

  private scanExistingFiles(): void {
    try {
      const videoDirs = fs.readdirSync(this.baseDir, { withFileTypes: true });
      const now = Date.now();
      for (const dirent of videoDirs) {
        if (!dirent.isDirectory()) continue;
        const dirPath = path.join(this.baseDir, dirent.name);
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          const filePath = path.join(dirPath, f.name);
          try {
            const stat = fs.statSync(filePath);
            // Delete orphaned temp/part files immediately on startup
            if (f.name.endsWith(".part") || f.name.endsWith(".ytdl") || now - stat.mtimeMs >= this.ttlMs) {
              fs.unlinkSync(filePath);
              continue;
            }
            const formatId = f.name.replace(/\.[^.]+$/, "");
            const key = this.makeKey(dirent.name, formatId);
            const mimeType = f.name.endsWith(".webm")
              ? "video/webm"
              : f.name.endsWith(".m4a")
                ? "audio/mp4"
                : "video/mp4";
            this.entries.set(key, {
              key,
              filePath,
              size: stat.size,
              mimeType,
              createdAt: stat.birthtimeMs || stat.mtimeMs,
              lastAccessedAt: stat.atimeMs || stat.mtimeMs,
            });
          } catch {
            // Ignore unreadable file
          }
        }
      }
      this.pruneEmptySubdirs();
    } catch {
      // Base dir empty or inaccessible
    }
  }

  private pruneEmptySubdirs(): void {
    try {
      const dirents = fs.readdirSync(this.baseDir, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        const full = path.join(this.baseDir, d.name);
        try {
          if (fs.readdirSync(full).length === 0) {
            fs.rmdirSync(full);
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }
}

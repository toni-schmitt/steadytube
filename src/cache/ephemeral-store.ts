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

/**
 * Parse HTTP Range header per RFC 9110 §14.2:
 * - Unknown range units or unsupported multi-range specs are ignored (returns full 200).
 * - Invalid/out-of-bounds single byte range returns "unsatisfiable" (416).
 */
export function parseHttpRangeHeader(
  rangeHeader: string | null,
  totalSize: number,
): ParsedByteRange | "unsatisfiable" {
  if (!rangeHeader || !rangeHeader.trim()) {
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  const trimmed = rangeHeader.trim();
  // RFC 9110 §14.1.2: ignore unknown range units; ignore multi-range lists (serve full 200)
  if (!/^bytes=/i.test(trimmed) || trimmed.includes(",")) {
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
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

function sanitizeSegment(input: string, label: string): string {
  // Explicitly reject path separators and traversal sequences
  if (input.includes("/") || input.includes("\\") || input.includes("..")) {
    throw new Error(`Invalid ephemeral cache ${label} segment`);
  }
  const cleaned = input.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  if (!cleaned || /^_+$/.test(cleaned)) {
    throw new Error(`Invalid ephemeral cache ${label} segment`);
  }
  return cleaned;
}

export class EphemeralStore {
  private readonly resolvedBaseDir: string;
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
    this.resolvedBaseDir = path.resolve(this.baseDir);
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

  private assertContainedPath(candidatePath: string): string {
    const resolved = path.resolve(candidatePath);
    if (!resolved.startsWith(this.resolvedBaseDir + path.sep)) {
      throw new Error(`Refusing cache path outside base directory: ${candidatePath}`);
    }
    return resolved;
  }

  getPathFor(videoId: string, formatId: string, ext: string): string {
    const safeVideo = sanitizeSegment(videoId, "videoId");
    const safeFormat = sanitizeSegment(formatId, "formatId");
    const safeExt = ext.replace(/^\./, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "bin";
    const videoDir = this.assertContainedPath(path.join(this.resolvedBaseDir, safeVideo));
    fs.mkdirSync(videoDir, { recursive: true });
    return this.assertContainedPath(path.join(videoDir, `${safeFormat}.${safeExt}`));
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
    const safePath = this.assertContainedPath(filePath);
    const stat = fs.statSync(safePath);
    const now = Date.now();
    const key = this.makeKey(videoId, formatId);
    const entry: EphemeralFileEntry = {
      key,
      filePath: safePath,
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
    const totalSize = entry.size;

    const commonHeaders: Record<string, string> = {
      "Content-Type": entry.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=300",
      "X-SteadyTube-Tier": "3-buffer",
    };

    // RFC 9110 §14.2: HEAD returns full metadata (200) rather than 206
    if (req.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          ...commonHeaders,
          "Content-Length": String(totalSize),
        },
      });
    }

    // If-Range: if client sends an If-Range validator we don't match, fall back to full 200
    const ifRange = req.headers.get("if-range");
    const effectiveRangeHeader = ifRange ? null : req.headers.get("range");
    const parsed = parseHttpRangeHeader(effectiveRangeHeader, totalSize);

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

    if (parsed.isPartial) {
      // Backpressure-aware bounded ReadStream so slow players never pull huge files into RAM
      const nodeStream = fs.createReadStream(entry.filePath, {
        start: parsed.start,
        end: parsed.end,
        highWaterMark: 64 * 1024,
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          nodeStream.on("data", (chunk: string | Buffer) => {
            if (closed) return;
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            try {
              controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
              if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                nodeStream.pause();
              }
            } catch {
              closed = true;
              nodeStream.destroy();
            }
          });
          nodeStream.on("end", () => {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // Already closed
              }
            }
          });
          nodeStream.on("error", (err) => {
            if (!closed) {
              closed = true;
              try {
                controller.error(err);
              } catch {
                // Already closed
              }
            }
          });
        },
        pull() {
          nodeStream.resume();
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

    return new Response(Bun.file(entry.filePath), {
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

    for (const [key, entry] of this.entries) {
      if (this.pinnedKeys.has(key)) continue;
      if (now - entry.lastAccessedAt >= this.ttlMs) {
        freedBytes += this.removeEntry(key, entry);
        removedCount++;
      }
    }

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
      baseDir: this.resolvedBaseDir,
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
      const videoDirs = fs.readdirSync(this.resolvedBaseDir, { withFileTypes: true });
      const now = Date.now();
      for (const dirent of videoDirs) {
        if (!dirent.isDirectory()) continue;
        const dirPath = path.join(this.resolvedBaseDir, dirent.name);
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          const filePath = path.join(dirPath, f.name);
          try {
            const stat = fs.statSync(filePath);
            // Delete orphaned staging/temp files and expired entries on startup
            const isStaging =
              f.name.endsWith(".part") ||
              f.name.endsWith(".ytdl") ||
              f.name.endsWith(".downloading") ||
              /\.tmp\.[^.]+$/.test(f.name) ||
              f.name.endsWith(".dash.mp4");
            if (isStaging || now - stat.mtimeMs >= this.ttlMs) {
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
      this.cleanup();
      this.pruneEmptySubdirs();
    } catch {
      // Base dir empty or inaccessible
    }
  }

  private pruneEmptySubdirs(): void {
    try {
      const dirents = fs.readdirSync(this.resolvedBaseDir, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        const full = path.join(this.resolvedBaseDir, d.name);
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

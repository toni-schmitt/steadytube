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

export interface ProgressiveStreamSource {
  readonly videoId: string;
  readonly formatId: string;
  readonly mimeType: string;
  readonly expectedSize: number;
  getReadablePath(): string;
  getAvailableBytes(): number;
  getStatus(): "downloading" | "completed" | "failed";
  getError(): Error | null;
  touch(): void;
  cancel?(reason?: string): void;
  onReaderStart?(): void;
  onReaderEnd?(): void;
  waitForBytes(minBytes: number, signal: AbortSignal | undefined, timeoutMs: number): Promise<void>;
}

const MAX_PROGRESSIVE_SEEK_AHEAD_BYTES = 64 * 1024 * 1024; // 64 MiB

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
  private readonly pinnedCounts = new Map<string, number>();
  private readonly reservedBytesByKey = new Map<string, number>();
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
    const safeVideo = videoId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    const safeFormat = formatId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    return `${safeVideo}:${safeFormat}`;
  }

  pin(key: string): void {
    this.pinnedCounts.set(key, (this.pinnedCounts.get(key) ?? 0) + 1);
  }

  unpin(key: string): void {
    const count = this.pinnedCounts.get(key) ?? 0;
    if (count <= 1) {
      this.pinnedCounts.delete(key);
    } else {
      this.pinnedCounts.set(key, count - 1);
    }
  }

  isPinned(key: string): boolean {
    return (this.pinnedCounts.get(key) ?? 0) > 0;
  }

  getReservedBytes(): number {
    let sum = 0;
    for (const bytes of this.reservedBytesByKey.values()) {
      sum += bytes;
    }
    return sum;
  }

  /**
   * Reserve space in the shared disk budget before starting a Tier 3 writer
   * (progressive download, fallback download, or remux). Evicts unpinned
   * completed entries first if needed to fit within `maxCacheBytes`.
   */
  reserveBytes(key: string, bytes: number): boolean {
    const needed = Math.max(0, Math.ceil(bytes));
    const existingForKey = this.reservedBytesByKey.get(key) ?? 0;
    const otherReserved = this.getReservedBytes() - existingForKey;
    if (otherReserved + needed > this.maxCacheBytes) {
      return false;
    }

    // Fail before evicting unpinned entries if pinned entries already make the reservation impossible
    let pinnedBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.key !== key && this.isPinned(entry.key)) {
        pinnedBytes += entry.size;
      }
    }
    if (pinnedBytes + otherReserved + needed > this.maxCacheBytes) {
      return false;
    }

    // Reserve before cleanup so pruneEmptySubdirs never deletes this video's empty directory
    this.reservedBytesByKey.set(key, needed);

    // Evict expired/LRU unpinned completed entries to make room for reserved writers
    this.cleanup(otherReserved + needed);

    let registeredBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.key !== key) {
        registeredBytes += entry.size;
      }
    }
    if (registeredBytes + otherReserved + needed > this.maxCacheBytes) {
      if (existingForKey > 0) {
        this.reservedBytesByKey.set(key, existingForKey);
      } else {
        this.reservedBytesByKey.delete(key);
      }
      return false;
    }

    return true;
  }

  releaseReservation(key: string): void {
    this.reservedBytesByKey.delete(key);
  }

  /**
   * Remaining disk budget for an unknown-size writer after accounting for pinned
   * entries and other active reservations (evicting unpinned entries as needed).
   */
  getAvailableBudgetFor(key: string): number {
    const existingForKey = this.reservedBytesByKey.get(key) ?? 0;
    const otherReserved = this.getReservedBytes() - existingForKey;
    let pinnedBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.key !== key && this.isPinned(entry.key)) {
        pinnedBytes += entry.size;
      }
    }
    return Math.max(0, this.maxCacheBytes - pinnedBytes - otherReserved);
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

  delete(videoId: string, formatId: string): void {
    const key = this.makeKey(videoId, formatId);
    const entry = this.entries.get(key);
    if (entry) {
      this.removeEntry(key, entry);
    }
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

    const contentLength = parsed.isPartial ? parsed.end - parsed.start + 1 : totalSize;

    if (!parsed.isPartial && totalSize === 0) {
      return new Response(null, {
        status: 200,
        headers: {
          ...commonHeaders,
          "Content-Length": "0",
        },
      });
    }

    // Pin the entry for the lifetime of this stream so quota cleanup cannot
    // unlink it before fs.createReadStream opens the descriptor.
    this.pin(entry.key);
    let unpinned = false;
    const unpinOnce = () => {
      if (!unpinned) {
        unpinned = true;
        this.unpin(entry.key);
      }
    };

    // Backpressure-aware bounded ReadStream so slow players never pull huge files into RAM
    const nodeStream = parsed.isPartial
      ? fs.createReadStream(entry.filePath, {
          start: parsed.start,
          end: parsed.end,
          highWaterMark: 64 * 1024,
        })
      : fs.createReadStream(entry.filePath, {
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
            unpinOnce();
          }
        });
        nodeStream.on("end", () => {
          unpinOnce();
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }
        });
        nodeStream.on("close", () => {
          unpinOnce();
        });
        nodeStream.on("error", (err) => {
          unpinOnce();
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
        unpinOnce();
      },
    });

    const outHeaders: Record<string, string> = {
      ...commonHeaders,
      "Content-Length": String(contentLength),
    };
    if (parsed.isPartial) {
      outHeaders["Content-Range"] = `bytes ${parsed.start}-${parsed.end}/${totalSize}`;
    }

    return new Response(body, {
      status: parsed.isPartial ? 206 : 200,
      headers: outHeaders,
    });
  }

  /**
   * Progressively stream an HTTP Range (or full GET/HEAD) directly from an active
   * Tier 3 download as bytes land on disk, without waiting for the entire file to finish.
   */
  async serveProgressive(
    source: ProgressiveStreamSource,
    req: Request,
    stallTimeoutMs: number,
  ): Promise<Response> {
    source.touch();
    const totalSize = source.expectedSize;
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      return new Response("Tier 3 stream size unknown", { status: 503 });
    }

    const commonHeaders: Record<string, string> = {
      "Content-Type": source.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=300",
      "X-SteadyTube-Tier": "3-stream",
    };

    if (req.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          ...commonHeaders,
          "Content-Length": String(totalSize),
        },
      });
    }

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

    // Fail fast if a seek jumps far ahead of the active sequential download frontier
    if (
      source.getStatus() === "downloading" &&
      parsed.start - source.getAvailableBytes() > MAX_PROGRESSIVE_SEEK_AHEAD_BYTES
    ) {
      return new Response("Requested range too far ahead of progressive download", { status: 503 });
    }

    // Wait until at least the first requested byte is on disk before committing 206/200 headers
    const neededInitialBytes = parsed.start + 1;
    source.onReaderStart?.();
    let readerTrackingActive = true;
    const endReaderTracking = () => {
      if (readerTrackingActive) {
        readerTrackingActive = false;
        source.onReaderEnd?.();
      }
    };

    try {
      await source.waitForBytes(neededInitialBytes, req.signal, stallTimeoutMs);
    } catch {
      endReaderTracking();
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      return new Response("Tier 3 progressive stream unavailable", { status: 503 });
    }

    if (req.signal.aborted) {
      endReaderTracking();
      return new Response(null, { status: 499 });
    }

    if (source.getStatus() === "failed") {
      endReaderTracking();
      return new Response("Tier 3 progressive stream failed", { status: 503 });
    }

    if (source.getAvailableBytes() < neededInitialBytes) {
      endReaderTracking();
      return new Response("Tier 3 progressive stream truncated", { status: 503 });
    }

    // Open FD safely, retrying once if an atomic rename to the final path raced with openSync
    let openFd: number;
    try {
      const firstPath = source.getReadablePath();
      this.assertContainedPath(firstPath);
      openFd = fs.openSync(firstPath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        try {
          const retryPath = source.getReadablePath();
          this.assertContainedPath(retryPath);
          openFd = fs.openSync(retryPath, "r");
        } catch {
          endReaderTracking();
          return new Response("Tier 3 progressive file unavailable", { status: 503 });
        }
      } else {
        endReaderTracking();
        return new Response("Tier 3 progressive file unavailable", { status: 503 });
      }
    }

    // Verify the opened inode actually contains the advertised starting byte (guards against truncation)
    try {
      const initialFdSize = fs.fstatSync(openFd).size;
      if (initialFdSize < neededInitialBytes) {
        fs.closeSync(openFd);
        endReaderTracking();
        source.cancel?.("Tier 3 staging file truncated before stream start");
        return new Response("Tier 3 progressive stream truncated", { status: 503 });
      }
    } catch {
      try {
        fs.closeSync(openFd);
      } catch {
        // Ignore
      }
      endReaderTracking();
      return new Response("Tier 3 progressive file unavailable", { status: 503 });
    }

    const contentLength = parsed.end - parsed.start + 1;
    const signal = req.signal;
    const pinKey = this.makeKey(source.videoId, source.formatId);
    this.pin(pinKey);
    let fd: number | null = openFd;
    let cursor = parsed.start;
    const end = parsed.end;
    let closed = false;
    let unpinned = false;

    const getAbortError = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError");

    const closeFd = () => {
      if (fd !== null) {
        const toClose = fd;
        fd = null;
        try {
          fs.closeSync(toClose);
        } catch {
          // Already closed
        }
      }
      if (!unpinned) {
        unpinned = true;
        this.unpin(pinKey);
      }
      endReaderTracking();
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      closed = true;
      closeFd();
    };
    if (!signal.aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (cursor <= end) {
            if (closed || signal.aborted || fd === null) {
              closeFd();
              if (signal.aborted) {
                try {
                  controller.error(getAbortError());
                } catch {
                  // Already closed
                }
              }
              return;
            }

            source.touch();
            const fdSize = fs.fstatSync(fd).size;
            if (fdSize > cursor) {
              const toRead = Math.min(64 * 1024, fdSize - cursor, end - cursor + 1);
              const buf = Buffer.allocUnsafe(toRead);
              const bytesRead = fs.readSync(fd, buf, 0, toRead, cursor);
              if (bytesRead > 0) {
                cursor += bytesRead;
                controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
                if (cursor > end) {
                  closed = true;
                  closeFd();
                  controller.close();
                }
                return;
              }
              // File reported fdSize > cursor yet read 0 bytes (truncated/reopened concurrently)
              closed = true;
              closeFd();
              source.cancel?.("Tier 3 staging file truncated during read");
              controller.error(new Error("Tier 3 progressive file truncated mid-stream"));
              return;
            }

            const status = source.getStatus();
            if (status === "failed") {
              const err = source.getError() ?? new Error("Tier 3 progressive download failed");
              closed = true;
              closeFd();
              controller.error(err);
              return;
            }
            if (status === "completed") {
              // Re-check inode size once after status transitioned to completed
              if (fd !== null && fs.fstatSync(fd).size > cursor) {
                continue;
              }
              closed = true;
              closeFd();
              controller.error(new Error("Tier 3 progressive stream ended shorter than expected range"));
              return;
            }

            // CRITICAL guard against non-append-only producer truncation:
            // If the producer still advertises >= cursor + 1 bytes while the open inode is
            // shorter, waitForBytes(cursor + 1) would resolve synchronously in a tight
            // microtask loop and hang the event loop. Fail immediately instead.
            if (source.getAvailableBytes() >= cursor + 1) {
              closed = true;
              closeFd();
              source.cancel?.("Tier 3 staging file shorter than advertised bytes");
              controller.error(new Error("Tier 3 progressive file truncated below advertised length"));
              return;
            }

            await source.waitForBytes(cursor + 1, signal, stallTimeoutMs);
          }

          if (!closed) {
            closed = true;
            closeFd();
            controller.close();
          }
        } catch (err) {
          closed = true;
          closeFd();
          try {
            controller.error(signal.aborted ? getAbortError() : err);
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        closed = true;
        closeFd();
      },
    });

    const outHeaders: Record<string, string> = {
      ...commonHeaders,
      "Content-Length": String(contentLength),
    };
    if (parsed.isPartial) {
      outHeaders["Content-Range"] = `bytes ${parsed.start}-${parsed.end}/${totalSize}`;
    }

    return new Response(body, {
      status: parsed.isPartial ? 206 : 200,
      headers: outHeaders,
    });
  }

  cleanup(extraReservedBytes = this.getReservedBytes()): { removedCount: number; freedBytes: number } {
    const now = Date.now();
    let removedCount = 0;
    let freedBytes = 0;

    for (const [key, entry] of this.entries) {
      if (this.isPinned(key)) continue;
      if (now - entry.lastAccessedAt >= this.ttlMs) {
        freedBytes += this.removeEntry(key, entry);
        removedCount++;
      }
    }

    let totalBytes = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.size;
    }

    const effectiveCap = Math.max(0, this.maxCacheBytes - Math.max(0, extraReservedBytes));
    if (totalBytes > effectiveCap) {
      const sorted = [...this.entries.values()].sort(
        (a, b) => a.lastAccessedAt - b.lastAccessedAt,
      );
      for (const entry of sorted) {
        if (totalBytes <= effectiveCap) break;
        if (this.isPinned(entry.key)) continue;
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
          const filePath = path.join(dirPath, f.name);
          if (f.isDirectory()) {
            // Delete orphaned private staging directories (and any -FragN sidecars inside)
            if (f.name.startsWith(".stage-")) {
              try {
                fs.rmSync(filePath, { recursive: true, force: true });
              } catch {
                // Ignore
              }
            }
            continue;
          }
          if (!f.isFile()) continue;
          try {
            const stat = fs.statSync(filePath);
            // Delete orphaned staging/temp files and expired entries on startup
            const isStaging =
              f.name.endsWith(".part") ||
              f.name.endsWith(".ytdl") ||
              f.name.endsWith(".downloading") ||
              /\.tmp\.[^.]+$/.test(f.name) ||
              /-Frag\d+/.test(f.name) ||
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

  private isVideoDirActive(dirName: string): boolean {
    const prefix = `${dirName}:`;
    for (const key of this.pinnedCounts.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    for (const key of this.reservedBytesByKey.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private pruneEmptySubdirs(): void {
    try {
      const dirents = fs.readdirSync(this.resolvedBaseDir, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        if (this.isVideoDirActive(d.name)) continue;
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

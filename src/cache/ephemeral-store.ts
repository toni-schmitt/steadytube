import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";

export interface EphemeralEntryMeta {
  /** Logical client formatId (e.g. "137" or "tier3-v-137") */
  formatId?: string;
  /** Exact MIME type persisted across restarts (prevents .webm audio -> video/webm fallback) */
  mimeType?: string;
  /** Authoritative DASH layout key ("<init>_<index>") */
  layout?: string | null;
  /** Authoritative representation revision (lmt or init/index digest) */
  rev?: string | null;
  /** Upstream source revision (lmt) bound to cold Tier 3 cached tracks */
  sourceRev?: string | null;
  /** Upstream exact content length bound to cold Tier 3 cached tracks (before optional remux) */
  sourceClen?: number;
  /** Audio/variant xtags if present */
  xtags?: string | null;
  initHash?: string;
  indexHash?: string;
}

export interface EphemeralFileEntry {
  key: string;
  filePath: string;
  size: number;
  mimeType: string;
  createdAt: number;
  lastAccessedAt: number;
  meta?: EphemeralEntryMeta;
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
const LOCK_FILENAME = ".steadytube.lock";

// Process-local tracking so a second store instance in the same process never deletes
// live staging directories or active temp artifacts.
const activeStagingDirs = new Set<string>();
const activeStoreLocks = new Map<string, symbol>();

export function registerActiveStagingDir(dirPath: string): void {
  activeStagingDirs.add(path.resolve(dirPath));
}

export function unregisterActiveStagingDir(dirPath: string): void {
  activeStagingDirs.delete(path.resolve(dirPath));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function extractStagingOwnerPid(name: string): number | null {
  const m = /^\.stage-(\d+)-/.exec(name) || /\.pid-(\d+)\.dash\.mp4$/.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Parse HTTP Range header per RFC 9110 §14.2:
 * - Unknown range units, unsupported multi-range specs, and syntactically invalid
 *   byte-range specs (e.g. `bytes=abc`, `bytes=-`) are ignored (returns full 200).
 * - Syntactically valid but unsatisfiable ranges (out of bounds, empty file, `-0`,
 *   or inverted `bytes=500-200`) return `"unsatisfiable"` (416).
 */
export function parseHttpRangeHeader(
  rangeHeader: string | null,
  totalSize: number,
): ParsedByteRange | "unsatisfiable" {
  if (!rangeHeader || !rangeHeader.trim()) {
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  const trimmed = rangeHeader.trim();
  // RFC 9110 §14.1.2 / §14.2: ignore unknown range units and multi-range lists (serve full 200)
  if (!/^bytes=/i.test(trimmed) || trimmed.includes(",")) {
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) {
    // Syntactically invalid byte-range-spec -> ignore per RFC 9110 §14.2
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    // `bytes=-` is syntactically invalid -> ignore per RFC 9110 §14.2
    return { start: 0, end: Math.max(0, totalSize - 1), isPartial: false };
  }
  if (totalSize === 0) {
    return "unsatisfiable";
  }

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Strip leading zeroes BEFORE checking digit length so `bytes=-0000000000000001`
    // resolves to 1 byte rather than saturating, while huge positive suffixes still saturate.
    const trimmedDigits = rawEnd!.replace(/^0+/, "");
    if (trimmedDigits === "") return "unsatisfiable";
    const suffixLen = trimmedDigits.length > 15 ? totalSize : Number(trimmedDigits);
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

export interface EphemeralStoreOptions {
  /** Skip initial startup scan in constructor (call `initialize()` after binding server port) */
  deferScan?: boolean;
}

const META_SIDECAR_SUFFIX = ".meta.json";

function getMetaSidecarPath(filePath: string): string {
  return `${filePath}${META_SIDECAR_SUFFIX}`;
}

function readMetaSidecar(filePath: string): EphemeralEntryMeta | undefined {
  const metaPath = getMetaSidecarPath(filePath);
  try {
    if (!fs.existsSync(metaPath)) return undefined;
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw) as EphemeralEntryMeta;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeMetaSidecar(filePath: string, meta?: EphemeralEntryMeta): void {
  const metaPath = getMetaSidecarPath(filePath);
  if (!meta) {
    try {
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch {
      // Ignore
    }
    return;
  }
  const tmpPath = `${metaPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(meta));
    fs.renameSync(tmpPath, metaPath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore
    }
  }
}

function unlinkWithMetaSidecar(filePath: string): boolean {
  let mediaRemoved = true;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    mediaRemoved = !fs.existsSync(filePath);
  }
  const metaPath = getMetaSidecarPath(filePath);
  try {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {
    // Ignore sidecar unlink errors
  }
  return mediaRemoved && !fs.existsSync(filePath);
}

export class EphemeralStore {
  private readonly resolvedBaseDir: string;
  private readonly entries = new Map<string, EphemeralFileEntry>();
  private readonly retiredEntriesByKey = new Map<string, EphemeralFileEntry[]>();
  private readonly failedUnlinkEntries = new Map<string, EphemeralFileEntry>();
  private readonly retiredPaths = new Set<string>();
  private readonly pinnedCounts = new Map<string, number>();
  private readonly reservedBytesByKey = new Map<string, number>();
  private readonly lockToken = Symbol("ephemeral-store-lock");
  private readonly lockId = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  private ownsCleanupLock = false;
  private initialized = false;
  private closed = false;
  private periodicCleanupIntervalMs: number | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly maxCacheBytes: number,
    private readonly ttlMs: number,
    private readonly logger: Logger = noopLogger,
    options: EphemeralStoreOptions = {},
  ) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.resolvedBaseDir = path.resolve(this.baseDir);
    if (!options.deferScan) {
      this.initialize();
    }
  }

  hasExclusiveLock(): boolean {
    return this.ownsCleanupLock && !this.closed;
  }

  isClosed(): boolean {
    return this.closed;
  }

  initialize(): void {
    if (this.initialized || this.closed) return;
    this.initialized = true;
    this.scanExistingFiles();
  }

  startPeriodicCleanup(intervalMs = 5 * 60 * 1000): void {
    this.periodicCleanupIntervalMs = intervalMs;
    if (this.cleanupTimer || this.closed) return;
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

  /**
   * Mark shutdown in progress: blocks all new lock acquisitions, reservations,
   * and registrations immediately while keeping the current lock held until
   * active disk jobs finish draining, after which `close()` releases the lock.
   */
  beginShutdown(): void {
    this.closed = true;
    this.stopPeriodicCleanup();
  }

  close(): void {
    this.closed = true;
    this.stopPeriodicCleanup();
    this.releaseCleanupLock();
  }

  private tryAcquireCleanupLock(isInitialScan = false): boolean {
    if (this.closed) return false;
    if (this.ownsCleanupLock) return true;
    const existingToken = activeStoreLocks.get(this.resolvedBaseDir);
    if (existingToken && existingToken !== this.lockToken) {
      return false;
    }

    const lockPath = path.join(this.resolvedBaseDir, LOCK_FILENAME);
    const reclaimDir = `${lockPath}.reclaim`;
    const tmpPath = `${lockPath}.tmp-${this.lockId}`;
    const payload = JSON.stringify({ pid: process.pid, lockId: this.lockId, ts: Date.now() });

    const isLockFileStale = (): boolean => {
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number; lockId?: string };
        if (typeof parsed.pid === "number" && parsed.pid > 0) {
          if (parsed.pid !== process.pid && isPidAlive(parsed.pid)) {
            return false;
          }
          if (parsed.pid === process.pid && activeStoreLocks.has(this.resolvedBaseDir)) {
            return false;
          }
          return true;
        }
      } catch {
        // Fall through to mtime age check below
      }
      // Corrupt, partial, or missing-pid lock file: only treat as stale if aged >2s so we never
      // displace a freshly-created legacy lockfile mid-write.
      try {
        const st = fs.statSync(lockPath);
        return Date.now() - st.mtimeMs > 2000;
      } catch {
        return false;
      }
    };

    const claimOwnership = (): boolean => {
      try {
        const verified = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { lockId?: string };
        if (verified.lockId !== this.lockId) return false;
      } catch {
        return false;
      }
      activeStoreLocks.set(this.resolvedBaseDir, this.lockToken);
      this.ownsCleanupLock = true;
      // Standby takeover after startup: rebuild disk inventory under the newly acquired lock
      // and ensure periodic cleanup is running BEFORE admitting any new writes.
      if (!isInitialScan && this.initialized) {
        this.rescanExistingFilesUnderLock();
        if (this.periodicCleanupIntervalMs !== null && !this.cleanupTimer && !this.closed) {
          this.startPeriodicCleanup(this.periodicCleanupIntervalMs);
        }
      }
      return true;
    };

    try {
      // Write full JSON payload into a private temp file FIRST so `lockPath` NEVER appears
      // empty to contenders; `linkSync` atomically publishes the complete file or fails EEXIST.
      const fd = fs.openSync(tmpPath, "wx");
      try {
        fs.writeFileSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }

      try {
        fs.linkSync(tmpPath, lockPath);
        return claimOwnership();
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
          return false;
        }
      }

      if (!isLockFileStale()) {
        return false;
      }

      // Serialize stale-lock reclaim via atomic `mkdirSync(reclaimDir)` so two contenders
      // can NEVER race on unlinking and replacing a newly-published live owner's lock.
      let holdsReclaim = false;
      try {
        fs.mkdirSync(reclaimDir);
        holdsReclaim = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          // Clean up an abandoned reclaim dir left behind by a crashed reclaimer (>10s old)
          try {
            const st = fs.statSync(reclaimDir);
            if (Date.now() - st.mtimeMs > 10_000) {
              fs.rmdirSync(reclaimDir);
              fs.mkdirSync(reclaimDir);
              holdsReclaim = true;
            }
          } catch {
            return false;
          }
        }
      }
      if (!holdsReclaim) return false;

      try {
        // Re-check staleness INSIDE the serialized reclaim guard before unlinking
        if (fs.existsSync(lockPath) && !isLockFileStale()) {
          return false;
        }
        try {
          if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        } catch {
          return false;
        }
        try {
          fs.linkSync(tmpPath, lockPath);
        } catch {
          return false;
        }
        return claimOwnership();
      } finally {
        try {
          fs.rmdirSync(reclaimDir);
        } catch {
          // Ignore
        }
      }
    } catch {
      return false;
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore
      }
    }
  }

  private releaseCleanupLock(): void {
    if (!this.ownsCleanupLock) return;
    this.ownsCleanupLock = false;
    if (activeStoreLocks.get(this.resolvedBaseDir) === this.lockToken) {
      activeStoreLocks.delete(this.resolvedBaseDir);
    }
    const lockPath = path.join(this.resolvedBaseDir, LOCK_FILENAME);
    try {
      if (fs.existsSync(lockPath)) {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { lockId?: string };
        // Only remove the lockfile if it still belongs to THIS store instance
        if (parsed.lockId === this.lockId) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // Ignore
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
      const retired = this.retiredEntriesByKey.get(key);
      if (retired) {
        this.retiredEntriesByKey.delete(key);
        const liveEntry = this.entries.get(key);
        for (const entry of retired) {
          this.retiredPaths.delete(entry.filePath);
          if (liveEntry && liveEntry.filePath === entry.filePath) continue;
          if (this.ownsCleanupLock) {
            if (!unlinkWithMetaSidecar(entry.filePath)) {
              this.failedUnlinkEntries.set(entry.filePath, entry);
            }
          }
        }
        if (this.ownsCleanupLock) {
          this.pruneEmptySubdirs();
        }
      }
    } else {
      this.pinnedCounts.set(key, count - 1);
    }
  }

  isPinned(key: string): boolean {
    return (this.pinnedCounts.get(key) ?? 0) > 0;
  }

  isRetired(key: string, filePath?: string): boolean {
    if (filePath && this.retiredPaths.has(path.resolve(filePath))) {
      return true;
    }
    return this.retiredEntriesByKey.has(key);
  }

  getReservedBytes(): number {
    let sum = 0;
    for (const bytes of this.reservedBytesByKey.values()) {
      sum += bytes;
    }
    return sum;
  }

  private getRetiredBytes(): number {
    let sum = 0;
    for (const list of this.retiredEntriesByKey.values()) {
      for (const entry of list) {
        sum += entry.size;
      }
    }
    for (const entry of this.failedUnlinkEntries.values()) {
      sum += entry.size;
    }
    return sum;
  }

  /**
   * Reserve space in the shared disk budget before starting a Tier 3 writer
   * (progressive download, fallback download, or remux). Evicts unpinned
   * completed entries first if needed to fit within `maxCacheBytes`.
   * Requires exclusive cache-directory ownership so a second daemon cannot
   * evict or over-subscribe the primary daemon's cache.
   */
  reserveBytes(key: string, bytes: number): boolean {
    if (this.closed) return false;
    if (!this.ownsCleanupLock && !this.tryAcquireCleanupLock()) {
      return false;
    }
    const needed = Math.max(0, Math.ceil(bytes));
    const existingForKey = this.reservedBytesByKey.get(key) ?? 0;
    const otherReserved = this.getReservedBytes() - existingForKey;
    const retiredBytes = this.getRetiredBytes();
    if (retiredBytes + otherReserved + needed > this.maxCacheBytes) {
      return false;
    }

    // Fail before evicting unpinned entries if pinned/retired entries already make reservation impossible
    let pinnedBytes = retiredBytes;
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

    let registeredBytes = retiredBytes;
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
   * entries, retired pinned entries, and other active reservations.
   */
  getAvailableBudgetFor(key: string): number {
    if (this.closed) return 0;
    if (!this.ownsCleanupLock && !this.tryAcquireCleanupLock()) {
      return 0;
    }
    const existingForKey = this.reservedBytesByKey.get(key) ?? 0;
    const otherReserved = this.getReservedBytes() - existingForKey;
    let pinnedBytes = this.getRetiredBytes();
    for (const entry of this.entries.values()) {
      if (entry.key !== key && this.isPinned(entry.key)) {
        pinnedBytes += entry.size;
      }
    }
    return Math.max(0, this.maxCacheBytes - pinnedBytes - otherReserved);
  }

  register(
    videoId: string,
    formatId: string,
    filePath: string,
    mimeType: string,
    meta?: EphemeralEntryMeta,
  ): EphemeralFileEntry {
    if (this.closed) {
      throw new Error("EphemeralStore is closed");
    }
    const safePath = this.assertContainedPath(filePath);
    if (this.retiredPaths.has(safePath)) {
      throw new Error(`Refusing to re-register retired cache path: ${safePath}`);
    }
    const stat = fs.statSync(safePath);
    const now = Date.now();
    const key = this.makeKey(videoId, formatId);
    const prev = this.entries.get(key);
    if (prev && prev.filePath !== safePath) {
      if (this.isPinned(key)) {
        const list = this.retiredEntriesByKey.get(key) ?? [];
        list.push(prev);
        this.retiredEntriesByKey.set(key, list);
        this.retiredPaths.add(prev.filePath);
      } else if (this.ownsCleanupLock) {
        // Unpinned replacement at a different path: unlink previous file so it is never orphaned
        this.removeEntry(key, prev);
      }
    }
    const mergedMeta: EphemeralEntryMeta = {
      formatId,
      mimeType,
      ...(meta ?? {}),
    };
    if (this.ownsCleanupLock) {
      writeMetaSidecar(safePath, mergedMeta);
    }
    const entry: EphemeralFileEntry = {
      key,
      filePath: safePath,
      size: stat.size,
      mimeType,
      createdAt: now,
      lastAccessedAt: now,
      meta: mergedMeta,
    };
    this.failedUnlinkEntries.delete(safePath);
    this.entries.set(key, entry);
    this.cleanup();
    return entry;
  }

  delete(videoId: string, formatId: string): void {
    this.deleteByKey(this.makeKey(videoId, formatId));
  }

  deleteByKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (this.isPinned(key)) {
      // Retire from lookup immediately, but defer unlink and accounting release until
      // the last active reader unpins this key so readers and disk budget stay consistent.
      this.entries.delete(key);
      const list = this.retiredEntriesByKey.get(key) ?? [];
      list.push(entry);
      this.retiredEntriesByKey.set(key, list);
      this.retiredPaths.add(entry.filePath);
      return;
    }
    if (!this.ownsCleanupLock) {
      this.entries.delete(key);
      return;
    }
    this.removeEntry(key, entry);
  }

  get(videoId: string, formatId: string): EphemeralFileEntry | null {
    return this.getByKey(this.makeKey(videoId, formatId));
  }

  getByKey(key: string): EphemeralFileEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.retiredPaths.has(entry.filePath) || !fs.existsSync(entry.filePath)) {
      this.entries.delete(key);
      return null;
    }
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  /**
   * Iterate live entries belonging to `videoId` (used for representation-verified lookup
   * across immutable per-representation storage keys).
   */
  findEntriesForVideo(videoId: string): EphemeralFileEntry[] {
    const safeVideo = videoId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    const prefix = `${safeVideo}:`;
    const out: EphemeralFileEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (this.retiredPaths.has(entry.filePath) || !fs.existsSync(entry.filePath)) {
        this.entries.delete(key);
        continue;
      }
      out.push(entry);
    }
    return out;
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
          "Content-Length": "0",
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

    // Open the descriptor synchronously BEFORE committing 200/206 headers so
    // evicted/unlinked files return a clean 503 instead of a truncated 206 stream.
    let openFd: number;
    try {
      this.assertContainedPath(entry.filePath);
      openFd = fs.openSync(entry.filePath, "r");
    } catch {
      return new Response("Cached stream expired; reload required", { status: 503 });
    }

    // Pin the entry for the lifetime of this open descriptor so quota cleanup or
    // explicit retirement keeps disk accounting accurate until the reader closes.
    this.pin(entry.key);
    let fd: number | null = openFd;
    let cursor = parsed.start;
    const end = parsed.end;
    let closed = false;
    let unpinned = false;
    const signal = req.signal;

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
        this.unpin(entry.key);
      }
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      closed = true;
      closeFd();
    };
    if (signal.aborted) {
      closed = true;
      closeFd();
      return new Response(null, { status: 499 });
    }
    signal.addEventListener("abort", onAbort, { once: true });

    // Backpressure-aware bounded reads directly from the opened FD
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (closed || signal.aborted || fd === null) {
          closeFd();
          if (signal.aborted) {
            try {
              controller.error(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("The operation was aborted.", "AbortError"),
              );
            } catch {
              // Already closed
            }
          }
          return;
        }
        try {
          const toRead = Math.min(64 * 1024, end - cursor + 1);
          const buf = Buffer.allocUnsafe(toRead);
          const bytesRead = fs.readSync(fd, buf, 0, toRead, cursor);
          if (bytesRead <= 0) {
            closed = true;
            closeFd();
            controller.error(new Error("Cached ephemeral file truncated mid-stream"));
            return;
          }
          cursor += bytesRead;
          controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
          if (cursor > end) {
            closed = true;
            closeFd();
            controller.close();
          }
        } catch (err) {
          closed = true;
          closeFd();
          try {
            controller.error(err);
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
          "Content-Length": "0",
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
    // Never evict or unlink files from disk unless this instance owns the exclusive cacheDir lock.
    if (!this.ownsCleanupLock || this.closed) {
      return { removedCount: 0, freedBytes: 0 };
    }
    const now = Date.now();
    let removedCount = 0;
    let freedBytes = 0;

    // First retry any previously failed unlinks so stuck files stay accounted until actually removed
    for (const [failedPath, failedEntry] of [...this.failedUnlinkEntries]) {
      if (unlinkWithMetaSidecar(failedPath)) {
        this.failedUnlinkEntries.delete(failedPath);
        freedBytes += failedEntry.size;
        removedCount++;
      }
    }

    for (const [key, entry] of this.entries) {
      if (this.isPinned(key)) continue;
      if (now - entry.lastAccessedAt >= this.ttlMs) {
        const freed = this.removeEntry(key, entry);
        if (freed > 0) {
          freedBytes += freed;
          removedCount++;
        }
      }
    }

    let totalBytes = this.getRetiredBytes();
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
        if (freed > 0) {
          totalBytes -= freed;
          freedBytes += freed;
          removedCount++;
        }
      }
    }

    this.pruneEmptySubdirs();

    if (removedCount > 0) {
      this.logger.info("Ephemeral cache cleaned up", { removedCount, freedBytes });
    }
    return { removedCount, freedBytes };
  }

  getStats(): { fileCount: number; totalBytes: number; baseDir: string } {
    let totalBytes = this.getRetiredBytes();
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
    if (!this.ownsCleanupLock) {
      return 0;
    }
    if (!unlinkWithMetaSidecar(entry.filePath)) {
      this.failedUnlinkEntries.set(entry.filePath, entry);
      this.logger.warn("Failed to delete ephemeral cache file; keeping disk bytes accounted", {
        filePath: entry.filePath,
        size: entry.size,
      });
      return 0;
    }
    this.failedUnlinkEntries.delete(entry.filePath);
    return entry.size;
  }

  private scanExistingFiles(): void {
    const canCleanStaging = this.tryAcquireCleanupLock(true);
    if (!canCleanStaging) {
      this.logger.warn("Another SteadyTube instance owns cacheDir; running read-only without evicting or cleaning staging files", {
        baseDir: this.resolvedBaseDir,
      });
    }
    this.performDiskScan(canCleanStaging, false);
  }

  private rescanExistingFilesUnderLock(): void {
    this.performDiskScan(true, true);
  }

  private performDiskScan(canCleanStaging: boolean, preservePinnedExisting: boolean): void {
    if (preservePinnedExisting) {
      for (const key of [...this.entries.keys()]) {
        if (!this.isPinned(key)) {
          this.entries.delete(key);
        }
      }
    }
    try {
      const videoDirs = fs.readdirSync(this.resolvedBaseDir, { withFileTypes: true });
      const now = Date.now();
      for (const dirent of videoDirs) {
        if (!dirent.isDirectory()) continue;
        if (dirent.name.startsWith(".")) continue;
        const dirPath = path.join(this.resolvedBaseDir, dirent.name);
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const f of files) {
          const filePath = path.join(dirPath, f.name);
          if (f.isDirectory()) {
            // Delete orphaned private staging directories ONLY when we own the cache lock
            // and the staging owner process is verified dead (and not active in this process).
            if (canCleanStaging && f.name.startsWith(".stage-")) {
              const resolvedStage = path.resolve(filePath);
              if (activeStagingDirs.has(resolvedStage)) continue;
              const ownerPid = extractStagingOwnerPid(f.name);
              if (ownerPid !== null && ownerPid !== process.pid && isPidAlive(ownerPid)) {
                continue;
              }
              try {
                fs.rmSync(filePath, { recursive: true, force: true });
              } catch {
                // Ignore
              }
            }
            continue;
          }
          if (!f.isFile()) continue;
          // Metadata sidecars are loaded alongside their media file (or cleaned if orphaned)
          if (f.name.endsWith(META_SIDECAR_SUFFIX)) {
            if (canCleanStaging) {
              const mediaPath = filePath.slice(0, -META_SIDECAR_SUFFIX.length);
              if (!fs.existsSync(mediaPath)) {
                try {
                  fs.unlinkSync(filePath);
                } catch {
                  // Ignore
                }
              }
            }
            continue;
          }
          try {
            const stat = fs.statSync(filePath);
            // Delete orphaned staging/temp files and expired entries on startup
            const isStaging =
              f.name.endsWith(".part") ||
              f.name.endsWith(".ytdl") ||
              f.name.endsWith(".downloading") ||
              /\.tmp\.[^.]+$/.test(f.name) ||
              f.name.endsWith(".tmp") ||
              /-Frag\d+/.test(f.name) ||
              f.name.endsWith(".dash.mp4");
            if (isStaging) {
              if (!canCleanStaging) continue;
              const ownerPid = extractStagingOwnerPid(f.name);
              if (ownerPid !== null && ownerPid !== process.pid && isPidAlive(ownerPid)) {
                continue;
              }
              unlinkWithMetaSidecar(filePath);
              continue;
            }
            if (now - stat.mtimeMs >= this.ttlMs) {
              if (canCleanStaging) {
                unlinkWithMetaSidecar(filePath);
              }
              continue;
            }
            const formatId = f.name.replace(/\.[^.]+$/, "");
            const key = this.makeKey(dirent.name, formatId);
            if (this.retiredPaths.has(path.resolve(filePath))) {
              continue;
            }
            const inferredMime = f.name.endsWith(".webm")
              ? "video/webm"
              : f.name.endsWith(".m4a")
                ? "audio/mp4"
                : "video/mp4";
            const meta = readMetaSidecar(filePath);
            const mimeType = meta?.mimeType || inferredMime;
            if (!preservePinnedExisting || !this.entries.has(key)) {
              this.entries.set(key, {
                key,
                filePath,
                size: stat.size,
                mimeType,
                createdAt: stat.birthtimeMs || stat.mtimeMs,
                lastAccessedAt: stat.atimeMs || stat.mtimeMs,
                meta,
              });
            }
          } catch {
            // Ignore unreadable file
          }
        }
      }
      if (canCleanStaging) {
        this.cleanup();
        this.pruneEmptySubdirs();
      }
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
    for (const key of this.retiredEntriesByKey.keys()) {
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

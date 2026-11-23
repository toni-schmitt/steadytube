interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  bytes: number;
}

export interface TtlLruCacheOptions<V> {
  maxTotalBytes?: number;
  sizeOf?: (value: V) => number;
}

export class TtlLruCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();
  private totalBytes = 0;
  private readonly maxTotalBytes: number | null;
  private readonly sizeOf: ((value: V) => number) | null;

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
    options: TtlLruCacheOptions<V> = {},
  ) {
    this.maxTotalBytes = options.maxTotalBytes ?? null;
    this.sizeOf = options.sizeOf ?? null;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.removeKey(key);
      return undefined;
    }
    // Refresh LRU position
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    if (ttlMs <= 0) return;
    const entryBytes = this.sizeOf ? Math.max(0, this.sizeOf(value)) : 0;
    if (this.maxTotalBytes !== null && entryBytes > this.maxTotalBytes) {
      return;
    }
    if (this.store.has(key)) {
      this.removeKey(key);
    }
    this.evictToFit(entryBytes);
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      bytes: entryBytes,
    });
    this.totalBytes += entryBytes;
  }

  delete(key: K): boolean {
    return this.removeKey(key);
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.store.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.removeKey(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Single-flight cache lookup/populate: concurrent callers for the same key
   * share a single in-flight promise.
   */
  async getOrCompute(
    key: K,
    compute: () => Promise<{ value: V; ttlMs?: number; cache?: boolean }>,
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await compute();
        if (result.cache !== false) {
          this.set(key, result.value, result.ttlMs ?? this.defaultTtlMs);
        }
        return result.value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  private removeKey(key: K): boolean {
    const existing = this.store.get(key);
    if (!existing) return false;
    this.store.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
    return true;
  }

  private evictToFit(incomingBytes: number): void {
    const needsCountEviction = this.store.size >= this.maxEntries;
    const needsByteEviction =
      this.maxTotalBytes !== null && this.totalBytes + incomingBytes > this.maxTotalBytes;
    if (!needsCountEviction && !needsByteEviction) return;

    this.pruneExpired();
    while (
      this.store.size >= this.maxEntries ||
      (this.maxTotalBytes !== null && this.totalBytes + incomingBytes > this.maxTotalBytes)
    ) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.removeKey(oldestKey);
    }
  }
}

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error("Semaphore maxConcurrency must be >= 1");
    }
  }

  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const release = await this.acquirePermit(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Acquire a semaphore permit and return an idempotent release function.
   * Useful for background lifecycles (e.g. progressive downloads) that outlive
   * the initial request handler.
   */
  async acquirePermit(timeoutMs?: number): Promise<() => void> {
    await this.acquire(timeoutMs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private acquire(timeoutMs?: number): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const grant = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.active++;
        resolve();
      };
      this.queue.push(grant);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(grant);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error(`Semaphore acquire timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

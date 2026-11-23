interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlLruCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    if (ttlMs <= 0) return;
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
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

  private evictOldest(): void {
    // First try pruning expired entries
    this.pruneExpired();
    while (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
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

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquirePermit();
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
  async acquirePermit(): Promise<() => void> {
    await this.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

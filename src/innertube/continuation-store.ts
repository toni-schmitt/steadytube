import crypto from "node:crypto";
import { TtlLruCache } from "../cache/memory-cache.ts";

/**
 * Stores opaque short-TTL continuation states (youtubei.js feed/comments/search
 * objects) behind URL-safe tokens so Invidious-style `continuation=<token>`
 * pagination works cleanly for channels, comments, comment replies, and search.
 */
export class ContinuationStore<T = unknown> {
  private readonly cache: TtlLruCache<string, T>;

  constructor(maxEntries = 500, ttlMs = 15 * 60 * 1000) {
    this.cache = new TtlLruCache<string, T>(maxEntries, ttlMs);
  }

  put(value: T): string {
    const token = crypto.randomBytes(12).toString("base64url");
    this.cache.set(token, value);
    return token;
  }

  get(token: string): T | undefined {
    return this.cache.get(token);
  }

  delete(token: string): void {
    this.cache.delete(token);
  }
}

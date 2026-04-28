/**
 * LRU + TTL cache for built DslIndex trees, with per-key in-flight promise
 * coalescing so concurrent cache misses only trigger a single downstream fetch.
 *
 * The cache key is the `itemId` that was used as the root for fetching the DSL
 * from Pixso — this gives us one cached tree per "root fetch context".
 */

import type { DslIndex } from "./dslIndex.js";

interface Entry {
  key: string;
  index: DslIndex;
  expiresAt: number;
}

export interface TreeCacheOptions {
  /** Maximum number of trees kept in memory. */
  max: number;
  /** TTL in ms for each entry. */
  ttlMs: number;
}

export class TreeCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<DslIndex>>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(opts: TreeCacheOptions) {
    this.max = Math.max(1, opts.max);
    this.ttlMs = Math.max(1000, opts.ttlMs);
  }

  /**
   * Look up any cached tree that contains the given guid. Returns the first
   * fresh entry whose index has a hit. Entries are LRU-touched on hit.
   */
  findByGuid(guid: string): DslIndex | null {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        continue;
      }
      if (entry.index.has(guid)) {
        // LRU touch: re-insert to move to the tail.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.index;
      }
    }
    return null;
  }

  /** Get a fresh entry by key (the itemId used to fetch). */
  get(key: string): DslIndex | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.index;
  }

  set(key: string, index: DslIndex): void {
    const entry: Entry = {
      key,
      index,
      expiresAt: Date.now() + this.ttlMs,
    };
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    // evict oldest while exceeding capacity
    while (this.entries.size > this.max) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /**
   * Run `builder` if the key is not cached; concurrent callers for the same key
   * share the same in-flight promise so we never hit Pixso twice.
   *
   * `forceRefresh=true` bypasses any cached entry but still coalesces concurrent
   * refreshes.
   */
  async getOrBuild(
    key: string,
    builder: () => Promise<DslIndex>,
    forceRefresh = false
  ): Promise<DslIndex> {
    if (!forceRefresh) {
      const hit = this.get(key);
      if (hit) return hit;
    } else {
      this.invalidate(key);
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const idx = await builder();
        this.set(key, idx);
        return idx;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

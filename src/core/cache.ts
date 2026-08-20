import { LRUCache } from "lru-cache";
import process from "node:process";
import { log } from "./logger.js";

export interface CacheStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export interface CacheStats {
  maxEntries: number;
  ttlMs: number;
  size: number;
  inFlightComputations: number;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  resets: number;
  coalescedRequests: number;
  hitRatePercent: number;
}

export type CacheSource = "cache" | "compute" | "coalesced";

export interface CacheGetOrComputeResult<T> {
  value: T;
  source: CacheSource;
}

interface InFlightEntry {
  promise: Promise<unknown>;
  generation: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 300_000; // 5 minutes

export class CacheStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cache: LRUCache<string, any>;
  private inFlight = new Map<string, InFlightEntry>();
  private maxEntries: number;
  private ttlMs: number;
  private generation = 0;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private resets = 0;
  private coalescedRequests = 0;

  constructor(options?: CacheStoreOptions) {
    this.maxEntries = options?.maxEntries ?? this.determineMaxEntries();
    this.ttlMs = options?.ttlMs ?? this.determineTtlMs();

    this.cache = new LRUCache<string, any>({
      max: this.maxEntries,
      ttl: this.ttlMs,
      allowStale: false,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
      ttlAutopurge: false,
    });
  }

  private determineMaxEntries(): number {
    const raw = process.env.MCP_CACHE_MAX_ENTRIES;
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000) {
        return parsed;
      }
      log("warn", "invalid_cache_max_entries_override", {
        provided: raw,
        message: "MCP_CACHE_MAX_ENTRIES must be an integer between 1 and 10000. Using default.",
      });
    }
    return DEFAULT_MAX_ENTRIES;
  }

  private determineTtlMs(): number {
    const raw = process.env.MCP_CACHE_TTL_MS;
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed >= 1000 && parsed <= 86400000) {
        return parsed;
      }
      log("warn", "invalid_cache_ttl_override", {
        provided: raw,
        message: "MCP_CACHE_TTL_MS must be an integer between 1000 and 86400000. Using default.",
      });
    }
    return DEFAULT_TTL_MS;
  }

  public get<T>(key: string): T | undefined {
    const val = this.cache.get(key);
    if (val !== undefined) {
      this.hits++;
      return val as T;
    }
    this.misses++;
    return undefined;
  }

  public set<T>(key: string, value: T, ttlMs?: number): void {
    this.cache.set(key, value, { ttl: ttlMs });
    this.sets++;
  }

  public delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.deletes++;
    }
    return deleted;
  }

  public reset(): void {
    this.generation++;
    this.cache.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.coalescedRequests = 0;
    this.resets++;
  }

  public getStats(): CacheStats {
    const totalQueries = this.hits + this.misses;
    const hitRatePercent =
      totalQueries > 0 ? Number(((this.hits / totalQueries) * 100).toFixed(2)) : 0;

    return {
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      size: this.cache.size,
      inFlightComputations: this.inFlight.size,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      resets: this.resets,
      coalescedRequests: this.coalescedRequests,
      hitRatePercent,
    };
  }

  public async getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    ttlMs?: number
  ): Promise<CacheGetOrComputeResult<T>> {
    // 1. Fast path: check in-memory cache
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.hits++;
      return { value: cached as T, source: "cache" };
    }

    // 2. Single-flight check: attach to existing in-flight promise if available
    const existingInFlight = this.inFlight.get(key);
    if (existingInFlight) {
      this.coalescedRequests++;
      this.misses++;
      const value = (await existingInFlight.promise) as T;
      return { value, source: "coalesced" };
    }

    // 3. Cache miss: capture computation generation to guard against reset races
    this.misses++;
    const computationGeneration = this.generation;

    let resolvePromise!: (val: T) => void;
    let rejectPromise!: (err: unknown) => void;
    const computationPromise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    this.inFlight.set(key, {
      promise: computationPromise,
      generation: computationGeneration,
    });

    (async () => {
      try {
        const result = await compute();
        // Only write to cache if the generation hasn't changed (no reset occurred during compute)
        if (this.generation === computationGeneration) {
          this.set(key, result, ttlMs);
        }
        resolvePromise(result);
      } catch (err) {
        rejectPromise(err);
      } finally {
        // Only delete inFlight entry if it still points to this specific computation promise
        const currentEntry = this.inFlight.get(key);
        if (currentEntry?.promise === computationPromise) {
          this.inFlight.delete(key);
        }
      }
    })();

    const value = await computationPromise;
    return { value, source: "compute" };
  }
}

// Module-scoped singleton instance
const globalCache = new CacheStore();

export function cacheGet<T>(key: string): T | undefined {
  return globalCache.get<T>(key);
}

export function cacheSet<T>(key: string, value: T, ttlMs?: number): void {
  globalCache.set<T>(key, value, ttlMs);
}

export function cacheDelete(key: string): boolean {
  return globalCache.delete(key);
}

export function resetCache(): void {
  globalCache.reset();
}

export function getCacheStats(): CacheStats {
  return globalCache.getStats();
}

export function cacheGetOrCompute<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs?: number
): Promise<CacheGetOrComputeResult<T>> {
  return globalCache.getOrCompute<T>(key, compute, ttlMs);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheStore } from "../src/core/cache.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("TEST A — Cache Hit / Miss tracking and basic lifecycle", async () => {
  const cache = new CacheStore({ maxEntries: 2, ttlMs: 5000 });

  // Initial lookup: Miss
  const initialGet = cache.get("key1");
  assert.equal(initialGet, undefined);

  // Set value
  cache.set("key1", "value1");

  // Subsequent lookup: Hit
  const hitGet = cache.get("key1");
  assert.equal(hitGet, "value1");

  const stats = cache.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.sets, 1);
  assert.equal(stats.size, 1);
  assert.equal(stats.hitRatePercent, 50.0);
});

test("TEST B — True LRU Eviction behavior", async () => {
  const cache = new CacheStore({ maxEntries: 2, ttlMs: 5000 });

  // Insert A and B
  cache.set("A", 1);
  cache.set("B", 2);
  assert.equal(cache.getStats().size, 2);

  // Access A to make it most recently used (B is now oldest/LRU)
  const aVal = cache.get("A");
  assert.equal(aVal, 1);

  // Insert C -> Should evict B
  cache.set("C", 3);

  assert.equal(cache.get("A"), 1, "A should be preserved as recently accessed");
  assert.equal(cache.get("C"), 3, "C should be present");
  assert.equal(cache.get("B"), undefined, "B should have been evicted by LRU policy");

  const stats = cache.getStats();
  assert.equal(stats.size, 2);
});

test("TEST C — TTL Expiration", async () => {
  const cache = new CacheStore({ maxEntries: 10, ttlMs: 50 }); // 50ms TTL

  cache.set("tempKey", "active");

  // Immediate get: Hit
  assert.equal(cache.get("tempKey"), "active");

  // Wait 80ms for TTL to expire
  await delay(80);

  // Get after TTL: Undefined (Miss)
  assert.equal(cache.get("tempKey"), undefined);
});

test("TEST D — Single-Flight / Request Coalescing (Stampede Prevention)", async () => {
  const cache = new CacheStore({ maxEntries: 10, ttlMs: 5000 });
  let computeCallCount = 0;

  const expensiveCompute = async (): Promise<number> => {
    computeCallCount++;
    await delay(60); // simulate slow compute
    return 42;
  };

  // Launch 3 simultaneous concurrent requests for the same key
  const [res1, res2, res3] = await Promise.all([
    cache.getOrCompute("heavy-calc", expensiveCompute),
    cache.getOrCompute("heavy-calc", expensiveCompute),
    cache.getOrCompute("heavy-calc", expensiveCompute),
  ]);

  assert.equal(res1.value, 42);
  assert.equal(res2.value, 42);
  assert.equal(res3.value, 42);

  // Compute must execute EXACTLY ONCE
  assert.equal(computeCallCount, 1, "Compute callback must be executed exactly once");

  const sources = [res1.source, res2.source, res3.source];
  const computeCount = sources.filter((s) => s === "compute").length;
  const coalescedCount = sources.filter((s) => s === "coalesced").length;

  assert.equal(computeCount, 1, "Exactly one caller is the primary compute");
  assert.equal(coalescedCount, 2, "Other concurrent callers are coalesced");

  const stats = cache.getStats();
  assert.equal(stats.coalescedRequests, 2);
  assert.equal(stats.inFlightComputations, 0, "in-flight computations map must be clean");
  assert.equal(stats.size, 1);
});

test("TEST E — Failed compute is not cached and cleans up in-flight state", async () => {
  const cache = new CacheStore({ maxEntries: 10, ttlMs: 5000 });
  let attempt = 0;

  const failingCompute = async (): Promise<string> => {
    attempt++;
    if (attempt === 1) {
      throw new Error("Temporary compute failure");
    }
    return "success";
  };

  // First call fails
  await assert.rejects(async () => {
    await cache.getOrCompute("fail-key", failingCompute);
  }, /Temporary compute failure/);

  assert.equal(cache.getStats().inFlightComputations, 0, "in-flight state must be cleaned on error");
  assert.equal(cache.get("fail-key"), undefined, "Error must not be stored in cache");

  // Second call succeeds
  const successRes = await cache.getOrCompute("fail-key", failingCompute);
  assert.equal(successRes.value, "success");
  assert.equal(successRes.source, "compute");
  assert.equal(cache.get("fail-key"), "success");
});

test("TEST F — Reset while compute is in flight (Generation / Epoch Race Prevention)", async () => {
  const cache = new CacheStore({ maxEntries: 10, ttlMs: 5000 });

  let resolveCompute!: (val: string) => void;
  const slowComputePromise = new Promise<string>((resolve) => {
    resolveCompute = resolve;
  });

  // Start in-flight computation
  const getOrComputePromise = cache.getOrCompute("key-f", () => slowComputePromise);

  // Trigger cache reset while compute is actively pending
  cache.reset();
  assert.equal(cache.getStats().size, 0);

  // Now resolve the old computation
  resolveCompute("stale-result");
  const result = await getOrComputePromise;

  // Caller gets the result
  assert.equal(result.value, "stale-result");

  // But the stale result MUST NOT have populated the reset cache
  assert.equal(cache.get("key-f"), undefined, "Stale result from pre-reset generation must not be cached");
  assert.equal(cache.getStats().size, 0, "Cache size must remain 0");
});

test("TEST G — Old computation must not delete new in-flight computation", async () => {
  const cache = new CacheStore({ maxEntries: 10, ttlMs: 5000 });

  let resolveGen1!: (val: string) => void;
  const gen1Promise = new Promise<string>((resolve) => {
    resolveGen1 = resolve;
  });

  let resolveGen2!: (val: string) => void;
  const gen2Promise = new Promise<string>((resolve) => {
    resolveGen2 = resolve;
  });

  // 1. Start generation 1 compute
  const caller1 = cache.getOrCompute("key-g", () => gen1Promise);

  // 2. Reset cache
  cache.reset();

  // 3. Start generation 2 compute for the same key
  const caller2 = cache.getOrCompute("key-g", () => gen2Promise);

  assert.equal(cache.getStats().inFlightComputations, 1, "Gen 2 computation is active in inFlight");

  // 4. Resolve generation 1 compute
  resolveGen1("gen1-value");
  const res1 = await caller1;
  assert.equal(res1.value, "gen1-value");

  // 5. Verify Gen 2 in-flight entry was NOT deleted by Gen 1 finally block
  assert.equal(
    cache.getStats().inFlightComputations,
    1,
    "Gen 2 in-flight entry must be preserved after Gen 1 finishes"
  );

  // 6. Resolve generation 2 compute
  resolveGen2("gen2-value");
  const res2 = await caller2;
  assert.equal(res2.value, "gen2-value");

  // 7. Verify cache now contains ONLY the Gen 2 value
  assert.equal(cache.get("key-g"), "gen2-value", "Cache must contain the fresh Gen 2 value");
  assert.equal(cache.getStats().size, 1);
  assert.equal(cache.getStats().inFlightComputations, 0);
});

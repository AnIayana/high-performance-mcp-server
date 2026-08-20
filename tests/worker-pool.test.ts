import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WorkerPool } from "../src/workers/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("TEST A — Worker unexpected error/exit single replacement and invariant", async (t) => {
  const crashScriptPath = path.resolve(__dirname, "fixtures/crash.worker.ts");
  const pool = new WorkerPool({
    workerCount: 2,
    workerScriptPath: crashScriptPath,
    taskTimeoutMs: 5000,
  });

  try {
    pool.initialize();
    const initialStats = pool.getStats();
    assert.equal(initialStats.configuredWorkers, 2);
    assert.equal(initialStats.totalWorkers, 2);
    assert.equal(initialStats.restartedWorkers, 0);

    // Execute task that will cause worker crash
    await assert.rejects(async () => {
      await pool.execute("count_primes", { limit: 100 });
    });

    // Wait briefly for exit event and single replacement
    await delay(150);

    const statsAfter = pool.getStats();
    assert.equal(statsAfter.configuredWorkers, 2);
    assert.equal(statsAfter.totalWorkers, 2, "totalWorkers MUST remain exactly 2 (no double replacement)");
    assert.equal(statsAfter.restartedWorkers, 1, "restartedWorkers MUST be exactly 1");
    assert.equal(statsAfter.failedTasks, 1, "failedTasks MUST be counted exactly once");
  } finally {
    await pool.close();
  }
});

test("TEST B — Timeout / terminate single replacement and failure count", async (t) => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 2,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 100, // short 100ms timeout for testing
  });

  try {
    pool.initialize();
    const initialStats = pool.getStats();
    assert.equal(initialStats.configuredWorkers, 2);
    assert.equal(initialStats.totalWorkers, 2);

    // Execute task that will hang and trigger timeout
    await assert.rejects(async () => {
      await pool.execute("count_primes", { limit: 100 });
    }, /timed out/i);

    // Wait briefly for termination and exit event replacement
    await delay(150);

    const statsAfter = pool.getStats();
    assert.equal(statsAfter.configuredWorkers, 2);
    assert.equal(statsAfter.totalWorkers, 2, "totalWorkers MUST remain exactly 2 after timeout");
    assert.equal(statsAfter.restartedWorkers, 1, "restartedWorkers MUST be exactly 1");
    assert.equal(statsAfter.timedOutTasks, 1, "timedOutTasks MUST be 1");
    assert.equal(statsAfter.failedTasks, 1, "failedTasks MUST be 1 (not double-counted)");
  } finally {
    await pool.close();
  }
});

test("TEST C — Normal workload deterministic prime counting and stability", async (t) => {
  // Uses default compute.worker script or built bundle
  const defaultWorkerPath = path.resolve(__dirname, "../src/workers/compute.worker.ts");
  const pool = new WorkerPool({
    workerCount: 3,
    workerScriptPath: defaultWorkerPath,
    taskTimeoutMs: 5000,
  });

  try {
    pool.initialize();
    const res = await pool.execute("count_primes", { limit: 100 });

    assert.equal(res.limit, 100);
    assert.equal(res.primeCount, 25); // exactly 25 primes <= 100

    const stats = pool.getStats();
    assert.equal(stats.totalWorkers, 3);
    assert.equal(stats.completedTasks, 1);
    assert.equal(stats.failedTasks, 0);
    assert.equal(stats.restartedWorkers, 0);
  } finally {
    await pool.close();
  }
});

test("TEST D — Response ID mismatch rejection and worker recovery", async (t) => {
  const mismatchScriptPath = path.resolve(__dirname, "fixtures/mismatch.worker.ts");
  const pool = new WorkerPool({
    workerCount: 2,
    workerScriptPath: mismatchScriptPath,
    taskTimeoutMs: 5000,
  });

  try {
    pool.initialize();

    // Execute task where worker returns wrong ID
    await assert.rejects(async () => {
      await pool.execute("count_primes", { limit: 100 });
    }, /response ID mismatch/i);

    // Wait for worker termination and replacement
    await delay(150);

    const stats = pool.getStats();
    assert.equal(stats.totalWorkers, 2, "totalWorkers MUST remain exactly 2");
    assert.equal(stats.restartedWorkers, 1, "unreliable worker must be replaced exactly once");
    assert.equal(stats.failedTasks, 1, "failedTasks MUST be 1");
  } finally {
    await pool.close();
  }
});

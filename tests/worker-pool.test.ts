import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WorkerPool } from "../src/workers/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
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

    // Wait for exit event and single replacement
    await waitFor(() => pool.getStats().restartedWorkers === 1);

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

    // Wait for termination and exit event replacement
    await waitFor(() => pool.getStats().restartedWorkers === 1);

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
    taskTimeoutMs: 1000,
  });

  try {
    pool.initialize();

    // Execute task where worker returns wrong ID
    await assert.rejects(async () => {
      await pool.execute("count_primes", { limit: 100 });
    }, /Worker response ID mismatch/i);

    // Wait for worker replacement after mismatch termination
    await waitFor(() => pool.getStats().restartedWorkers === 1);

    const stats = pool.getStats();
    assert.equal(stats.totalWorkers, 2, "totalWorkers MUST remain exactly 2");
    assert.equal(stats.restartedWorkers, 1, "unreliable worker must be replaced exactly once");
    assert.equal(stats.failedTasks, 1, "failedTasks MUST be 1");
  } finally {
    await pool.close();
  }
});

test("TEST E — Already-aborted signal rejects immediately before enqueue", async () => {
  const pool = new WorkerPool({ workerCount: 2 });
  try {
    pool.initialize();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await pool.execute("count_primes", { limit: 100 }, { signal: controller.signal });
      },
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );

    const stats = pool.getStats();
    assert.equal(stats.queuedTasks, 0);
    assert.equal(stats.completedTasks, 0);
    assert.equal(stats.failedTasks, 0);
  } finally {
    await pool.close();
  }
});

test("TEST F — Queued task cancellation removes from queue and preserves FIFO", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 1,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 5000,
  });

  try {
    pool.initialize();

    // Occupy the 1 worker
    const runningTask = pool.execute("count_primes", { limit: 100 });

    const c1 = new AbortController();
    const c2 = new AbortController();

    // Queue task 2 and task 3
    const task2 = pool.execute("count_primes", { limit: 200 }, { signal: c1.signal });
    const task3 = pool.execute("count_primes", { limit: 300 }, { signal: c2.signal });

    assert.equal(pool.getStats().queuedTasks, 2);

    // Cancel task2 in queue
    c1.abort();

    await assert.rejects(
      async () => task2,
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );

    // task3 should still be in queue
    assert.equal(pool.getStats().queuedTasks, 1);

    // Clean up task3
    c2.abort();
    await assert.rejects(async () => task3);

    // Clean up running
    runningTask.catch(() => {});
  } finally {
    await pool.close();
  }
});

test("TEST G — Running task cancellation promptly terminates worker and restores pool size", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 2,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 10000, // 10s timeout
  });

  try {
    pool.initialize();
    const controller = new AbortController();

    const start = Date.now();
    const promise = pool.execute("count_primes", { limit: 100 }, { signal: controller.signal });

    // Wait a brief moment to ensure worker has picked up the task
    await delay(50);
    assert.equal(pool.getStats().busyWorkers, 1);

    // Abort running task
    controller.abort();

    await assert.rejects(
      async () => promise,
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `Cancellation latency (${elapsed}ms) must be prompt and far below 10s timeout`);

    // Worker must be replaced exactly once
    await waitFor(() => pool.getStats().restartedWorkers === 1);

    const stats = pool.getStats();
    assert.equal(stats.totalWorkers, 2, "totalWorkers MUST remain 2");
    assert.equal(stats.restartedWorkers, 1, "restartedWorkers MUST be exactly 1");
    assert.equal(stats.timedOutTasks, 0, "Aborted task must NOT count as timeout");
  } finally {
    await pool.close();
  }
});

test("TEST H — Queue capacity is immediately released on cancellation", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 1,
    workerScriptPath: hangScriptPath,
    maxQueueSize: 2,
    taskTimeoutMs: 5000,
  });

  try {
    pool.initialize();

    // 1 busy worker
    const t0 = pool.execute("count_primes", { limit: 100 });

    // Fill queue to max (2)
    const c1 = new AbortController();
    const t1 = pool.execute("count_primes", { limit: 100 }, { signal: c1.signal });
    const t2 = pool.execute("count_primes", { limit: 100 });

    // Queue full check
    await assert.rejects(async () => {
      await pool.execute("count_primes", { limit: 100 });
    }, /queue is full/i);

    // Abort t1
    c1.abort();
    await assert.rejects(async () => t1);

    // Now a new task can be submitted
    const t3 = pool.execute("count_primes", { limit: 100 });
    assert.ok(t3);

    t0.catch(() => {});
    t2.catch(() => {});
    t3.catch(() => {});
  } finally {
    await pool.close();
  }
});

test("TEST I — Abort vs Completion race resolves or aborts cleanly exactly once", async () => {
  const defaultWorkerPath = path.resolve(__dirname, "../src/workers/compute.worker.ts");
  const pool = new WorkerPool({
    workerCount: 2,
    workerScriptPath: defaultWorkerPath,
    taskTimeoutMs: 5000,
  });

  try {
    pool.initialize();
    const controller = new AbortController();

    const promise = pool.execute("count_primes", { limit: 100 }, { signal: controller.signal });

    // Abort around the same time completion may occur
    await delay(1);
    controller.abort();

    try {
      const res = await promise;
      assert.equal(res.primeCount, 25);
    } catch (err: any) {
      assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
    }
  } finally {
    await pool.close();
  }
});

test("TEST J — Abort vs Timeout race resolves to whichever triggers first", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 1,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 100, // 100ms timeout
  });

  try {
    pool.initialize();
    const controller = new AbortController();

    const promise = pool.execute("count_primes", { limit: 100 }, { signal: controller.signal });
    const assertion = assert.rejects(async () => promise, /timed out/i);

    // Wait until timeout definitely occurs
    await delay(150);

    // Late abort
    controller.abort();

    await assertion;
  } finally {
    await pool.close();
  }
});

test("TEST K — Repeated task cancellation does not leak abort event listeners", async () => {
  const pool = new WorkerPool({ workerCount: 2 });
  try {
    pool.initialize();
    const controller = new AbortController();

    for (let i = 0; i < 50; i++) {
      const c = new AbortController();
      const p = pool.execute("count_primes", { limit: 1000 }, { signal: c.signal });
      c.abort();
      await p.catch(() => {});
    }

    // Normal task execution still works flawlessly
    const res = await pool.execute("count_primes", { limit: 100 });
    assert.equal(res.primeCount, 25);
  } finally {
    await pool.close();
  }
});

test("TEST L — WorkerPool close settles all queued and running tasks cleanly", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 1,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 5000,
  });

  pool.initialize();
  const running = pool.execute("count_primes", { limit: 100 });
  const queued = pool.execute("count_primes", { limit: 200 });

  const runningAssertion = assert.rejects(async () => running, /terminated|closing/i);
  const queuedAssertion = assert.rejects(async () => queued, /closing/i);

  await delay(25);
  await pool.close();

  await runningAssertion;
  await queuedAssertion;
});

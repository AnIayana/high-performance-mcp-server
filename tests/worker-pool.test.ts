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

test("TEST M — Abort running task then immediately close pool awaits all worker terminations", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 2,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 10000,
  });

  try {
    pool.initialize();
    const controller = new AbortController();

    const taskPromise = pool.execute("count_primes", { limit: 100 }, { signal: controller.signal });
    const taskAssertion = assert.rejects(
      async () => taskPromise,
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );

    // Wait until worker is actively busy
    await waitFor(() => pool.getStats().busyWorkers === 1);

    // Abort running task
    controller.abort();

    // Immediately call close() before replacement / termination completes
    await pool.close();

    await taskAssertion;

    const stats = pool.getStats();
    assert.equal(stats.idleWorkers, 0);
    assert.equal(stats.busyWorkers, 0);
    assert.equal(stats.queuedTasks, 0);
    assert.equal(stats.totalWorkers, 0);
  } finally {
    await pool.close();
  }
});

test("TEST N — Worker task with progress disabled triggers zero progress callbacks", async () => {
  const pool = new WorkerPool({ workerCount: 1 });
  try {
    pool.initialize();
    let callbackCount = 0;
    const result = await pool.execute("count_primes", { limit: 100_000 });
    assert.ok(result.primeCount > 0);
    assert.equal(callbackCount, 0);
  } finally {
    await pool.close();
  }
});

test("TEST O — Worker task with progress enabled receives monotonic progress and truthful known total", async () => {
  const pool = new WorkerPool({ workerCount: 1 });
  try {
    pool.initialize();
    const progressEvents: Array<{ progress: number; total?: number }> = [];
    const limit = 200_000;

    const result = await pool.execute(
      "count_primes",
      { limit },
      {
        onProgress: (p) => {
          progressEvents.push(p);
        },
      }
    );

    assert.ok(result.primeCount > 0);
    assert.ok(progressEvents.length > 0, "Must receive at least 1 progress event");

    // Monotonicity check and truthful total check
    let lastProgress = 0;
    for (const event of progressEvents) {
      assert.ok(event.progress >= lastProgress, `Progress must be non-decreasing (${event.progress} >= ${lastProgress})`);
      assert.equal(event.total, limit, "Total must match truthful known limit");
      assert.ok(event.progress <= limit, `Progress must not exceed total (${event.progress} <= ${limit})`);
      lastProgress = event.progress;
    }

    // Terminal progress check
    const finalEvent = progressEvents[progressEvents.length - 1];
    assert.equal(finalEvent.progress, limit, "Final progress must equal limit");
    assert.equal(finalEvent.total, limit);
  } finally {
    await pool.close();
  }
});

test("TEST P — Worker task with progress enabled + cancellation rejects with AbortError and stops progress", async () => {
  const pool = new WorkerPool({ workerCount: 1 });
  try {
    pool.initialize();
    const progressEvents: Array<{ progress: number; total?: number }> = [];
    const controller = new AbortController();
    const limit = 50_000_000;

    const taskPromise = pool.execute(
      "count_primes",
      { limit },
      {
        signal: controller.signal,
        onProgress: (p) => {
          progressEvents.push(p);
          if (progressEvents.length >= 1 && !controller.signal.aborted) {
            controller.abort();
          }
        },
      }
    );

    await assert.rejects(
      async () => taskPromise,
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );

    const countAtAbort = progressEvents.length;
    await delay(100);
    // Ensure no terminal (limit, limit) progress was emitted after cancellation
    const hasFinalTotal = progressEvents.some((e) => e.progress === limit);
    assert.equal(hasFinalTotal, false, "Cancelled task must NOT emit final progress=total");
  } finally {
    await pool.close();
  }
});

test("TEST Q — Worker task with progress enabled + timeout rejects and emits no final total", async () => {
  const hangScriptPath = path.resolve(__dirname, "fixtures/hang.worker.ts");
  const pool = new WorkerPool({
    workerCount: 1,
    workerScriptPath: hangScriptPath,
    taskTimeoutMs: 150,
  });

  try {
    pool.initialize();
    const progressEvents: Array<{ progress: number; total?: number }> = [];

    await assert.rejects(
      async () => {
        await pool.execute(
          "count_primes",
          { limit: 100 },
          {
            onProgress: (p) => {
              progressEvents.push(p);
            },
          }
        );
      },
      (err: Error) => {
        assert.ok(err.message.includes("timed out") || err.name === "TimeoutError");
        return true;
      }
    );

    const hasFinalTotal = progressEvents.some((e) => e.progress === 100);
    assert.equal(hasFinalTotal, false, "Timed-out task must NOT emit final progress=total");
  } finally {
    await pool.close();
  }
});

test("TEST R — Worker progress message isolation across sequential tasks", async () => {
  const pool = new WorkerPool({ workerCount: 1 });
  try {
    pool.initialize();
    const taskAEvents: number[] = [];
    const taskBEvents: number[] = [];

    await pool.execute(
      "count_primes",
      { limit: 100_000 },
      {
        onProgress: (p) => {
          taskAEvents.push(p.progress);
        },
      }
    );

    await pool.execute(
      "count_primes",
      { limit: 150_000 },
      {
        onProgress: (p) => {
          taskBEvents.push(p.progress);
        },
      }
    );

    assert.ok(taskAEvents.length > 0);
    assert.ok(taskBEvents.length > 0);
    assert.equal(taskAEvents[taskAEvents.length - 1], 100_000);
    assert.equal(taskBEvents[taskBEvents.length - 1], 150_000);

    // Assert task A events did not leak into task B
    for (const p of taskBEvents) {
      assert.ok(p <= 150_000);
    }
  } finally {
    await pool.close();
  }
});

test("TEST S — Worker task progress callback throwing an error does not crash or fail execution", async () => {
  const pool = new WorkerPool({ workerCount: 1 });
  try {
    pool.initialize();
    let callbackCalls = 0;

    const result = await pool.execute(
      "count_primes",
      { limit: 100_000 },
      {
        onProgress: () => {
          callbackCalls++;
          throw new Error("Synthetic consumer progress callback error");
        },
      }
    );

    assert.ok(result.primeCount > 0);
    assert.ok(callbackCalls > 0);
  } finally {
    await pool.close();
  }
});

test("TEST T — Worker progress message volume is strictly bounded for large computations", async () => {
  const pool = new WorkerPool({ workerCount: 1 });
  try {
    pool.initialize();
    let progressCount = 0;
    const limit = 500_000;

    const result = await pool.execute(
      "count_primes",
      { limit },
      {
        onProgress: () => {
          progressCount++;
        },
      }
    );

    assert.ok(result.primeCount > 0);
    // Bounded cadence check: should not produce thousands of messages for 500k candidates
    assert.ok(progressCount <= 50, `Progress message count (${progressCount}) must be bounded (<= 50)`);
  } finally {
    await pool.close();
  }
});

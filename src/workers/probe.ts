import { performance } from "node:perf_hooks";

export interface ProbedExecutionResult<T> {
  result: T;
  computeDurationMs: number;
  eventLoopProbeDelayMs: number;
}

/**
 * Runs a computational task while measuring event loop responsiveness using a concurrent 20ms timer probe.
 * On main-thread execution, the timer is delayed by the blocking CPU work.
 * On worker-thread execution, the event loop remains responsive and the probe delay remains near 0.
 */
export async function runWithEventLoopProbe<T>(
  taskFn: () => Promise<T> | T
): Promise<ProbedExecutionResult<T>> {
  let timerFiredAt = 0;
  const probeStart = performance.now();
  const expectedFireTime = probeStart + 20;

  const timerPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      timerFiredAt = performance.now();
      resolve();
    }, 20);
  });

  const computeStart = performance.now();
  const result = await taskFn();
  const computeDurationMs = Number((performance.now() - computeStart).toFixed(2));

  await timerPromise;
  const delay = timerFiredAt - expectedFireTime;
  const eventLoopProbeDelayMs = Number((delay > 0 ? delay : 0).toFixed(2));

  return {
    result,
    computeDurationMs,
    eventLoopProbeDelayMs,
  };
}

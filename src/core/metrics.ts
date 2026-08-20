import { monitorEventLoopDelay } from "node:perf_hooks";
import process from "node:process";

export interface ToolMetrics {
  calls: number;
  successes: number;
  errors: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
}

export interface ToolMetricsWithAverage extends ToolMetrics {
  averageDurationMs: number;
}

export interface EventLoopMetrics {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ServerMetricsSnapshot {
  processUptimeSeconds: number;
  totalToolCalls: number;
  totalToolErrors: number;
  eventLoopDelayMs: EventLoopMetrics;
  tools: Record<string, ToolMetricsWithAverage>;
}

// Module-scoped singleton metrics store
const toolMetricsStore = new Map<string, ToolMetrics>();

// Event loop delay monitoring
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

function nsToMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0;
  return Number((nanoseconds / 1_000_000).toFixed(2));
}

function getOrCreateToolMetrics(toolName: string): ToolMetrics {
  let metrics = toolMetricsStore.get(toolName);
  if (!metrics) {
    metrics = {
      calls: 0,
      successes: 0,
      errors: 0,
      totalDurationMs: 0,
      minDurationMs: Number.POSITIVE_INFINITY,
      maxDurationMs: 0,
      lastDurationMs: 0,
    };
    toolMetricsStore.set(toolName, metrics);
  }
  return metrics;
}

/**
 * Records a successful execution of a tool.
 */
export function recordToolSuccess(toolName: string, durationMs: number): void {
  const metrics = getOrCreateToolMetrics(toolName);
  metrics.calls += 1;
  metrics.successes += 1;
  metrics.totalDurationMs += durationMs;
  metrics.lastDurationMs = Number(durationMs.toFixed(2));
  if (durationMs < metrics.minDurationMs) {
    metrics.minDurationMs = Number(durationMs.toFixed(2));
  }
  if (durationMs > metrics.maxDurationMs) {
    metrics.maxDurationMs = Number(durationMs.toFixed(2));
  }
}

/**
 * Records a failed execution of a tool.
 */
export function recordToolError(toolName: string, durationMs: number): void {
  const metrics = getOrCreateToolMetrics(toolName);
  metrics.calls += 1;
  metrics.errors += 1;
  metrics.totalDurationMs += durationMs;
  metrics.lastDurationMs = Number(durationMs.toFixed(2));
  if (durationMs < metrics.minDurationMs) {
    metrics.minDurationMs = Number(durationMs.toFixed(2));
  }
  if (durationMs > metrics.maxDurationMs) {
    metrics.maxDurationMs = Number(durationMs.toFixed(2));
  }
}

/**
 * Returns a point-in-time snapshot of cumulative tool performance and event-loop lag metrics.
 */
export function getMetricsSnapshot(): ServerMetricsSnapshot {
  let totalCalls = 0;
  let totalErrors = 0;
  const toolsRecord: Record<string, ToolMetricsWithAverage> = {};

  for (const [name, raw] of toolMetricsStore.entries()) {
    totalCalls += raw.calls;
    totalErrors += raw.errors;

    const avg = raw.calls > 0 ? Number((raw.totalDurationMs / raw.calls).toFixed(2)) : 0;
    const min = raw.calls > 0 && raw.minDurationMs !== Number.POSITIVE_INFINITY ? raw.minDurationMs : 0;

    toolsRecord[name] = {
      calls: raw.calls,
      successes: raw.successes,
      errors: raw.errors,
      totalDurationMs: Number(raw.totalDurationMs.toFixed(2)),
      minDurationMs: min,
      maxDurationMs: raw.maxDurationMs,
      lastDurationMs: raw.lastDurationMs,
      averageDurationMs: avg,
    };
  }

  const eventLoopDelaySnapshot: EventLoopMetrics = {
    mean: nsToMs(eventLoopDelay.mean),
    p50: nsToMs(eventLoopDelay.percentile(50)),
    p95: nsToMs(eventLoopDelay.percentile(95)),
    p99: nsToMs(eventLoopDelay.percentile(99)),
    max: nsToMs(eventLoopDelay.max),
  };

  return {
    processUptimeSeconds: Number(process.uptime().toFixed(2)),
    totalToolCalls: totalCalls,
    totalToolErrors: totalErrors,
    eventLoopDelayMs: eventLoopDelaySnapshot,
    tools: toolsRecord,
  };
}

/**
 * Resets all accumulated tool performance metrics and event-loop histograms.
 */
export function resetMetrics(): void {
  toolMetricsStore.clear();
  eventLoopDelay.reset();
}

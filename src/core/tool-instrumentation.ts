import { performance } from "node:perf_hooks";
import { log } from "./logger.js";
import { recordToolError, recordToolSuccess } from "./metrics.js";

/**
 * Higher-order function wrapping an MCP tool handler with duration measurement,
 * metrics recording, and structured logging without altering its signature or behavior.
 */
export function withToolMetrics<TArgs, TResult, TContext = unknown>(
  toolName: string,
  handler: (args: TArgs, extra?: TContext) => Promise<TResult>
): (args: TArgs, extra?: TContext) => Promise<TResult> {
  return async (args: TArgs, extra?: TContext): Promise<TResult> => {
    const start = performance.now();
    try {
      const result = await handler(args, extra);
      const durationMs = performance.now() - start;

      recordToolSuccess(toolName, durationMs);
      log("info", "tool_call_completed", {
        tool: toolName,
        durationMs: Number(durationMs.toFixed(2)),
      });

      return result;
    } catch (error) {
      const durationMs = performance.now() - start;

      recordToolError(toolName, durationMs);
      log("error", "tool_call_failed", {
        tool: toolName,
        durationMs: Number(durationMs.toFixed(2)),
        error,
      });

      throw error;
    }
  };
}

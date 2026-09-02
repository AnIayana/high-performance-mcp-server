import { performance } from "node:perf_hooks";
import {
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolStartedEvent,
} from "../logging/sanitization.js";
import { log } from "./logger.js";
import { recordToolError, recordToolSuccess } from "./metrics.js";
import type { ServerContext } from "./server-context.js";

/**
 * Higher-order function wrapping an MCP tool handler with duration measurement,
 * metrics recording, process-local stderr logging, and optional privacy-safe MCP protocol logging.
 */
export function withToolMetrics<TArgs, TResult, TContext = unknown>(
  toolName: string,
  handler: (args: TArgs, extra?: TContext) => Promise<TResult>,
  context?: ServerContext
): (args: TArgs, extra?: TContext) => Promise<TResult> {
  return async (args: TArgs, extra?: TContext): Promise<TResult> => {
    const start = performance.now();
    const server = context?.server;
    const loggingManager = context?.mcpLogging;
    const profile = context?.profile;

    if (server && loggingManager) {
      loggingManager.emitLog(server, extra, createToolStartedEvent(toolName, profile));
    }

    try {
      const result = await handler(args, extra);
      const durationMs = performance.now() - start;

      if (result && typeof result === "object" && (result as any).isError === true) {
        recordToolError(toolName, durationMs);
        log("error", "tool_call_failed", {
          tool: toolName,
          durationMs: Number(durationMs.toFixed(2)),
          error: (result as any).content?.[0]?.text,
        });

        if (server && loggingManager) {
          const errText = (result as any).content?.[0]?.text;
          loggingManager.emitLog(
            server,
            extra,
            createToolFailedEvent(toolName, errText, durationMs, profile)
          );
        }
      } else {
        recordToolSuccess(toolName, durationMs);
        log("info", "tool_call_completed", {
          tool: toolName,
          durationMs: Number(durationMs.toFixed(2)),
        });

        if (server && loggingManager) {
          loggingManager.emitLog(
            server,
            extra,
            createToolCompletedEvent(toolName, durationMs, profile)
          );
        }
      }

      return result;
    } catch (error) {
      const durationMs = performance.now() - start;

      recordToolError(toolName, durationMs);
      log("error", "tool_call_failed", {
        tool: toolName,
        durationMs: Number(durationMs.toFixed(2)),
        error,
      });

      if (server && loggingManager) {
        loggingManager.emitLog(
          server,
          extra,
          createToolFailedEvent(toolName, error, durationMs, profile)
        );
      }

      throw error;
    }
  };
}


import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getMetricsSnapshot } from "../core/metrics.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "server_metrics",
  category: "diagnostics",
  description:
    "Returns cumulative MCP tool execution and event-loop performance metrics for the current server process",
};

/**
 * Registers the 'server_metrics' tool on the provided MCP server instance.
 */
export default function registerServerMetricsTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Server Performance Metrics",
      description: toolMeta.description,
      outputSchema: z.object({
        processUptimeSeconds: z.number().describe("Server process uptime in seconds"),
        totalToolCalls: z.number().describe("Total tool execution requests"),
        totalToolErrors: z.number().describe("Total failed tool execution requests"),
        eventLoopDelayMs: z.object({
          mean: z.number().describe("Mean event loop delay in ms"),
          p50: z.number().describe("50th percentile event loop delay in ms"),
          p95: z.number().describe("95th percentile event loop delay in ms"),
          p99: z.number().describe("99th percentile event loop delay in ms"),
          max: z.number().describe("Maximum event loop delay in ms"),
        }),
        tools: z.record(
          z.string(),
          z.object({
            calls: z.number().describe("Total calls"),
            successes: z.number().describe("Successful calls"),
            errors: z.number().describe("Failed calls"),
            totalDurationMs: z.number().describe("Total execution duration in ms"),
            averageDurationMs: z.number().describe("Average execution duration in ms"),
            minDurationMs: z.number().describe("Minimum execution duration in ms"),
            maxDurationMs: z.number().describe("Maximum execution duration in ms"),
            lastDurationMs: z.number().describe("Last execution duration in ms"),
          })
        ),
      }),
    },
    withToolMetrics("server_metrics", async () => {
      // Capture snapshot at the start of execution so this in-flight call is not included
      const snapshot = getMetricsSnapshot();

      const toolSummaries = Object.entries(snapshot.tools)
        .map(
          ([tool, data]) =>
            `  - ${tool}: ${data.calls} calls (${data.successes} ok, ${data.errors} err) | avg: ${data.averageDurationMs}ms | last: ${data.lastDurationMs}ms`
        )
        .join("\n");

      const textSummary = [
        "=== Server Performance Metrics ===",
        `Process Uptime: ${snapshot.processUptimeSeconds}s`,
        `Total Tool Calls: ${snapshot.totalToolCalls} (Errors: ${snapshot.totalToolErrors})`,
        `Event Loop Delay: mean=${snapshot.eventLoopDelayMs.mean}ms, p50=${snapshot.eventLoopDelayMs.p50}ms, p95=${snapshot.eventLoopDelayMs.p95}ms, p99=${snapshot.eventLoopDelayMs.p99}ms, max=${snapshot.eventLoopDelayMs.max}ms`,
        "Tool Breakdown:",
        toolSummaries || "  (No tool calls recorded yet)",
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: textSummary,
          },
        ],
        structuredContent: snapshot,
      };
    })
  );
}

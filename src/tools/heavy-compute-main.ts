import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { countPrimes } from "../workers/compute.js";
import { runWithEventLoopProbe } from "../workers/probe.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "heavy_compute_main",
  category: "benchmark",
  description:
    "Runs a deterministic CPU-intensive prime calculation directly on the Node.js main thread for benchmarking",
};

/**
 * Registers the 'heavy_compute_main' tool on the provided MCP server instance.
 */
export default function registerHeavyComputeMainTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Heavy Compute - Main Thread",
      description: toolMeta.description,
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(100000)
          .max(5000000)
          .describe("Upper bound integer limit for prime counting (100,000 - 5,000,000)"),
      }),
      outputSchema: z.object({
        mode: z.literal("main").describe("Execution mode"),
        limit: z.number().describe("Upper bound limit used for calculation"),
        primeCount: z.number().describe("Total prime numbers found up to limit"),
        computeDurationMs: z.number().describe("Duration of prime calculation in milliseconds"),
        eventLoopProbeDelayMs: z
          .number()
          .describe("Event loop blocking delay measured by 20ms probe timer"),
      }),
    },
    withToolMetrics(
      "heavy_compute_main",
      async ({ limit }) => {
      const probeResult = await runWithEventLoopProbe(() => countPrimes(limit));

      const structured = {
        mode: "main" as const,
        limit: probeResult.result.limit,
        primeCount: probeResult.result.primeCount,
        computeDurationMs: probeResult.computeDurationMs,
        eventLoopProbeDelayMs: probeResult.eventLoopProbeDelayMs,
      };

      const textSummary = [
        "=== Heavy Compute Result (Main Thread) ===",
        `Mode: Main Thread (Synchronous)`,
        `Limit: ${structured.limit.toLocaleString()}`,
        `Primes Found: ${structured.primeCount.toLocaleString()}`,
        `Compute Duration: ${structured.computeDurationMs}ms`,
        `Event Loop Probe Delay: ${structured.eventLoopProbeDelayMs}ms (BLOCKED)`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: textSummary,
          },
        ],
        structuredContent: structured,
      };
    })
  );
}

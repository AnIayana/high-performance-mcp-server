import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { executeWorkerTask, type WorkerTaskProgress } from "../workers/pool.js";
import { runWithEventLoopProbe } from "../workers/probe.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "heavy_compute_worker",
  category: "benchmark",
  description:
    "Runs the same deterministic CPU-intensive prime calculation using the reusable worker thread pool",
};

/**
 * Registers the 'heavy_compute_worker' tool on the provided MCP server instance.
 */
export default function registerHeavyComputeWorkerTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Heavy Compute - Worker Pool",
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
        mode: z.literal("worker").describe("Execution mode"),
        limit: z.number().describe("Upper bound limit used for calculation"),
        primeCount: z.number().describe("Total prime numbers found up to limit"),
        computeDurationMs: z.number().describe("Duration of prime calculation in milliseconds"),
        eventLoopProbeDelayMs: z
          .number()
          .describe("Event loop blocking delay measured by 20ms probe timer"),
      }),
    },
    withToolMetrics("heavy_compute_worker", async ({ limit }, extra?: any) => {
      const signal = extra?.signal;
      const progressToken =
        extra?.progressToken ?? extra?._meta?.progressToken ?? extra?.mcpReq?._meta?.progressToken;

      let progressChain = Promise.resolve();
      let isSettled = false;

      const onProgress =
        progressToken !== undefined && typeof extra?.sendNotification === "function"
          ? (p: WorkerTaskProgress) => {
              if (isSettled || signal?.aborted) return progressChain;
              progressChain = progressChain.then(async () => {
                if (isSettled || signal?.aborted) return;
                try {
                  await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: p.progress,
                      total: p.total,
                    },
                  });
                } catch {
                  // Auxiliary progress notification delivery error ignored
                }
              });
              return progressChain;
            }
          : undefined;

      try {
        const probeResult = await runWithEventLoopProbe(() =>
          executeWorkerTask("count_primes", { limit }, { signal, onProgress })
        );

        const structured = {
          mode: "worker" as const,
          limit: probeResult.result.limit,
          primeCount: probeResult.result.primeCount,
          computeDurationMs: probeResult.computeDurationMs,
          eventLoopProbeDelayMs: probeResult.eventLoopProbeDelayMs,
        };

        const textSummary = [
          "=== Heavy Compute Result (Worker Thread Pool) ===",
          `Mode: Worker Thread (Asynchronous Offload)`,
          `Limit: ${structured.limit.toLocaleString()}`,
          `Primes Found: ${structured.primeCount.toLocaleString()}`,
          `Compute Duration: ${structured.computeDurationMs}ms`,
          `Event Loop Probe Delay: ${structured.eventLoopProbeDelayMs}ms (RESPONSIVE)`,
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
      } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
          throw error;
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `heavy_compute_worker error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      } finally {
        isSettled = true;
        await progressChain;
      }
    })
  );
}

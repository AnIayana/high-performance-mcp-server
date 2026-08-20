import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { getWorkerPoolStats } from "../workers/pool.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "worker_pool_stats",
  category: "diagnostics",
  description:
    "Returns runtime lifecycle, task queue, and capacity metrics for the reusable Worker Thread Pool",
};

/**
 * Registers the 'worker_pool_stats' tool on the provided MCP server instance.
 */
export default function registerWorkerPoolStatsTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Worker Pool Statistics",
      description: toolMeta.description,
      outputSchema: z.object({
        initialized: z
          .boolean()
          .describe("Whether the worker pool has been lazily initialized"),
        configuredWorkers: z.number().describe("Target number of worker threads"),
        totalWorkers: z.number().describe("Total active worker threads"),
        busyWorkers: z.number().describe("Number of workers currently processing tasks"),
        idleWorkers: z.number().describe("Number of idle workers ready for tasks"),
        queuedTasks: z.number().describe("Number of tasks waiting in queue"),
        completedTasks: z.number().describe("Total successfully completed tasks"),
        failedTasks: z.number().describe("Total failed tasks"),
        timedOutTasks: z.number().describe("Total timed out tasks"),
        restartedWorkers: z
          .number()
          .describe("Total worker restart/replacement events"),
      }),
    },
    withToolMetrics("worker_pool_stats", async () => {
      const stats = getWorkerPoolStats();

      const textSummary = [
        "=== Worker Pool Statistics ===",
        `Initialized: ${stats.initialized}`,
        `Workers: ${stats.totalWorkers} total (${stats.idleWorkers} idle, ${stats.busyWorkers} busy, ${stats.configuredWorkers} target)`,
        `Queue: ${stats.queuedTasks} tasks waiting`,
        `Completed Tasks: ${stats.completedTasks}`,
        `Failed Tasks: ${stats.failedTasks} (Timeouts: ${stats.timedOutTasks})`,
        `Worker Restarts: ${stats.restartedWorkers}`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: textSummary,
          },
        ],
        structuredContent: stats,
      };
    })
  );
}

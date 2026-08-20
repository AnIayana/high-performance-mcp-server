import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { cacheGetOrCompute } from "../core/cache.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { executeWorkerTask } from "../workers/pool.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "cached_prime_count",
  category: "benchmark",
  description:
    "Counts primes using the worker pool and caches deterministic results in the process-level LRU cache",
};

/**
 * Registers the 'cached_prime_count' tool on the provided MCP server instance.
 */
export default function registerCachedPrimeCountTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Cached Prime Count",
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
        limit: z.number().describe("Upper bound limit used for calculation"),
        primeCount: z.number().describe("Total prime numbers found up to limit"),
        source: z
          .enum(["cache", "worker", "coalesced"])
          .describe("Result resolution source: in-memory cache, worker thread compute, or coalesced concurrent request"),
        cacheHit: z.boolean().describe("Whether the result was retrieved from cache"),
        durationMs: z.number().describe("Execution duration in milliseconds"),
      }),
    },
    withToolMetrics("cached_prime_count", async ({ limit }) => {
      const cacheKey = `prime-count:v1:${limit}`;
      const start = performance.now();

      const result = await cacheGetOrCompute(cacheKey, async () => {
        return executeWorkerTask("count_primes", { limit });
      });

      const durationMs = Number((performance.now() - start).toFixed(2));
      const source: "cache" | "worker" | "coalesced" =
        result.source === "compute" ? "worker" : result.source;
      const cacheHit = result.source === "cache";

      const structured = {
        limit: result.value.limit,
        primeCount: result.value.primeCount,
        source,
        cacheHit,
        durationMs,
      };

      const textSummary = [
        "=== Cached Prime Count Result ===",
        `Limit: ${structured.limit.toLocaleString()}`,
        `Primes Found: ${structured.primeCount.toLocaleString()}`,
        `Source: ${structured.source.toUpperCase()}`,
        `Cache Hit: ${structured.cacheHit}`,
        `Duration: ${structured.durationMs}ms`,
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

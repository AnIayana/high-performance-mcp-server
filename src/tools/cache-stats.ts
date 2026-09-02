import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getCacheStats } from "../core/cache.js";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "cache_stats",
  category: "diagnostics",
  description: "Returns runtime statistics for the process-level LRU cache",
};

/**
 * Registers the 'cache_stats' tool on the provided MCP server instance.
 */
export default function registerCacheStatsTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Cache Statistics",
      description: toolMeta.description,
      outputSchema: z.object({
        maxEntries: z.number().describe("Maximum cache capacity"),
        ttlMs: z.number().describe("Default Time-to-Live in milliseconds"),
        size: z.number().describe("Current number of cached entries"),
        inFlightComputations: z.number().describe("Currently pending background computations"),
        hits: z.number().describe("Total successful cache lookups"),
        misses: z.number().describe("Total missed cache lookups"),
        sets: z.number().describe("Total entry insertions"),
        deletes: z.number().describe("Total entry deletions"),
        resets: z.number().describe("Total cache purge operations"),
        coalescedRequests: z.number().describe("Total requests deduplicated via single-flight protection"),
        hitRatePercent: z.number().describe("Cache hit rate percentage (0-100%)"),
      }),
    },
    withToolMetrics(
      "cache_stats",
      async () => {
      const stats = getCacheStats();

      const textSummary = [
        "=== LRU Cache Statistics ===",
        `Entries: ${stats.size} / ${stats.maxEntries} (TTL: ${stats.ttlMs / 1000}s)`,
        `Hit Rate: ${stats.hitRatePercent}% (${stats.hits} hits, ${stats.misses} misses)`,
        `Mutations: ${stats.sets} sets, ${stats.deletes} deletes, ${stats.resets} resets`,
        `Single-Flight Deduplications: ${stats.coalescedRequests} coalesced requests`,
        `In-Flight Computations: ${stats.inFlightComputations}`,
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

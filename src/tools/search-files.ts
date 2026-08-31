import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import {
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_FILES,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_TIMEOUT_MS,
  searchFilesService,
} from "../workspace/search.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "search_files",
  category: "workspace",
  description:
    "Searches file and directory names within an allowed read-only workspace root using bounded literal matching",
};

export default function registerSearchFilesTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Search Files",
      description: toolMeta.description,
      inputSchema: z.object({
        rootId: z.string().describe("The ID of the allowed workspace root (e.g. root-1)"),
        query: z
          .string()
          .min(1)
          .max(MAX_SEARCH_QUERY_LENGTH)
          .describe("Literal substring query to match against file and directory names"),
        path: z
          .string()
          .optional()
          .default(".")
          .describe("Relative start directory within the root (default: '.')"),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether match is case-sensitive (default: false)"),
        kind: z
          .enum(["file", "directory", "all"])
          .optional()
          .default("all")
          .describe("Filter results by entry kind: 'file', 'directory', or 'all' (default: 'all')"),
        includeIgnored: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether to search inside common ignored directories like node_modules or .git (default: false)"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .optional()
          .default(DEFAULT_SEARCH_MAX_RESULTS)
          .describe(`Maximum matching results to return (1..${MAX_SEARCH_RESULTS}, default: ${DEFAULT_SEARCH_MAX_RESULTS})`),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_FILES)
          .optional()
          .default(DEFAULT_SEARCH_MAX_FILES)
          .describe(`Maximum directory entries to scan before stopping (1..${MAX_SEARCH_FILES}, default: ${DEFAULT_SEARCH_MAX_FILES})`),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(MAX_SEARCH_TIMEOUT_MS)
          .optional()
          .default(DEFAULT_SEARCH_TIMEOUT_MS)
          .describe(`Maximum search duration in milliseconds (100..${MAX_SEARCH_TIMEOUT_MS}, default: ${DEFAULT_SEARCH_TIMEOUT_MS})`),
      }),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        query: z.string(),
        caseSensitive: z.boolean(),
        kind: z.enum(["file", "directory", "all"]),
        results: z.array(
          z.object({
            path: z.string(),
            name: z.string(),
            type: z.enum(["file", "directory", "symlink", "other"]),
          })
        ),
        scannedEntries: z.number(),
        matchedEntries: z.number(),
        truncated: z.boolean(),
        stopReason: z.enum(["completed", "max_results", "max_files", "timeout"]),
        durationMs: z.number(),
      }),
    },
    withToolMetrics(toolMeta.name, async (args, extra?: any) => {
      const signal = extra?.signal;
      const progressToken =
        extra?.progressToken ?? extra?._meta?.progressToken ?? extra?.mcpReq?._meta?.progressToken;

      let progressChain = Promise.resolve();
      let isSettled = false;

      const onProgress =
        progressToken !== undefined && typeof extra?.sendNotification === "function"
          ? (scannedCount: number) => {
              if (isSettled || signal?.aborted) return progressChain;
              progressChain = progressChain.then(async () => {
                if (isSettled || signal?.aborted) return;
                try {
                  await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: scannedCount,
                    },
                  });
                } catch {
                  // Ignore progress delivery failure
                }
              });
              return progressChain;
            }
          : undefined;

      try {
        const result = await searchFilesService(
          context?.workspace,
          args.rootId,
          args.query,
          {
            path: args.path,
            caseSensitive: args.caseSensitive,
            kind: args.kind,
            includeIgnored: args.includeIgnored,
            maxResults: args.maxResults,
            maxFiles: args.maxFiles,
            timeoutMs: args.timeoutMs,
            signal,
            onProgress,
          }
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
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
              text: `search_files error: ${error instanceof Error ? error.message : String(error)}`,
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

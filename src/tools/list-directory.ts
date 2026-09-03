import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { listDirectoryService } from "../workspace/service.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "list_directory",
  category: "workspace",
  description: "Lists directory entries inside an allowed read-only workspace root",
};

export default function registerListDirectoryTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "List Directory",
      description: toolMeta.description,
      inputSchema: z.object({
        rootId: z.string().describe("The ID of the allowed workspace root (e.g. root-1)"),
        path: z
          .string()
          .optional()
          .default(".")
          .describe("Relative directory path within the root (default: '.')"),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(1)
          .describe("Maximum recursive subdirectory depth to list (1..5, default: 1)"),
      }),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        totalEntries: z.number(),
        truncated: z.boolean(),
        entries: z.array(
          z.object({
            name: z.string(),
            type: z.enum(["file", "directory", "symlink", "other"]),
            relativePath: z.string().optional(),
          })
        ),
      }),
    },
    withToolMetrics(toolMeta.name, async (args) => {
      try {
        const result = await listDirectoryService(
          context?.workspace,
          args.rootId,
          args.path ?? ".",
          args.maxDepth ?? 1
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `list_directory error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    })
  );
}

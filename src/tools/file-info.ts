import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { getFileInfoService } from "../workspace/service.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "file_info",
  category: "workspace",
  description: "Returns metadata for a file or directory within an allowed workspace root",
};

export default function registerFileInfoTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "File Info",
      description: toolMeta.description,
      inputSchema: z.object({
        rootId: z.string().describe("The ID of the allowed workspace root (e.g. root-1)"),
        path: z.string().describe("Relative path within the root"),
      }),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        type: z.enum(["file", "directory", "symlink", "other"]),
        sizeBytes: z.number(),
        modifiedAt: z.string(),
        createdAt: z.string(),
        isSymlink: z.boolean(),
      }),
    },
    withToolMetrics(toolMeta.name, async (args) => {
      try {
        const result = await getFileInfoService(context?.workspace, args.rootId, args.path);
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
              text: `file_info error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    })
  );
}

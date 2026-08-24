import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { writeTextFileService } from "../workspace/write-service.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "write_text_file",
  category: "workspace_write",
  description:
    "Safely creates a new text file or overwrites an existing text file with optimistic SHA-256 concurrency within an allowlisted workspace root",
};

export default function registerWriteTextFileTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Write Text File",
      description: toolMeta.description,
      inputSchema: z.object({
        rootId: z.string().optional().describe("The ID of the allowed workspace root (e.g. root-1)"),
        path: z.string().min(1).describe("Relative file path within the root"),
        content: z.string().describe("UTF-8 text content to write"),
        create: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set to true to create a new file; false (default) to overwrite an existing file"),
        expectedSha256: z
          .string()
          .optional()
          .describe("Expected 64-character lowercase hex SHA-256 of current file (required when create is false)"),
      }),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        created: z.boolean(),
        bytesWritten: z.number(),
        sha256: z.string(),
        previousSha256: z.string().optional(),
      }),
    },
    withToolMetrics(toolMeta.name, async (args) => {
      try {
        const result = await writeTextFileService(context?.workspace, {
          rootId: args.rootId,
          path: args.path,
          content: args.content,
          create: args.create,
          expectedSha256: args.expectedSha256,
          operatorPolicy: context?.workspacePolicy,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `write_text_file error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    })
  );
}

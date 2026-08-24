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
      inputSchema: z.discriminatedUnion("mode", [
        z.object({
          rootId: z.string().optional().describe("The ID of the allowed workspace root (e.g. root-1)"),
          path: z.string().min(1).describe("Relative file path within the root"),
          mode: z.literal("create").describe("Write mode: create a new file only (fails if file already exists)"),
          content: z.string().describe("UTF-8 text content to write"),
        }),
        z.object({
          rootId: z.string().optional().describe("The ID of the allowed workspace root (e.g. root-1)"),
          path: z.string().min(1).describe("Relative file path within the root"),
          mode: z.literal("overwrite").describe("Write mode: atomically overwrite an existing file (requires expectedSha256)"),
          content: z.string().describe("UTF-8 text content to write"),
          expectedSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/, "expectedSha256 must be a 64-character lowercase hex SHA-256 string")
            .describe("Expected 64-character lowercase hex SHA-256 hash of the existing file"),
        }),
      ]),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        mode: z.enum(["create", "overwrite"]),
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
          mode: args.mode,
          content: args.content,
          expectedSha256: args.mode === "overwrite" ? args.expectedSha256 : undefined,
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

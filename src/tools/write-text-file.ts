import type {
  McpServer,
  ServerContext as McpServerContext,
  CallToolResult,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { requireWorkspaceWriteConfirmation } from "../workspace/write-confirmation.js";
import { resolveWritePathWithinRoot, writeTextFileService } from "../workspace/write-service.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "write_text_file",
  category: "workspace_write",
  description:
    "Safely creates a new text file or overwrites an existing text file with optimistic SHA-256 concurrency within an allowlisted workspace root",
};

export const writeTextFileInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    rootId: z.string().optional().describe("The ID of the allowed workspace root (e.g. root-1)"),
    path: z.string().min(1).describe("Relative file path within the root"),
    mode: z.literal("create").describe("Write mode: create a new file only (fails if file already exists)"),
    content: z.string().describe("UTF-8 text content to write"),
  }),
  z.strictObject({
    rootId: z.string().optional().describe("The ID of the allowed workspace root (e.g. root-1)"),
    path: z.string().min(1).describe("Relative file path within the root"),
    mode: z.literal("overwrite").describe("Write mode: atomically overwrite an existing file (requires expectedSha256)"),
    content: z.string().describe("UTF-8 text content to write"),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "expectedSha256 must be a 64-character lowercase hex SHA-256 string")
      .describe("Expected 64-character lowercase hex SHA-256 hash of the existing file"),
  }),
]);

export default function registerWriteTextFileTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Write Text File",
      description: toolMeta.description,
      inputSchema: writeTextFileInputSchema,
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        mode: z.enum(["create", "overwrite"]),
        bytesWritten: z.number(),
        sha256: z.string(),
        previousSha256: z.string().optional(),
      }),
    },
    withToolMetrics(toolMeta.name, async (args, mcpContext?: McpServerContext): Promise<CallToolResult | InputRequiredResult> => {
      try {
        if (context?.workspacePolicy?.requireWriteConfirmation) {
          const target = await resolveWritePathWithinRoot(
            context.workspace, args.rootId, args.path, args.mode === "create"
          );
          const confirmationResult = requireWorkspaceWriteConfirmation(
            {
              operation: args.mode,
              rootId: target.root.id,
              path: target.relativeToRoot,
              approvalKeyMaterial: {
                tool: toolMeta.name,
                rootId: args.rootId,
                path: args.path,
                mode: args.mode,
                content: args.content,
                expectedSha256: args.mode === "overwrite" ? args.expectedSha256 : undefined,
              },
            },
            mcpContext?.mcpReq.inputResponses
          );
          if (confirmationResult) {
            return confirmationResult;
          }
        }

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
    },
    context)
  );
}

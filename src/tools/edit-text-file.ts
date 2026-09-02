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
import { editTextFileService, resolveWritePathWithinRoot } from "../workspace/write-service.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "edit_text_file",
  category: "workspace_write",
  description:
    "Performs transactional, exact literal text replacements on an existing file within an allowlisted workspace root",
};

export default function registerEditTextFileTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Edit Text File",
      description: toolMeta.description,
      inputSchema: z.object({
        rootId: z.string().optional().describe("The ID of the allowed workspace root (e.g. root-1)"),
        path: z.string().min(1).describe("Relative file path within the root"),
        expectedSha256: z
          .string()
          .min(64)
          .max(64)
          .describe("Expected 64-character lowercase hex SHA-256 hash of the target file before editing"),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).describe("Exact literal text to match and replace"),
              newText: z.string().describe("Literal replacement text to insert"),
              expectedOccurrences: z
                .number()
                .int()
                .min(1)
                .optional()
                .default(1)
                .describe("Expected exact number of occurrences to replace (default: 1)"),
            })
          )
          .min(1)
          .describe("Ordered list of exact literal edits to apply sequentially in memory"),
      }),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        editsApplied: z.number(),
        bytesWritten: z.number(),
        sha256: z.string(),
        previousSha256: z.string(),
      }),
    },
    withToolMetrics(toolMeta.name, async (args, mcpContext?: McpServerContext): Promise<CallToolResult | InputRequiredResult> => {
      try {
        if (context?.workspacePolicy?.requireWriteConfirmation) {
          const target = await resolveWritePathWithinRoot(
            context.workspace, args.rootId, args.path, false
          );
          const confirmationResult = requireWorkspaceWriteConfirmation(
            {
              operation: "edit",
              rootId: target.root.id,
              path: target.relativeToRoot,
              approvalKeyMaterial: {
                tool: toolMeta.name,
                rootId: args.rootId,
                path: args.path,
                expectedSha256: args.expectedSha256,
                edits: args.edits,
              },
            },
            mcpContext?.mcpReq.inputResponses
          );
          if (confirmationResult) {
            return confirmationResult;
          }
        }

        const result = await editTextFileService(context?.workspace, {
          rootId: args.rootId,
          path: args.path,
          expectedSha256: args.expectedSha256,
          edits: args.edits,
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
              text: `edit_text_file error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
    context)
  );
}

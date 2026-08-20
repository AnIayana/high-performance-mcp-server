import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { DEFAULT_TEXT_READ_BYTES, MAX_TEXT_READ_BYTES } from "../workspace/path-security.js";
import { readTextFileService } from "../workspace/service.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "read_text_file",
  category: "workspace",
  description:
    "Reads a text file within an allowed read-only workspace root (UTF-8, up to 1 MiB)",
};

export default function registerReadTextFileTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Read Text File",
      description: toolMeta.description,
      inputSchema: z.object({
        rootId: z.string().describe("The ID of the allowed workspace root (e.g. root-1)"),
        path: z.string().describe("Relative file path within the root"),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_TEXT_READ_BYTES)
          .optional()
          .default(DEFAULT_TEXT_READ_BYTES)
          .describe(
            `Maximum bytes to read (1 to ${MAX_TEXT_READ_BYTES}, default ${DEFAULT_TEXT_READ_BYTES})`
          ),
      }),
      outputSchema: z.object({
        rootId: z.string(),
        path: z.string(),
        text: z.string(),
        bytesRead: z.number(),
        sizeBytes: z.number(),
        truncated: z.boolean(),
        encoding: z.literal("utf-8"),
      }),
    },
    withToolMetrics(toolMeta.name, async (args) => {
      try {
        const result = await readTextFileService(
          context?.workspace,
          args.rootId,
          args.path,
          args.maxBytes ?? DEFAULT_TEXT_READ_BYTES
        );
        return {
          content: [{ type: "text", text: result.text }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `read_text_file error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    })
  );
}

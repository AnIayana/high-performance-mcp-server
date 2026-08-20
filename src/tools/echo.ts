import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "echo",
  category: "safe",
  description: "Echoes back the provided message",
};

/**
 * Registers the 'echo' tool on the provided MCP server instance.
 */
export default function registerEchoTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Echo Tool",
      description: toolMeta.description,
      inputSchema: z.object({
        message: z.string().describe("The message to echo back"),
      }),
    },
    withToolMetrics("echo", async ({ message }) => {
      return {
        content: [
          {
            type: "text",
            text: `Echo: ${message}`,
          },
        ],
      };
    })
  );
}

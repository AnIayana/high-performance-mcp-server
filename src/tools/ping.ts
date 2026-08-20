import type { McpServer } from "@modelcontextprotocol/server";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "ping",
  category: "safe",
  description: "Checks whether the MCP server is responsive",
};

/**
 * Registers the 'ping' tool on the provided MCP server instance.
 */
export default function registerPingTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Ping",
      description: toolMeta.description,
    },
    withToolMetrics("ping", async () => {
      return {
        content: [
          {
            type: "text",
            text: "pong",
          },
        ],
      };
    })
  );
}

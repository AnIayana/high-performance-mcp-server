import type { McpServer } from "@modelcontextprotocol/server";
import { resetMetrics } from "../core/metrics.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "reset_metrics",
  category: "admin",
  description: "Resets cumulative MCP tool execution metrics",
};

/**
 * Registers the 'reset_metrics' tool on the provided MCP server instance.
 * Note: Intentionally not wrapped with withToolMetrics so reset does not count itself.
 */
export default function registerResetMetricsTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Reset Performance Metrics",
      description: toolMeta.description,
    },
    async () => {
      resetMetrics();
      return {
        content: [
          {
            type: "text",
            text: "Performance metrics reset.",
          },
        ],
      };
    }
  );
}

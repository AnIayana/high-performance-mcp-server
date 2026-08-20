import type { McpServer } from "@modelcontextprotocol/server";
import { resetCache } from "../core/cache.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "reset_cache",
  category: "admin",
  description: "Clears all cached entries and resets cache statistics",
};

/**
 * Registers the 'reset_cache' tool on the provided MCP server instance.
 */
export default function registerResetCacheTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Reset Cache",
      description: toolMeta.description,
    },
    async () => {
      resetCache();
      return {
        content: [
          {
            type: "text",
            text: "Cache cleared and statistics reset.",
          },
        ],
      };
    }
  );
}

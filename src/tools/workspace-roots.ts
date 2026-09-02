import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "workspace_roots",
  category: "workspace",
  description:
    "Lists the read-only filesystem roots explicitly allowed for this MCP server instance",
};

export default function registerWorkspaceRootsTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Workspace Roots",
      description: toolMeta.description,
      outputSchema: z.object({
        roots: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
          })
        ),
      }),
    },
    withToolMetrics(toolMeta.name, async () => {
      const roots =
        context?.workspace?.roots.map((r) => ({
          id: r.id,
          name: r.name,
        })) ?? [];

      const result = { roots };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
    context)
  );
}

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { ServerContext } from "../core/server-context.js";
import { detectMimeType } from "../workspace/mime.js";
import { MAX_TEXT_READ_BYTES } from "../workspace/path-security.js";
import { readTextFileService } from "../workspace/service.js";

/**
 * Registers MCP resources onto the server instance based on the active security profile.
 * Only registers filesystem resources when the workspace or all profile is explicitly active.
 */
export function registerResources(
  server: McpServer,
  context?: ServerContext
): void {
  const profile = context?.profile ?? "safe";

  // Only expose workspace resources when the workspace or all profile is enabled
  if (profile !== "workspace" && profile !== "all") {
    return;
  }

  // 1. Static resource: workspace://roots
  server.registerResource(
    "workspace-roots",
    "workspace://roots",
    {
      title: "Allowed Workspace Roots",
      description: "Lists the read-only filesystem roots explicitly allowed for this MCP server instance",
      mimeType: "application/json",
    },
    async (uri) => {
      const roots =
        context?.workspace?.roots.map((r) => ({
          id: r.id,
          name: r.name,
        })) ?? [];

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ roots }, null, 2),
          },
        ],
      };
    }
  );

  // 2. Dynamic resource template: workspace://file/{rootId}{?path}
  server.registerResource(
    "workspace-file",
    new ResourceTemplate("workspace://file/{rootId}{?path}", { list: undefined }),
    {
      title: "Workspace File",
      description: "Read-only text file content within an allowed workspace root",
    },
    async (uri, variables) => {
      const rootId = String(variables.rootId);
      const queryPath = uri.searchParams.get("path");
      const variablePath = typeof variables.path === "string" ? variables.path : undefined;
      const targetPath = queryPath ?? variablePath ?? ".";

      const readResult = await readTextFileService(
        context?.workspace,
        rootId,
        targetPath,
        MAX_TEXT_READ_BYTES
      );

      const mimeType = detectMimeType(targetPath);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType,
            text: readResult.text,
          },
        ],
      };
    }
  );
}

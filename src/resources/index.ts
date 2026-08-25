import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { ServerContext } from "../core/server-context.js";
import { readWorkspaceResourceService } from "../workspace/resource-service.js";

/**
 * Profiles authorized for read-only workspace resources.
 */
const RESOURCE_CAPABLE_PROFILES = new Set(["workspace", "workspace_write", "all"]);

/**
 * Registers MCP resources onto the server instance based on the active security profile.
 * Only registers workspace resource templates when the active profile has workspace read authority
 * (i.e. workspace, workspace_write, all).
 */
export function registerResources(
  server: McpServer,
  context?: ServerContext
): void {
  const profile = context?.profile ?? "safe";

  // Strict profile gating: only workspace-capable profiles expose workspace resources
  if (!RESOURCE_CAPABLE_PROFILES.has(profile)) {
    return;
  }

  // MCP-Native Resource Template: workspace:///{rootId}/{+path}
  server.registerResource(
    "workspace_text_file",
    new ResourceTemplate("workspace:///{rootId}/{+path}", { list: undefined }),
    {
      title: "Workspace Text File",
      description: "Read an allowlisted UTF-8 text file from a configured workspace root.",
      mimeType: "text/plain; charset=utf-8",
    },
    async (uri) => {
      try {
        const result = await readWorkspaceResourceService(
          context?.workspace,
          uri.href,
          context?.workspacePolicy
        );

        return {
          contents: [
            {
              uri: result.uri,
              mimeType: result.mimeType,
              text: result.text,
            },
          ],
        };
      } catch (error) {
        throw new Error(
          `Resource read failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

import { McpServer } from "@modelcontextprotocol/server";
import { getServerInstructions } from "./config/server-instructions.js";
import { DEFAULT_TOOL_PROFILE, type ToolProfile } from "./config/tool-profile.js";
import type { WorkspaceConfig } from "./config/workspace.js";
import type { ServerContext } from "./core/server-context.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./generated/build-meta.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";

export interface CreateServerOptions {
  profile?: ToolProfile;
  workspaceConfig?: WorkspaceConfig;
}

/**
 * Creates and initializes a new Model Context Protocol (MCP) server instance.
 * Tools, resources, prompts, and server instructions are registered according to the
 * specified security profile and workspace roots.
 */
export function createServer(options?: CreateServerOptions): McpServer {
  const profile = options?.profile ?? DEFAULT_TOOL_PROFILE;
  const workspace = options?.workspaceConfig;

  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      instructions: getServerInstructions(profile),
    }
  );

  const context: ServerContext = {
    profile,
    workspace,
  };

  registerTools(server, context);
  registerResources(server, context);
  registerPrompts(server, context);

  return server;
}

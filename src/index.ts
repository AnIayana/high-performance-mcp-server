import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolProfile } from "./config/tool-profile.js";
import type { WorkspaceConfig, WorkspaceRoot } from "./config/workspace.js";
import { resolveWorkspaceConfig } from "./config/workspace.js";
import { createServer as createInternalServer } from "./server.js";

export type { ToolProfile } from "./config/tool-profile.js";
export type { WorkspaceConfig, WorkspaceRoot } from "./config/workspace.js";
export { resolveWorkspaceConfig } from "./config/workspace.js";

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
  return createInternalServer({
    profile: options?.profile,
    workspaceConfig: options?.workspaceConfig,
  });
}

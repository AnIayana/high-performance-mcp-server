import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_TOOL_PROFILE, type ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";
import { createServer } from "../server.js";

/**
 * Starts the Model Context Protocol (MCP) server over Stdio transport.
 * Wires the stdio transport using serveStdio and initializes tools and resources according to profile and workspace config.
 */
export async function startStdioTransport(
  profile: ToolProfile = DEFAULT_TOOL_PROFILE,
  workspaceConfig?: WorkspaceConfig
): Promise<void> {
  await serveStdio(() => createServer({ profile, workspaceConfig }));
}

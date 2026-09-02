import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_TOOL_PROFILE, type ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";
import type { OperatorMcpLogLevel } from "../logging/index.js";
import type { NetworkCachePolicy } from "../network/conditional-cache.js";
import type { NetworkOperatorPolicy } from "../network/operator-policy.js";
import type { WorkspaceOperatorPolicy } from "../workspace/write-service.js";
import { createServer } from "../server.js";

/**
 * Starts the Model Context Protocol (MCP) server over Stdio transport.
 * Wires the stdio transport using serveStdio and initializes tools and resources according to profile, workspace config, network policy, network cache policy, and MCP logging settings.
 */
export async function startStdioTransport(
  profile: ToolProfile = DEFAULT_TOOL_PROFILE,
  workspaceConfig?: WorkspaceConfig,
  networkPolicy?: NetworkOperatorPolicy,
  networkCachePolicy?: NetworkCachePolicy,
  workspacePolicy?: WorkspaceOperatorPolicy,
  mcpLogLevel?: OperatorMcpLogLevel
): Promise<void> {
  await serveStdio(() =>
    createServer({
      profile,
      workspaceConfig,
      workspacePolicy,
      networkPolicy,
      networkCachePolicy,
      mcpLogLevel,
    })
  );
}



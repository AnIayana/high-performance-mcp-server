import { McpServer } from "@modelcontextprotocol/server";
import { getServerInstructions } from "./config/server-instructions.js";
import { DEFAULT_TOOL_PROFILE, type ToolProfile } from "./config/tool-profile.js";
import type { WorkspaceConfig } from "./config/workspace.js";
import type { ServerContext } from "./core/server-context.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./generated/build-meta.js";
import {
  HttpConditionalCache,
  type NetworkCachePolicy,
} from "./network/conditional-cache.js";
import type { NetworkOperatorPolicy } from "./network/operator-policy.js";
import type { WorkspaceOperatorPolicy } from "./workspace/write-service.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";

export interface CreateServerOptions {
  profile?: ToolProfile;
  workspaceConfig?: WorkspaceConfig;
  workspacePolicy?: WorkspaceOperatorPolicy;
  networkPolicy?: NetworkOperatorPolicy;
  networkCachePolicy?: NetworkCachePolicy;
}

/**
 * Creates and initializes a new Model Context Protocol (MCP) server instance.
 * Tools, resources, prompts, and server instructions are registered according to the
 * specified security profile and workspace roots.
 */
export function createServer(options?: CreateServerOptions): McpServer {
  const profile = options?.profile ?? DEFAULT_TOOL_PROFILE;
  const workspace = options?.workspaceConfig;
  const workspacePolicy = options?.workspacePolicy;
  const networkPolicy = options?.networkPolicy;
  const networkCachePolicy = options?.networkCachePolicy;
  const networkCache = networkCachePolicy?.enabled
    ? new HttpConditionalCache(networkCachePolicy)
    : undefined;

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
    workspacePolicy,
    networkPolicy,
    networkCachePolicy,
    networkCache,
  };

  registerTools(server, context);
  registerResources(server, context);
  registerPrompts(server, context);

  return server;
}

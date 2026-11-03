import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolProfile } from "./config/tool-profile.js";
import type { WorkspaceConfig, WorkspaceRoot } from "./config/workspace.js";
import { resolveWorkspaceConfig } from "./config/workspace.js";
import {
  createNetworkCachePolicy,
  type NetworkCachePolicy,
} from "./network/conditional-cache.js";
import {
  createNetworkOperatorPolicy,
  type NetworkOperatorPolicy,
} from "./network/operator-policy.js";
import { createServer as createInternalServer } from "./server.js";
import {
  createWorkspaceOperatorPolicy,
  type WorkspaceOperatorPolicy,
} from "./workspace/write-service.js";

export type { ToolProfile } from "./config/tool-profile.js";
export type { WorkspaceConfig, WorkspaceRoot } from "./config/workspace.js";
export type { NetworkCachePolicy } from "./network/conditional-cache.js";
export type { NetworkOperatorPolicy } from "./network/operator-policy.js";
export type { WorkspaceOperatorPolicy } from "./workspace/write-service.js";
export {
  createNetworkCachePolicy,
  createNetworkOperatorPolicy,
  createWorkspaceOperatorPolicy,
  resolveWorkspaceConfig,
};

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
 * specified security profile, workspace roots, and operator policies.
 */
export function createServer(options?: CreateServerOptions): McpServer {
  return createInternalServer({
    profile: options?.profile,
    workspaceConfig: options?.workspaceConfig,
    workspacePolicy: options?.workspacePolicy,
    networkPolicy: options?.networkPolicy,
    networkCachePolicy: options?.networkCachePolicy,
  });
}

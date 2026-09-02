import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";
import type { McpLoggingManager } from "../logging/manager.js";
import type { NetworkOperatorPolicy } from "../network/operator-policy.js";
import type {
  HttpConditionalCache,
  NetworkCachePolicy,
} from "../network/conditional-cache.js";
import type { WorkspaceOperatorPolicy } from "../workspace/write-service.js";

/**
 * Shared runtime context passed to tool and resource registration functions.
 */
export interface ServerContext {
  readonly profile: ToolProfile;
  readonly workspace?: WorkspaceConfig;
  readonly workspacePolicy?: WorkspaceOperatorPolicy;
  readonly networkPolicy?: NetworkOperatorPolicy;
  readonly networkCachePolicy?: NetworkCachePolicy;
  readonly networkCache?: HttpConditionalCache;
  readonly mcpLogging?: McpLoggingManager;
  readonly server?: McpServer;
}



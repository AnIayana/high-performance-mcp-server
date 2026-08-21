import type { ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";
import type { NetworkOperatorPolicy } from "../network/operator-policy.js";

/**
 * Shared runtime context passed to tool and resource registration functions.
 */
export interface ServerContext {
  readonly profile: ToolProfile;
  readonly workspace?: WorkspaceConfig;
  readonly networkPolicy?: NetworkOperatorPolicy;
}

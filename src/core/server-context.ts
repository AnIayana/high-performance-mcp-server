import type { ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";

/**
 * Shared runtime context passed to tool and resource registration functions.
 */
export interface ServerContext {
  readonly profile: ToolProfile;
  readonly workspace?: WorkspaceConfig;
}

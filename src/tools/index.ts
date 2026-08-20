import type { McpServer } from "@modelcontextprotocol/server";
import { DEFAULT_TOOL_PROFILE, isCategoryAllowed, type ToolProfile } from "../config/tool-profile.js";
import type { ServerContext } from "../core/server-context.js";
import { toolEntries, type ToolEntry } from "./generated-registry.js";

/**
 * Returns the list of registered tools that match the allowed categories for the specified profile.
 */
export function getToolsForProfile(profile: ToolProfile = DEFAULT_TOOL_PROFILE): ToolEntry[] {
  return toolEntries.filter((entry) => isCategoryAllowed(entry.meta.category, profile));
}

/**
 * Registers MCP tools onto the server instance filtered by the active security profile.
 * Accepts either a ServerContext or a ToolProfile.
 */
export function registerTools(
  server: McpServer,
  contextOrProfile: ServerContext | ToolProfile = DEFAULT_TOOL_PROFILE
): void {
  const context: ServerContext =
    typeof contextOrProfile === "string"
      ? { profile: contextOrProfile }
      : contextOrProfile;

  const allowedTools = getToolsForProfile(context.profile);
  for (const entry of allowedTools) {
    entry.register(server, context);
  }
}

export type { ToolEntry };

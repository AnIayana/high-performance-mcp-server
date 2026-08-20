import type { ToolCategory } from "../tools/types.js";

/**
 * Public Security Tool Profiles.
 * Controls which categories of MCP tools are registered and exposed to clients.
 *
 * Rationale:
 * - "safe": Non-intrusive utilities (echo, ping). Zero access to host filesystem,
 *   hardware metrics, CPU-heavy operations, or state mutation. Safe default for public exposure.
 * - "workspace": Adds explicit read-only filesystem tools (roots list, directory list, file info, text read)
 *   strictly restricted to allowlisted workspace root directories.
 * - "diagnostics": Adds observability tools (system stats, metrics, worker pool, cache stats)
 *   for telemetry and health monitoring without allowing state resets or high CPU consumption.
 * - "benchmark": Adds compute-heavy workloads (main-thread, worker pool, and cached prime counting)
 *   intended for performance profiling and load testing.
 * - "admin": Adds diagnostic monitoring and administrative state mutation (cache reset, metrics reset).
 * - "all": Enables the full catalog of registered tools across all categories.
 */
export type ToolProfile =
  | "safe"
  | "workspace"
  | "diagnostics"
  | "benchmark"
  | "admin"
  | "all";

export const VALID_TOOL_PROFILES: readonly ToolProfile[] = [
  "safe",
  "workspace",
  "diagnostics",
  "benchmark",
  "admin",
  "all",
] as const;

export const DEFAULT_TOOL_PROFILE: ToolProfile = "safe";

const PROFILE_ALLOWED_CATEGORIES: Record<ToolProfile, readonly ToolCategory[]> = {
  safe: ["safe"],
  workspace: ["safe", "workspace"],
  diagnostics: ["safe", "diagnostics"],
  benchmark: ["safe", "benchmark"],
  admin: ["safe", "diagnostics", "admin"],
  all: ["safe", "workspace", "diagnostics", "benchmark", "admin"],
};

/**
 * Checks whether a given tool category is permitted under the active tool profile.
 */
export function isCategoryAllowed(
  category: ToolCategory,
  profile: ToolProfile
): boolean {
  const allowed = PROFILE_ALLOWED_CATEGORIES[profile];
  return allowed ? allowed.includes(category) : false;
}

/**
 * Type guard validating whether a string matches a recognized ToolProfile.
 */
export function isValidToolProfile(value: string): value is ToolProfile {
  return (VALID_TOOL_PROFILES as readonly string[]).includes(value);
}

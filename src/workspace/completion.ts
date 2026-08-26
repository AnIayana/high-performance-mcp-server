import type { ServerContext } from "../core/server-context.js";

/**
 * Completes logical workspace root IDs without exposing root names or host paths.
 * Workspace configuration is bounded to at most 16 unique roots, so the full
 * prefix-filtered result can be returned without filesystem enumeration.
 */
export function completeWorkspaceRootIds(
  context: ServerContext | undefined,
  value: string
): string[] {
  const roots = context?.workspace?.roots ?? [];
  return roots.map((root) => root.id).filter((rootId) => rootId.startsWith(value));
}

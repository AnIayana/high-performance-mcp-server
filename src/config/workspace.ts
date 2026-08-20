import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const MAX_RAW_WORKSPACE_ROOTS = 64;
export const MAX_WORKSPACE_ROOTS = 16;
export const MAX_ROOT_NAME_LENGTH = 128;

export interface WorkspaceRoot {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly realPath: string;
}

export interface WorkspaceConfig {
  readonly roots: readonly WorkspaceRoot[];
}

/**
 * Normalizes a canonical realPath into a deduplication identity key.
 * On Windows, path comparisons are case-insensitive; on POSIX systems, casing is preserved.
 * Note: This normalization is only used for deduplication identity, never for actual path storage.
 */
export function normalizeRootIdentity(realPath: string): string {
  if (process.platform === "win32") {
    return realPath.toLowerCase();
  }
  return realPath;
}

/**
 * Resolves, canonicalizes, deduplicates, and securely validates configured workspace root directories.
 * Ensures roots exist, are directories, and enforces raw/unique root count limits.
 */
export async function resolveWorkspaceConfig(
  rawRoots: readonly string[] = []
): Promise<WorkspaceConfig> {
  if (!Array.isArray(rawRoots)) {
    throw new Error("Workspace roots must be provided as an array of strings.");
  }

  if (rawRoots.length > MAX_RAW_WORKSPACE_ROOTS) {
    throw new Error(
      `Configured raw workspace roots count (${rawRoots.length}) exceeds the maximum allowed limit of ${MAX_RAW_WORKSPACE_ROOTS}.`
    );
  }

  const seenIdentities = new Set<string>();
  const resolvedRoots: WorkspaceRoot[] = [];

  for (const rawRoot of rawRoots) {
    if (typeof rawRoot !== "string" || rawRoot.trim().length === 0) {
      throw new Error(`Invalid workspace root path: "${String(rawRoot)}". Must be a non-empty string.`);
    }

    const trimmed = rawRoot.trim();
    const absolutePath = path.resolve(trimmed);

    let realPath: string;
    try {
      realPath = await fs.realpath(absolutePath);
    } catch {
      throw new Error(`Workspace root path does not exist: "${trimmed}" (resolved to "${absolutePath}").`);
    }

    let stats;
    try {
      stats = await fs.stat(realPath);
    } catch {
      throw new Error(`Cannot stat workspace root path: "${realPath}".`);
    }

    if (!stats.isDirectory()) {
      throw new Error(
        `Workspace root must be a directory, but received a file: "${trimmed}" (resolved to "${realPath}").`
      );
    }

    // Cross-platform deduplication by normalized canonical identity
    const identityKey = normalizeRootIdentity(realPath);
    if (!seenIdentities.has(identityKey)) {
      seenIdentities.add(identityKey);
      const rootIndex = resolvedRoots.length + 1;
      const rootId = `root-${rootIndex}`;
      const baseName = path.basename(realPath);
      const sanitizedName = (baseName && baseName.trim().length > 0 ? baseName : rootId).slice(
        0,
        MAX_ROOT_NAME_LENGTH
      );

      resolvedRoots.push(
        Object.freeze({
          id: rootId,
          name: sanitizedName,
          path: absolutePath,
          realPath,
        })
      );
    }
  }

  if (resolvedRoots.length > MAX_WORKSPACE_ROOTS) {
    throw new Error(
      `Configured unique workspace roots count (${resolvedRoots.length}) exceeds the maximum allowed limit of ${MAX_WORKSPACE_ROOTS}.`
    );
  }

  return Object.freeze({
    roots: Object.freeze(resolvedRoots),
  });
}

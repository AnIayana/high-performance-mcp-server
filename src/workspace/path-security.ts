import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { WorkspaceConfig, WorkspaceRoot } from "../config/workspace.js";

export const DEFAULT_TEXT_READ_BYTES = 262144; // 256 KiB
export const MAX_TEXT_READ_BYTES = 1048576; // 1 MiB
export const MAX_DIRECTORY_ENTRIES = 500;

export interface ResolvedPathResult {
  readonly resolvedPath: string;
  readonly relativeToRoot: string;
  readonly root: WorkspaceRoot;
  readonly stats: Stats;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

/**
 * Checks whether a path string represents an absolute path under POSIX or Windows rules.
 */
export function isInputAbsolute(inputPath: string): boolean {
  if (path.isAbsolute(inputPath)) {
    return true;
  }
  // Check for leading slashes or Windows drive / UNC patterns
  if (inputPath.startsWith("/") || inputPath.startsWith("\\")) {
    return true;
  }
  if (/^[a-zA-Z]:[/\\]?/.test(inputPath)) {
    return true;
  }
  return false;
}

/**
 * Checks if target canonical path is strictly contained within root canonical path.
 */
export function isContainedWithinRoot(rootRealPath: string, targetRealPath: string): boolean {
  const normRoot = process.platform === "win32" ? rootRealPath.toLowerCase() : rootRealPath;
  const normTarget = process.platform === "win32" ? targetRealPath.toLowerCase() : targetRealPath;
  const rel = path.relative(normRoot, normTarget);
  if (
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    path.isAbsolute(rel)
  ) {
    return false;
  }
  return true;
}

/**
 * The single, central, secure path resolver for all workspace tools and resources.
 * Guarantees:
 * - rootId is recognized
 * - relativePath cannot contain NUL bytes
 * - relativePath cannot be absolute
 * - Resolves all symbolic links / junctions
 * - Ensures canonical destination remains strictly within the root directory boundary
 * - Error messages are sanitized to never reveal host absolute paths
 */
export async function resolveExistingPathWithinRoot(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string
): Promise<ResolvedPathResult> {
  if (!workspaceConfig || !Array.isArray(workspaceConfig.roots) || workspaceConfig.roots.length === 0) {
    throw new Error("No workspace roots configured for this server instance.");
  }

  if (typeof rootId !== "string" || rootId.trim().length === 0) {
    throw new Error("Invalid rootId parameter: Must be a non-empty string.");
  }

  const root = workspaceConfig.roots.find((r) => r.id === rootId.trim());
  if (!root) {
    throw new Error(
      `Unknown workspace rootId "${rootId}". Available roots: ${workspaceConfig.roots.map((r) => r.id).join(", ")}`
    );
  }

  if (typeof relativePath !== "string") {
    throw new Error("Invalid path parameter: Must be a string.");
  }

  // Reject NUL bytes
  if (relativePath.includes("\0")) {
    throw new Error("Invalid path parameter: Path cannot contain NUL bytes.");
  }

  const trimmedPath = relativePath.trim();

  // Reject absolute paths without leaking server host path
  if (isInputAbsolute(trimmedPath)) {
    throw new Error(
      `Access denied: Absolute paths are not permitted. Use paths relative to root "${root.id}".`
    );
  }

  // Normalization: empty or "." refers to root directory
  const normalizedRel = trimmedPath.length === 0 || trimmedPath === "." ? "." : trimmedPath;

  // Initial resolution against root
  const initialTargetPath = path.resolve(root.realPath, normalizedRel);

  // Check initial containment
  if (!isContainedWithinRoot(root.realPath, initialTargetPath)) {
    throw new Error(
      `Access denied: Path "${relativePath}" escapes root boundary "${root.name}".`
    );
  }

  // Canonicalize path (resolve symlinks / junctions)
  let realTargetPath: string;
  try {
    realTargetPath = fs.realpath.native
      ? await fs.realpath.native(initialTargetPath)
      : await fs.realpath(initialTargetPath);
  } catch {
    throw new Error(`Path does not exist: "${relativePath}" within root "${root.name}".`);
  }

  // Verify canonical target is within canonical root
  if (!isContainedWithinRoot(root.realPath, realTargetPath)) {
    throw new Error(
      `Access denied: Symlink or path target "${relativePath}" escapes root boundary "${root.name}".`
    );
  }

  let stats: Stats;
  try {
    stats = await fs.stat(realTargetPath);
  } catch {
    throw new Error(`Cannot access target path: "${relativePath}" within root "${root.name}".`);
  }

  let isSymlink = false;
  try {
    const lstat = await fs.lstat(initialTargetPath);
    isSymlink = lstat.isSymbolicLink();
  } catch {
    // If lstat fails, fallback is false
  }

  const relFromRoot = path.relative(root.realPath, realTargetPath) || ".";

  return {
    resolvedPath: realTargetPath,
    relativeToRoot: relFromRoot,
    root,
    stats,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymlink,
  };
}

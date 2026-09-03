import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { WorkspaceConfig, WorkspaceRoot } from "../config/workspace.js";
import { isContainedWithinRoot, isInputAbsolute } from "./path-security.js";
import { WorkspaceSecurityError } from "./types.js";

export const DEFAULT_MAX_WRITE_BYTES = 1048576; // 1 MiB
export const HARD_MAX_WRITE_BYTES = 5242880;   // 5 MiB
export const MIN_WRITE_BYTES = 1;

export const DEFAULT_MAX_RESOURCE_BYTES = 1048576; // 1 MiB
export const HARD_MAX_RESOURCE_BYTES = 5242880;   // 5 MiB
export const MIN_RESOURCE_BYTES = 1;

export const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

export interface WorkspaceOperatorPolicy {
  readonly maxWriteBytes: number;
  readonly maxResourceBytes: number;
  readonly requireWriteConfirmation: boolean;
}

export const DEFAULT_WORKSPACE_OPERATOR_POLICY: WorkspaceOperatorPolicy = Object.freeze({
  maxWriteBytes: DEFAULT_MAX_WRITE_BYTES,
  maxResourceBytes: DEFAULT_MAX_RESOURCE_BYTES,
  requireWriteConfirmation: false,
});

/**
 * Creates and freezes a validated workspace operator policy object.
 */
export function createWorkspaceOperatorPolicy(
  policy?: Partial<WorkspaceOperatorPolicy>
): WorkspaceOperatorPolicy {
  const maxWriteBytes =
    typeof policy?.maxWriteBytes === "number" && Number.isSafeInteger(policy.maxWriteBytes)
      ? Math.max(MIN_WRITE_BYTES, Math.min(HARD_MAX_WRITE_BYTES, policy.maxWriteBytes))
      : DEFAULT_MAX_WRITE_BYTES;

  const maxResourceBytes =
    typeof policy?.maxResourceBytes === "number" && Number.isSafeInteger(policy.maxResourceBytes)
      ? Math.max(MIN_RESOURCE_BYTES, Math.min(HARD_MAX_RESOURCE_BYTES, policy.maxResourceBytes))
      : DEFAULT_MAX_RESOURCE_BYTES;

  const requireWriteConfirmation = policy?.requireWriteConfirmation === true;

  return Object.freeze({
    maxWriteBytes,
    maxResourceBytes,
    requireWriteConfirmation,
  });
}

export type WriteMode = "create" | "overwrite";

export interface ResolvedWritePathResult {
  readonly targetPath: string;
  readonly relativeToRoot: string;
  readonly root: WorkspaceRoot;
  readonly exists: boolean;
  readonly stats?: Stats;
}

export interface WriteTextFileInput {
  rootId?: string;
  path: string;
  mode: WriteMode;
  content: string;
  createParents?: boolean;
  expectedSha256?: string;
  operatorPolicy?: WorkspaceOperatorPolicy;
}

export interface WriteTextFileResult {
  rootId: string;
  path: string;
  mode: WriteMode;
  bytesWritten: number;
  sha256: string;
  previousSha256?: string;
}

export interface TextEditItem {
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
}

export interface EditTextFileInput {
  rootId?: string;
  path: string;
  expectedSha256: string;
  edits: readonly TextEditItem[];
  operatorPolicy?: WorkspaceOperatorPolicy;
}

export interface EditTextFileResult {
  rootId: string;
  path: string;
  editsApplied: number;
  bytesWritten: number;
  sha256: string;
  previousSha256: string;
}

/**
 * Helper hook for injecting test race conditions immediately prior to atomic file publication/rename.
 * Used exclusively by deterministic concurrency test suites.
 */
let prePublicationHookForTesting: ((targetPath: string) => Promise<void>) | undefined;

export function _setPreRenameHookForTesting(
  hook?: (targetPath: string) => Promise<void>
): void {
  prePublicationHookForTesting = hook;
}

/**
 * Helper hook for injecting simulated failure during final atomic replacement.
 * Used exclusively by atomicity failure test suites.
 */
let publicationFailureHookForTesting: (() => Promise<void>) | undefined;

export function _setPublicationFailureHookForTesting(
  hook?: () => Promise<void>
): void {
  publicationFailureHookForTesting = hook;
}

/**
 * Resolves and validates a workspace root from a workspace configuration.
 */
function resolveRoot(workspaceConfig: WorkspaceConfig | undefined, rootId?: string): WorkspaceRoot {
  if (!workspaceConfig || !Array.isArray(workspaceConfig.roots) || workspaceConfig.roots.length === 0) {
    throw new WorkspaceSecurityError("access_denied", "No workspace roots configured for this server instance.");
  }

  if (rootId !== undefined && rootId.trim().length > 0) {
    const trimmedId = rootId.trim();
    const found = workspaceConfig.roots.find((r) => r.id === trimmedId);
    if (!found) {
      throw new WorkspaceSecurityError(
        "invalid_path",
        `Unknown workspace rootId "${rootId}". Available roots: ${workspaceConfig.roots.map((r) => r.id).join(", ")}`
      );
    }
    return found;
  }

  // Default to first root if only one exists
  if (workspaceConfig.roots.length === 1) {
    return workspaceConfig.roots[0];
  }

  throw new WorkspaceSecurityError(
    "invalid_path",
    `Multiple workspace roots configured (${workspaceConfig.roots.map((r) => r.id).join(", ")}). rootId parameter is required.`
  );
}

/**
 * Creates a unique temporary file exclusively (O_CREAT | O_EXCL | O_WRONLY) in the specified directory.
 * Retries on collision with fresh UUIDs.
 */
async function createExclusiveTempFile(
  dir: string,
  mode: number = 0o600
): Promise<{ handle: fs.FileHandle; tempPath: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tempFileName = `.mcp-temp-${crypto.randomUUID()}.tmp`;
    const tempPath = path.join(dir, tempFileName);
    try {
      // 'wx' flag opens for writing with O_CREAT | O_EXCL
      const handle = await fs.open(tempPath, "wx", mode);
      return { handle, tempPath };
    } catch (err: any) {
      if (err.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new WorkspaceSecurityError("workspace_error", "Failed to allocate exclusive temporary file after multiple attempts.");
}

/**
 * Securely resolves a target file path within a workspace root for mutation operations.
 * Handles both new file creation and existing file overwrite validation.
 */
export async function resolveWritePathWithinRoot(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string | undefined,
  relativePath: string,
  isCreate: boolean,
  createParents?: boolean
): Promise<ResolvedWritePathResult> {
  const root = resolveRoot(workspaceConfig, rootId);

  if (typeof relativePath !== "string") {
    throw new WorkspaceSecurityError("invalid_path", "Invalid path parameter: Must be a string.");
  }

  if (relativePath.includes("\0")) {
    throw new WorkspaceSecurityError("invalid_path", "Invalid path parameter: Path cannot contain NUL bytes.");
  }

  const trimmedPath = relativePath.trim();
  if (trimmedPath.length === 0 || trimmedPath === ".") {
    throw new WorkspaceSecurityError("invalid_path", "Invalid path parameter: Cannot mutate workspace root directory directly.");
  }

  // Reject absolute paths under POSIX or Windows rules
  if (isInputAbsolute(trimmedPath)) {
    throw new WorkspaceSecurityError(
      "access_denied",
      `Access denied: Absolute paths are not permitted. Use paths relative to root "${root.id}".`
    );
  }

  const initialTargetPath = path.resolve(root.realPath, trimmedPath);

  // Check initial containment
  if (!isContainedWithinRoot(root.realPath, initialTargetPath)) {
    throw new WorkspaceSecurityError(
      "access_denied",
      `Access denied: Path "${relativePath}" escapes root boundary "${root.name}".`
    );
  }

  let lstatResult: Stats | undefined;
  try {
    lstatResult = await fs.lstat(initialTargetPath);
  } catch {
    lstatResult = undefined;
  }

  if (isCreate) {
    // For file creation: target must NOT exist
    if (lstatResult) {
      throw new WorkspaceSecurityError(
        "already_exists",
        `File already exists: "${relativePath}" within root "${root.name}".`
      );
    }

    if (createParents === true) {
      // Read-only preflight for createParents=true:
      // Inspect existing directory segments in read-only mode without mutating the filesystem
      const parentRel = path.dirname(trimmedPath);
      if (parentRel !== "." && parentRel !== "") {
        const segments = parentRel.split(/[\\/]+/).filter(Boolean);
        let currentDir = root.realPath;
        for (const segment of segments) {
          if (segment === "." || segment === "..") {
            throw new WorkspaceSecurityError("invalid_path", `Invalid path segment "${segment}".`);
          }
          const candidate = path.join(currentDir, segment);
          if (!isContainedWithinRoot(root.realPath, candidate)) {
            throw new WorkspaceSecurityError(
              "access_denied",
              `Access denied: Parent path escapes root boundary "${root.name}".`
            );
          }
          let segStats: Stats | undefined;
          try {
            segStats = await fs.lstat(candidate);
          } catch {
            segStats = undefined;
          }
          if (segStats) {
            if (segStats.isSymbolicLink()) {
              let canonicalSeg: string;
              try {
                canonicalSeg = await fs.realpath(candidate);
              } catch {
                throw new WorkspaceSecurityError(
                  "access_denied",
                  `Cannot resolve symlink at path segment "${segment}".`
                );
              }
              if (!isContainedWithinRoot(root.realPath, canonicalSeg)) {
                throw new WorkspaceSecurityError(
                  "access_denied",
                  `Access denied: Symlink at "${segment}" escapes root boundary "${root.name}".`
                );
              }
              const symTargetStats = await fs.stat(canonicalSeg);
              if (!symTargetStats.isDirectory()) {
                throw new WorkspaceSecurityError(
                  "invalid_path",
                  `Intermediate path segment "${segment}" is a file, not a directory.`
                );
              }
              currentDir = canonicalSeg;
            } else if (!segStats.isDirectory()) {
              throw new WorkspaceSecurityError(
                "invalid_path",
                `Intermediate path segment "${segment}" is a file, not a directory.`
              );
            } else {
              let canonicalSeg: string;
              try {
                canonicalSeg = await fs.realpath(candidate);
              } catch {
                throw new WorkspaceSecurityError(
                  "workspace_error",
                  `Cannot resolve canonical path for directory "${segment}".`
                );
              }
              if (!isContainedWithinRoot(root.realPath, canonicalSeg)) {
                throw new WorkspaceSecurityError(
                  "access_denied",
                  `Access denied: Directory "${segment}" escapes root boundary "${root.name}".`
                );
              }
              currentDir = canonicalSeg;
            }
          } else {
            // Missing parent segment reached during read-only preflight: allowed to proceed
            break;
          }
        }
      }

      const fileName = path.basename(initialTargetPath);
      if (!fileName || fileName === "." || fileName === "..") {
        throw new WorkspaceSecurityError("invalid_path", `Invalid filename for: "${relativePath}".`);
      }

      const relFromRoot = path.relative(root.realPath, initialTargetPath) || fileName;

      return {
        targetPath: initialTargetPath,
        relativeToRoot: relFromRoot,
        root,
        exists: false,
      };
    }

    // Securely validate nearest parent directory (createParents omitted / false)
    const parentDir = path.dirname(initialTargetPath);
    let parentStats: Stats;
    try {
      parentStats = await fs.stat(parentDir);
    } catch {
      throw new WorkspaceSecurityError(
        "missing_parent",
        `Parent directory does not exist for: "${relativePath}" within root "${root.name}".`
      );
    }

    if (!parentStats.isDirectory()) {
      throw new WorkspaceSecurityError(
        "missing_parent",
        `Parent path is not a directory for: "${relativePath}" within root "${root.name}".`
      );
    }

    // Canonicalize parent directory to resolve symlinks / junctions
    let realParentDir: string;
    try {
      realParentDir = await fs.realpath(parentDir);
    } catch {
      throw new WorkspaceSecurityError(
        "missing_parent",
        `Cannot resolve canonical parent directory for: "${relativePath}" within root "${root.name}".`
      );
    }

    if (!isContainedWithinRoot(root.realPath, realParentDir)) {
      throw new WorkspaceSecurityError(
        "access_denied",
        `Access denied: Parent directory symlink escapes root boundary "${root.name}".`
      );
    }

    const fileName = path.basename(initialTargetPath);
    if (!fileName || fileName === "." || fileName === "..") {
      throw new WorkspaceSecurityError("invalid_path", `Invalid filename for: "${relativePath}".`);
    }

    const finalTargetPath = path.join(realParentDir, fileName);
    if (!isContainedWithinRoot(root.realPath, finalTargetPath)) {
      throw new WorkspaceSecurityError(
        "access_denied",
        `Access denied: Path "${relativePath}" escapes root boundary "${root.name}".`
      );
    }

    const relFromRoot = path.relative(root.realPath, finalTargetPath) || fileName;

    return {
      targetPath: finalTargetPath,
      relativeToRoot: relFromRoot,
      root,
      exists: false,
    };
  }

  // Overwrite / Edit case: target MUST exist
  if (!lstatResult) {
    throw new WorkspaceSecurityError(
      "not_found",
      `File does not exist: "${relativePath}" within root "${root.name}". Use mode "create" to create a new file.`
    );
  }

  // Canonicalize target path (resolving symlinks / junctions)
  let realTargetPath: string;
  try {
    realTargetPath = await fs.realpath(initialTargetPath);
  } catch {
    throw new WorkspaceSecurityError(
      "not_found",
      `Cannot resolve realpath for: "${relativePath}" within root "${root.name}".`
    );
  }

  if (!isContainedWithinRoot(root.realPath, realTargetPath)) {
    throw new WorkspaceSecurityError(
      "access_denied",
      `Access denied: Symlink or target path "${relativePath}" escapes root boundary "${root.name}".`
    );
  }

  let stats: Stats;
  try {
    stats = await fs.stat(realTargetPath);
  } catch {
    throw new WorkspaceSecurityError(
      "not_found",
      `Cannot access target path: "${relativePath}" within root "${root.name}".`
    );
  }

  if (!stats.isFile()) {
    throw new WorkspaceSecurityError(
      "unsupported_file_type",
      `Target "${relativePath}" is not a regular file (type: ${stats.isDirectory() ? "directory" : "special file"}).`
    );
  }

  // Also verify parent directory canonical containment
  const realParentDir = path.dirname(realTargetPath);
  if (!isContainedWithinRoot(root.realPath, realParentDir)) {
    throw new WorkspaceSecurityError(
      "access_denied",
      `Access denied: Parent directory escapes root boundary "${root.name}".`
    );
  }

  const relFromRoot = path.relative(root.realPath, realTargetPath) || ".";

  return {
    targetPath: realTargetPath,
    relativeToRoot: relFromRoot,
    root,
    exists: true,
    stats,
  };
}

/**
 * Safely creates missing intermediate parent directories segment-by-segment
 * ensuring lexical and canonical containment at every step.
 */
async function ensureParentDirectories(
  root: WorkspaceRoot,
  relativePath: string
): Promise<string> {
  const trimmedPath = relativePath.trim();
  const parentRel = path.dirname(trimmedPath);
  if (parentRel === "." || parentRel === "") {
    return root.realPath;
  }

  const segments = parentRel.split(/[\\/]+/).filter(Boolean);
  let currentDir = root.realPath;

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new WorkspaceSecurityError("invalid_path", `Invalid path segment "${segment}".`);
    }

    const candidate = path.join(currentDir, segment);
    if (!isContainedWithinRoot(root.realPath, candidate)) {
      throw new WorkspaceSecurityError(
        "access_denied",
        `Access denied: Parent path escapes root boundary "${root.name}".`
      );
    }

    let stats: Stats | undefined;
    try {
      stats = await fs.lstat(candidate);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        stats = undefined;
      } else {
        throw new WorkspaceSecurityError(
          "workspace_error",
          `Failed to inspect path segment "${segment}" due to a filesystem error.`
        );
      }
    }

    if (stats) {
      if (stats.isSymbolicLink()) {
        let canonicalCandidate: string;
        try {
          canonicalCandidate = await fs.realpath(candidate);
        } catch {
          throw new WorkspaceSecurityError(
            "access_denied",
            `Cannot resolve symlink at path segment "${segment}".`
          );
        }
        if (!isContainedWithinRoot(root.realPath, canonicalCandidate)) {
          throw new WorkspaceSecurityError(
            "access_denied",
            `Access denied: Symlink at "${segment}" escapes root boundary "${root.name}".`
          );
        }
        let symTargetStats: Stats;
        try {
          symTargetStats = await fs.stat(canonicalCandidate);
        } catch {
          throw new WorkspaceSecurityError(
            "workspace_error",
            `Cannot inspect target of symlink at "${segment}".`
          );
        }
        if (!symTargetStats.isDirectory()) {
          throw new WorkspaceSecurityError(
            "invalid_path",
            `Intermediate path segment "${segment}" resolves to a file, not a directory.`
          );
        }
        currentDir = canonicalCandidate;
      } else if (!stats.isDirectory()) {
        throw new WorkspaceSecurityError(
          "invalid_path",
          `Intermediate path segment "${segment}" is a file, not a directory.`
        );
      } else {
        let canonicalCandidate: string;
        try {
          canonicalCandidate = await fs.realpath(candidate);
        } catch {
          throw new WorkspaceSecurityError(
            "workspace_error",
            `Cannot resolve canonical path for directory "${segment}".`
          );
        }
        if (!isContainedWithinRoot(root.realPath, canonicalCandidate)) {
          throw new WorkspaceSecurityError(
            "access_denied",
            `Access denied: Directory "${segment}" escapes root boundary "${root.name}".`
          );
        }
        currentDir = canonicalCandidate;
      }
    } else {
      // Segment is missing: revalidate current parent canonical containment before creating
      const canonicalParent = await fs.realpath(currentDir);
      if (!isContainedWithinRoot(root.realPath, canonicalParent)) {
        throw new WorkspaceSecurityError(
          "access_denied",
          `Access denied: Parent directory escaped root boundary "${root.name}".`
        );
      }

      try {
        await fs.mkdir(candidate, { recursive: false });
      } catch (mkdirErr: any) {
        if (mkdirErr.code === "EEXIST") {
          // Race condition: another process created the path concurrently
          let raceStats: Stats;
          try {
            raceStats = await fs.lstat(candidate);
          } catch {
            throw new WorkspaceSecurityError(
              "workspace_error",
              `Failed to verify directory "${segment}" after creation collision.`
            );
          }
          if (raceStats.isSymbolicLink()) {
            let canonicalRace: string;
            try {
              canonicalRace = await fs.realpath(candidate);
            } catch {
              throw new WorkspaceSecurityError(
                "access_denied",
                `Cannot resolve symlink at collided path segment "${segment}".`
              );
            }
            if (!isContainedWithinRoot(root.realPath, canonicalRace)) {
              throw new WorkspaceSecurityError(
                "access_denied",
                `Access denied: Collided symlink at "${segment}" escapes root boundary "${root.name}".`
              );
            }
            const symRaceStats = await fs.stat(canonicalRace);
            if (!symRaceStats.isDirectory()) {
              throw new WorkspaceSecurityError(
                "invalid_path",
                `Intermediate path segment "${segment}" collided with a non-directory.`
              );
            }
            currentDir = canonicalRace;
            continue;
          }
          if (!raceStats.isDirectory()) {
            throw new WorkspaceSecurityError(
              "invalid_path",
              `Intermediate path segment "${segment}" collided with a non-directory.`
            );
          }
          let canonicalRace: string;
          try {
            canonicalRace = await fs.realpath(candidate);
          } catch {
            throw new WorkspaceSecurityError(
              "workspace_error",
              `Cannot resolve canonical path for directory "${segment}".`
            );
          }
          if (!isContainedWithinRoot(root.realPath, canonicalRace)) {
            throw new WorkspaceSecurityError(
              "access_denied",
              `Access denied: Directory "${segment}" escapes root boundary "${root.name}".`
            );
          }
          currentDir = canonicalRace;
          continue;
        }

        throw new WorkspaceSecurityError(
          "workspace_error",
          `Failed to create directory "${segment}" due to a filesystem error.`
        );
      }

      // Successfully created segment
      let canonicalNewDir: string;
      try {
        canonicalNewDir = await fs.realpath(candidate);
      } catch {
        throw new WorkspaceSecurityError(
          "workspace_error",
          `Failed to resolve realpath for newly created directory "${segment}".`
        );
      }
      if (!isContainedWithinRoot(root.realPath, canonicalNewDir)) {
        throw new WorkspaceSecurityError(
          "access_denied",
          `Access denied: Newly created directory "${segment}" escapes root boundary "${root.name}".`
        );
      }
      currentDir = canonicalNewDir;
    }
  }

  return currentDir;
}

/**
 * Performs a safe, atomic text file write or creation within an allowlisted workspace root.
 */
export async function writeTextFileService(
  workspaceConfig: WorkspaceConfig | undefined,
  input: WriteTextFileInput
): Promise<WriteTextFileResult> {
  const mode = input.mode;
  if (mode !== "create" && mode !== "overwrite") {
    throw new WorkspaceSecurityError(
      "invalid_input",
      `Invalid mode "${String(mode)}". Must be either "create" or "overwrite".`
    );
  }

  const isCreate = mode === "create";
  const createParents = isCreate ? input.createParents === true : false;

  if (!isCreate && input.createParents !== undefined) {
    throw new WorkspaceSecurityError(
      "invalid_input",
      "createParents is forbidden when mode is 'overwrite'."
    );
  }

  const content = input.content;

  if (typeof content !== "string") {
    throw new WorkspaceSecurityError("invalid_text_encoding", "File content must be a string.");
  }

  // Strict NUL rejection
  if (content.includes("\0")) {
    throw new WorkspaceSecurityError("invalid_text_encoding", "File content cannot contain NUL bytes.");
  }

  // Validate expectedSha256 rules
  if (isCreate) {
    if (input.expectedSha256 !== undefined && input.expectedSha256.trim().length > 0) {
      throw new WorkspaceSecurityError(
        "invalid_input",
        "expectedSha256 is forbidden when mode is 'create'."
      );
    }
  } else {
    // Mode is overwrite
    if (typeof input.expectedSha256 !== "string" || input.expectedSha256.trim().length === 0) {
      throw new WorkspaceSecurityError(
        "missing_expected_hash",
        `expectedSha256 is required when mode is "overwrite" for file "${input.path}".`
      );
    }

    if (!SHA256_HEX_REGEX.test(input.expectedSha256)) {
      throw new WorkspaceSecurityError(
        "invalid_hash",
        `Invalid expectedSha256 format for "${input.path}": expected 64-character lowercase hex string.`
      );
    }
  }

  const effectiveMaxBytes = Math.min(
    input.operatorPolicy?.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
    HARD_MAX_WRITE_BYTES
  );

  const contentBuffer = Buffer.from(content, "utf8");
  if (contentBuffer.byteLength > effectiveMaxBytes) {
    throw new WorkspaceSecurityError(
      "write_too_large",
      `Content size (${contentBuffer.byteLength} bytes) exceeds maximum permitted write size (${effectiveMaxBytes} bytes).`
    );
  }

  let resolved: ResolvedWritePathResult;

  if (isCreate && createParents) {
    const root = resolveRoot(workspaceConfig, input.rootId);
    const parentDir = await ensureParentDirectories(root, input.path);
    const fileName = path.basename(input.path.trim());
    if (!fileName || fileName === "." || fileName === "..") {
      throw new WorkspaceSecurityError("invalid_path", `Invalid filename for: "${input.path}".`);
    }
    const targetPath = path.join(parentDir, fileName);
    if (!isContainedWithinRoot(root.realPath, targetPath)) {
      throw new WorkspaceSecurityError(
        "access_denied",
        `Access denied: Path "${input.path}" escapes root boundary "${root.name}".`
      );
    }
    let targetLstat: Stats | undefined;
    try {
      targetLstat = await fs.lstat(targetPath);
    } catch {
      targetLstat = undefined;
    }
    if (targetLstat) {
      throw new WorkspaceSecurityError(
        "already_exists",
        `File already exists: "${input.path}" within root "${root.name}".`
      );
    }
    const relFromRoot = path.relative(root.realPath, targetPath) || fileName;
    resolved = {
      targetPath,
      relativeToRoot: relFromRoot,
      root,
      exists: false,
    };
  } else {
    resolved = await resolveWritePathWithinRoot(
      workspaceConfig,
      input.rootId,
      input.path,
      isCreate,
      createParents
    );
  }

  let previousSha256: string | undefined;
  let fileMode = 0o644;

  if (!isCreate) {
    const expectedSha256 = input.expectedSha256!;

    // Read current file content to verify expected SHA-256
    const currentBytes = await fs.readFile(resolved.targetPath);
    previousSha256 = crypto.createHash("sha256").update(currentBytes).digest("hex");

    if (previousSha256 !== expectedSha256) {
      throw new WorkspaceSecurityError(
        "content_conflict",
        `Content conflict for "${input.path}": current SHA-256 (${previousSha256}) does not match expected SHA-256 (${expectedSha256}).`
      );
    }

    // Preserve existing POSIX permissions where available
    if (resolved.stats) {
      fileMode = resolved.stats.mode & 0o777;
    }
  }

  const targetDir = path.dirname(resolved.targetPath);
  const { handle, tempPath: tempFilePath } = await createExclusiveTempFile(targetDir, fileMode);
  let tempFileCreated = true;

  try {
    try {
      await handle.writeFile(contentBuffer);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Injection seam for testing pre-publication race conditions
    if (prePublicationHookForTesting) {
      await prePublicationHookForTesting(resolved.targetPath);
    }

    // Injection seam for testing publication failure
    if (publicationFailureHookForTesting) {
      await publicationFailureHookForTesting();
    }

    // Pre-publication revalidations to minimize race windows
    // 1. Revalidate canonical parent directory containment
    const realParent = await fs.realpath(targetDir);
    if (!isContainedWithinRoot(resolved.root.realPath, realParent)) {
      throw new WorkspaceSecurityError(
        "access_denied",
        `Access denied: Parent directory escaped root boundary prior to commit.`
      );
    }

    if (isCreate) {
      // 2. For create: verify target still does not exist
      let targetExists = false;
      try {
        await fs.lstat(resolved.targetPath);
        targetExists = true;
      } catch {
        targetExists = false;
      }
      if (targetExists) {
        throw new WorkspaceSecurityError(
          "already_exists",
          `File "${input.path}" was created concurrently prior to commit.`
        );
      }

      // 3. Atomic No-Clobber Publication using fs.link
      try {
        await fs.link(tempFilePath, resolved.targetPath);
        // Successfully linked without clobbering; clean up temp hardlink
        await fs.unlink(tempFilePath);
        tempFileCreated = false;
      } catch (linkErr: any) {
        if (linkErr.code === "EEXIST") {
          throw new WorkspaceSecurityError(
            "already_exists",
            `File already exists: "${input.path}" within root "${resolved.root.name}".`
          );
        }
        if (linkErr.code === "EPERM") {
          let targetActuallyExists = false;
          try {
            await fs.lstat(resolved.targetPath);
            targetActuallyExists = true;
          } catch {
            targetActuallyExists = false;
          }
          if (targetActuallyExists) {
            throw new WorkspaceSecurityError(
              "already_exists",
              `File already exists: "${input.path}" within root "${resolved.root.name}".`
            );
          }
          throw new WorkspaceSecurityError(
            "workspace_error",
            `Cannot create file "${input.path}" due to filesystem permissions or hard-link policy.`
          );
        }
        if (
          linkErr.code === "ENOSYS" ||
          linkErr.code === "EXDEV" ||
          linkErr.code === "EOPNOTSUPP" ||
          linkErr.code === "ENOTSUP"
        ) {
          throw new WorkspaceSecurityError(
            "workspace_error",
            `Cannot create file "${input.path}" atomically: Filesystem does not support hard-link publication.`
          );
        }
        throw new WorkspaceSecurityError(
          "workspace_error",
          `Failed to publish file "${input.path}" due to a filesystem error.`
        );
      }
    } else {
      // For overwrite: verify target is still regular file and hash still matches
      let targetStats: Stats;
      try {
        targetStats = await fs.lstat(resolved.targetPath);
      } catch {
        throw new WorkspaceSecurityError(
          "not_found",
          `Target file "${input.path}" was deleted concurrently prior to commit.`
        );
      }

      if (!targetStats.isFile()) {
        throw new WorkspaceSecurityError(
          "unsupported_file_type",
          `Target "${input.path}" is no longer a regular file prior to commit.`
        );
      }

      const recheckedBytes = await fs.readFile(resolved.targetPath);
      const recheckedSha = crypto.createHash("sha256").update(recheckedBytes).digest("hex");
      if (recheckedSha !== previousSha256) {
        throw new WorkspaceSecurityError(
          "content_conflict",
          `Content conflict: Target file "${input.path}" was modified concurrently prior to commit.`
        );
      }

      // Atomically replace target file
      await fs.rename(tempFilePath, resolved.targetPath);
      tempFileCreated = false;
    }

    const newSha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");

    return {
      rootId: resolved.root.id,
      path: resolved.relativeToRoot,
      mode,
      bytesWritten: contentBuffer.byteLength,
      sha256: newSha256,
      previousSha256,
    };
  } catch (err) {
    if (tempFileCreated) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Ignore temp cleanup errors
      }
    }
    throw err;
  }
}

/**
 * Counts non-overlapping literal occurrences of search string within text.
 */
export function countNonOverlappingOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

/**
 * Performs transactional, exact literal text replacements on an existing file in a workspace root.
 */
export async function editTextFileService(
  workspaceConfig: WorkspaceConfig | undefined,
  input: EditTextFileInput
): Promise<EditTextFileResult> {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new WorkspaceSecurityError("invalid_path", "Edits array must contain at least one edit instruction.");
  }

  if (typeof input.expectedSha256 !== "string" || input.expectedSha256.trim().length === 0) {
    throw new WorkspaceSecurityError(
      "missing_expected_hash",
      `expectedSha256 is required for edit_text_file.`
    );
  }

  if (!SHA256_HEX_REGEX.test(input.expectedSha256)) {
    throw new WorkspaceSecurityError(
      "invalid_hash",
      `Invalid expectedSha256 format for "${input.path}": expected 64-character lowercase hex string.`
    );
  }

  const expectedSha256 = input.expectedSha256;

  // Validate each edit item
  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i];
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      throw new WorkspaceSecurityError(
        "occurrence_mismatch",
        `Edit[${i}] failed: oldText must be a non-empty string.`
      );
    }
    if (typeof edit.newText !== "string") {
      throw new WorkspaceSecurityError(
        "invalid_text_encoding",
        `Edit[${i}] failed: newText must be a string.`
      );
    }
    if (edit.oldText.includes("\0") || edit.newText.includes("\0")) {
      throw new WorkspaceSecurityError(
        "invalid_text_encoding",
        `Edit[${i}] failed: oldText and newText cannot contain NUL bytes.`
      );
    }
    if (
      edit.expectedOccurrences !== undefined &&
      (!Number.isSafeInteger(edit.expectedOccurrences) || edit.expectedOccurrences < 1)
    ) {
      throw new WorkspaceSecurityError(
        "occurrence_mismatch",
        `Edit[${i}] failed: expectedOccurrences must be a positive integer (>= 1).`
      );
    }
  }

  const effectiveMaxBytes = Math.min(
    input.operatorPolicy?.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
    HARD_MAX_WRITE_BYTES
  );

  const resolved = await resolveWritePathWithinRoot(
    workspaceConfig,
    input.rootId,
    input.path,
    false // Not create, must be existing regular file
  );

  if (resolved.stats && resolved.stats.size > effectiveMaxBytes) {
    throw new WorkspaceSecurityError(
      "write_too_large",
      `Target file size (${resolved.stats.size} bytes) exceeds maximum editable size (${effectiveMaxBytes} bytes).`
    );
  }

  // Read full current file bytes
  const currentBytes = await fs.readFile(resolved.targetPath);
  const previousSha256 = crypto.createHash("sha256").update(currentBytes).digest("hex");

  if (previousSha256 !== expectedSha256) {
    throw new WorkspaceSecurityError(
      "content_conflict",
      `Content conflict for "${input.path}": current SHA-256 (${previousSha256}) does not match expected SHA-256 (${expectedSha256}).`
    );
  }

  // Strict fatal UTF-8 decoding with BOM preservation
  let currentText: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    currentText = decoder.decode(currentBytes);
  } catch {
    throw new WorkspaceSecurityError(
      "invalid_text_encoding",
      `Target file "${input.path}" contains invalid UTF-8 byte sequences.`
    );
  }

  // Reject files with embedded NUL bytes
  if (currentText.includes("\0")) {
    throw new WorkspaceSecurityError(
      "invalid_text_encoding",
      `Target file "${input.path}" contains NUL bytes.`
    );
  }

  // Apply edits sequentially in memory (transactional evaluation)
  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i];
    const expectedCount = edit.expectedOccurrences ?? 1;
    const actualCount = countNonOverlappingOccurrences(currentText, edit.oldText);

    if (actualCount !== expectedCount) {
      throw new WorkspaceSecurityError(
        "occurrence_mismatch",
        `Edit[${i}] failed: expected ${expectedCount} non-overlapping occurrence(s) of "${edit.oldText.slice(0, 40)}", but found ${actualCount}.`
      );
    }

    // Exact literal replacement using replacer function to prevent $ replacement pattern expansion
    currentText = currentText.replaceAll(edit.oldText, () => edit.newText);
  }

  // Reject resulting text containing NUL bytes
  if (currentText.includes("\0")) {
    throw new WorkspaceSecurityError(
      "invalid_text_encoding",
      `Resulting text for "${input.path}" contains NUL bytes.`
    );
  }

  const newBytes = Buffer.from(currentText, "utf8");
  if (newBytes.byteLength > effectiveMaxBytes) {
    throw new WorkspaceSecurityError(
      "write_too_large",
      `Resulting file size (${newBytes.byteLength} bytes) exceeds maximum permitted write size (${effectiveMaxBytes} bytes).`
    );
  }

  // Capture mode for preservation
  const fileMode = resolved.stats ? (resolved.stats.mode & 0o777) : 0o644;

  // Atomic replacement
  const targetDir = path.dirname(resolved.targetPath);
  const { handle, tempPath: tempFilePath } = await createExclusiveTempFile(targetDir, fileMode);
  let tempFileCreated = true;

  try {
    try {
      await handle.writeFile(newBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (prePublicationHookForTesting) {
      await prePublicationHookForTesting(resolved.targetPath);
    }

    if (publicationFailureHookForTesting) {
      await publicationFailureHookForTesting();
    }

    // Pre-rename revalidation
    const realParent = await fs.realpath(targetDir);
    if (!isContainedWithinRoot(resolved.root.realPath, realParent)) {
      throw new WorkspaceSecurityError(
        "access_denied",
        `Access denied: Parent directory escaped root boundary prior to commit.`
      );
    }

    let targetStats: Stats;
    try {
      targetStats = await fs.lstat(resolved.targetPath);
    } catch {
      throw new WorkspaceSecurityError(
        "not_found",
        `Target file "${input.path}" was deleted concurrently prior to commit.`
      );
    }

    if (!targetStats.isFile()) {
      throw new WorkspaceSecurityError(
        "unsupported_file_type",
        `Target "${input.path}" is no longer a regular file prior to commit.`
      );
    }

    const recheckedBytes = await fs.readFile(resolved.targetPath);
    const recheckedSha = crypto.createHash("sha256").update(recheckedBytes).digest("hex");
    if (recheckedSha !== previousSha256) {
      throw new WorkspaceSecurityError(
        "content_conflict",
        `Content conflict: Target file "${input.path}" was modified concurrently prior to commit.`
      );
    }

    await fs.rename(tempFilePath, resolved.targetPath);
    tempFileCreated = false;

    const newSha256 = crypto.createHash("sha256").update(newBytes).digest("hex");

    return {
      rootId: resolved.root.id,
      path: resolved.relativeToRoot,
      editsApplied: input.edits.length,
      bytesWritten: newBytes.byteLength,
      sha256: newSha256,
      previousSha256,
    };
  } catch (err) {
    if (tempFileCreated) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Ignore temp cleanup errors
      }
    }
    throw err;
  }
}

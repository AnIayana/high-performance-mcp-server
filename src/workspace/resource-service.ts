import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { WorkspaceConfig } from "../config/workspace.js";
import { detectMimeType } from "./mime.js";
import { resolveExistingPathWithinRoot } from "./path-security.js";
import { createWorkspaceResourceUri, parseWorkspaceResourceUri } from "./resource-uri.js";
import { WorkspaceSecurityError } from "./types.js";
import {
  DEFAULT_MAX_RESOURCE_BYTES,
  HARD_MAX_RESOURCE_BYTES,
  type WorkspaceOperatorPolicy,
} from "./write-service.js";

let _sizeRaceHookForTesting: ((targetPath: string) => Promise<void> | void) | undefined;

/**
 * Testing seam to simulate a file growing between the initial stat check and read.
 * @internal
 */
export function _setSizeRaceHookForTesting(
  hook: ((targetPath: string) => Promise<void> | void) | undefined
): void {
  _sizeRaceHookForTesting = hook;
}

export interface ReadWorkspaceResourceResult {
  readonly uri: string;
  readonly rootId: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly text: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Performs a safe, complete, read-only workspace resource read.
 * Guarantees:
 * - Confined within allowed workspace roots
 * - No directory or special file access (regular text files only)
 * - Complete reads only (no silent truncation)
 * - Strict size checking (stat check + buffer bound defense in depth)
 * - Strict UTF-8 fatal decoding
 * - Binary / NUL byte rejection
 * - Error privacy: sanitized error messages with no server absolute paths
 */
export async function readWorkspaceResourceService(
  workspaceConfig: WorkspaceConfig | undefined,
  uriOrParsed: string | URL | { rootId: string; relativePath: string },
  operatorPolicy?: WorkspaceOperatorPolicy
): Promise<ReadWorkspaceResourceResult> {
  let rootId: string;
  let relativePath: string;

  if (typeof uriOrParsed === "string" || uriOrParsed instanceof URL) {
    const parsed = parseWorkspaceResourceUri(uriOrParsed);
    rootId = parsed.rootId;
    relativePath = parsed.relativePath;
  } else {
    rootId = uriOrParsed.rootId;
    relativePath = uriOrParsed.relativePath;
  }

  if (!workspaceConfig || !Array.isArray(workspaceConfig.roots) || workspaceConfig.roots.length === 0) {
    throw new WorkspaceSecurityError(
      "resource_not_found",
      "No workspace roots configured for this server instance."
    );
  }

  let resolved;
  try {
    resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("does not exist") || message.includes("Cannot access target path")) {
      throw new WorkspaceSecurityError("resource_not_found", `Resource not found: "${relativePath}" in root "${rootId}".`);
    }
    if (message.includes("Access denied")) {
      throw new WorkspaceSecurityError("access_denied", `Access denied: "${relativePath}" in root "${rootId}".`);
    }
    throw new WorkspaceSecurityError("resource_not_found", `Failed to resolve resource "${relativePath}": ${message}`);
  }

  if (!resolved.stats.isFile()) {
    throw new WorkspaceSecurityError(
      "unsupported_file_type",
      `Target "${relativePath}" in root "${rootId}" is not a regular file (type: ${
        resolved.stats.isDirectory() ? "directory" : "special file"
      }).`
    );
  }

  const effectiveMaxBytes = Math.min(
    operatorPolicy?.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
    HARD_MAX_RESOURCE_BYTES
  );

  // 1. Initial size check before reading
  if (resolved.stats.size > effectiveMaxBytes) {
    throw new WorkspaceSecurityError(
      "resource_too_large",
      `Resource "${relativePath}" (${resolved.stats.size} bytes) exceeds maximum allowed size of ${effectiveMaxBytes} bytes.`
    );
  }

  // Testing hook for size race simulation
  if (_sizeRaceHookForTesting) {
    await _sizeRaceHookForTesting(resolved.resolvedPath);
  }

  // 2. Bounded file reading (allocates at most effectiveMaxBytes + 1 bytes)
  let fileBuffer: Buffer;
  let fileHandle: fs.FileHandle | undefined;
  try {
    fileHandle = await fs.open(resolved.resolvedPath, "r");
    const boundedBufferSize = effectiveMaxBytes + 1;
    const boundedBuffer = Buffer.allocUnsafe(boundedBufferSize);
    let totalBytesRead = 0;

    while (totalBytesRead < boundedBufferSize) {
      const { bytesRead } = await fileHandle.read(
        boundedBuffer,
        totalBytesRead,
        boundedBufferSize - totalBytesRead,
        totalBytesRead
      );
      if (bytesRead === 0) {
        break; // EOF reached
      }
      totalBytesRead += bytesRead;
    }

    // 3. Bound defense in depth (detects file growth beyond limit without unbounded allocation)
    if (totalBytesRead > effectiveMaxBytes) {
      throw new WorkspaceSecurityError(
        "resource_too_large",
        `Resource "${relativePath}" exceeds maximum allowed size of ${effectiveMaxBytes} bytes.`
      );
    }

    fileBuffer = boundedBuffer.subarray(0, totalBytesRead);
  } catch (err) {
    if (err instanceof WorkspaceSecurityError) {
      throw err;
    }
    throw new WorkspaceSecurityError(
      "resource_not_found",
      `Failed to read resource "${relativePath}" in root "${rootId}".`
    );
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }

  // 4. Strict NUL byte rejection (text only)
  if (fileBuffer.includes(0x00)) {
    throw new WorkspaceSecurityError(
      "invalid_text_encoding",
      `Resource "${relativePath}" contains NUL bytes or unsupported binary encoding.`
    );
  }

  // 5. Strict UTF-8 fatal decoding
  let decodedText: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    decodedText = decoder.decode(fileBuffer);
  } catch {
    throw new WorkspaceSecurityError(
      "invalid_text_encoding",
      `Resource "${relativePath}" is not valid UTF-8 text.`
    );
  }

  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const mimeType = detectMimeType(relativePath);
  const canonicalUri = createWorkspaceResourceUri(rootId, relativePath);

  return {
    uri: canonicalUri,
    rootId,
    relativePath,
    mimeType,
    text: decodedText,
    sizeBytes: fileBuffer.byteLength,
    sha256,
  };
}

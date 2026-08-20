import fs from "node:fs/promises";
import type { WorkspaceConfig } from "../config/workspace.js";
import {
  DEFAULT_TEXT_READ_BYTES,
  MAX_DIRECTORY_ENTRIES,
  MAX_TEXT_READ_BYTES,
  resolveExistingPathWithinRoot,
} from "./path-security.js";

export interface DirectoryEntryItem {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface ListDirectoryResult {
  rootId: string;
  path: string;
  entries: DirectoryEntryItem[];
  totalEntries: number;
  truncated: boolean;
}

export interface FileInfoResult {
  rootId: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
  isSymlink: boolean;
}

export interface ReadTextFileResult {
  rootId: string;
  path: string;
  text: string;
  sizeBytes: number;
  bytesRead: number;
  truncated: boolean;
  encoding: "utf-8";
}

/**
 * Lists directory entries within an allowed workspace root with deterministic sorting and 500 entry limit.
 */
export async function listDirectoryService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string = "."
): Promise<ListDirectoryResult> {
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);

  if (!resolved.isDirectory) {
    throw new Error(`Target is not a directory: "${relativePath}" within root "${resolved.root.name}".`);
  }

  const dirEntries = await fs.readdir(resolved.resolvedPath, { withFileTypes: true });

  const mappedEntries: DirectoryEntryItem[] = dirEntries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symlink"
          : "other",
  }));

  // Sort: directories first, then files, then other, then alphabetical
  mappedEntries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    if (a.type === "file" && b.type !== "file") return -1;
    if (a.type !== "file" && b.type === "file") return 1;
    return a.name.localeCompare(b.name);
  });

  const totalEntries = mappedEntries.length;
  const truncated = totalEntries > MAX_DIRECTORY_ENTRIES;
  const entries = truncated ? mappedEntries.slice(0, MAX_DIRECTORY_ENTRIES) : mappedEntries;

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    entries,
    totalEntries,
    truncated,
  };
}

/**
 * Gets detailed metadata for a file or directory within an allowed workspace root.
 */
export async function getFileInfoService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string
): Promise<FileInfoResult> {
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);

  const entryType = resolved.isDirectory
    ? "directory"
    : resolved.isFile
      ? "file"
      : resolved.isSymlink
        ? "symlink"
        : "other";

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    type: entryType,
    sizeBytes: resolved.stats.size,
    modifiedAt: resolved.stats.mtime.toISOString(),
    createdAt: resolved.stats.birthtime.toISOString(),
    isSymlink: resolved.isSymlink,
  };
}

/**
 * Reads a text file within an allowed workspace root with binary detection and size limits.
 */
export async function readTextFileService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string,
  maxBytes: number = DEFAULT_TEXT_READ_BYTES
): Promise<ReadTextFileResult> {
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);

  if (!resolved.isFile) {
    throw new Error(
      `Target is not a file: "${relativePath}" is a ${resolved.isDirectory ? "directory" : "special entry"}.`
    );
  }

  const requestedLimit = Math.max(1, Math.min(MAX_TEXT_READ_BYTES, Math.floor(maxBytes)));
  const bufferToRead = Buffer.alloc(requestedLimit + 1);

  const fileHandle = await fs.open(resolved.resolvedPath, "r");
  let bytesRead = 0;
  try {
    const readResult = await fileHandle.read(bufferToRead, 0, requestedLimit + 1, 0);
    bytesRead = readResult.bytesRead;
  } finally {
    await fileHandle.close();
  }

  const slice = bufferToRead.subarray(0, bytesRead);

  // Binary detection: check for NUL bytes in read content
  if (slice.includes(0)) {
    throw new Error(
      `File appears to be binary. Binary reads are not supported by read_text_file: "${relativePath}".`
    );
  }

  const truncated = resolved.stats.size > requestedLimit || bytesRead > requestedLimit;
  const actualBytesCount = Math.min(bytesRead, requestedLimit);
  const text = slice.subarray(0, actualBytesCount).toString("utf8");

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    text,
    sizeBytes: resolved.stats.size,
    bytesRead: actualBytesCount,
    truncated,
    encoding: "utf-8",
  };
}

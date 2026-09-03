import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceConfig } from "../config/workspace.js";
import {
  DEFAULT_TEXT_READ_BYTES,
  MAX_DIRECTORY_ENTRIES,
  MAX_TEXT_READ_BYTES,
  isContainedWithinRoot,
  resolveExistingPathWithinRoot,
} from "./path-security.js";

export interface DirectoryEntryItem {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  relativePath?: string;
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
  sha256?: string;
}

/**
 * Lists directory entries within an allowed workspace root with deterministic sorting, optional recursion, and 500 entry limit.
 */
export async function listDirectoryService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string = ".",
  maxDepth: number = 1
): Promise<ListDirectoryResult> {
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);

  if (!resolved.isDirectory) {
    throw new Error(`Target is not a directory: "${relativePath}" within root "${resolved.root.name}".`);
  }

  const effectiveMaxDepth =
    typeof maxDepth === "number" && Number.isSafeInteger(maxDepth)
      ? Math.max(1, Math.min(5, maxDepth))
      : 1;

  if (effectiveMaxDepth === 1) {
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

  // Recursive BFS traversal for maxDepth > 1
  const allEntries: DirectoryEntryItem[] = [];
  interface QueueItem {
    absDir: string;
    relFromQuery: string;
    depth: number;
  }

  const queue: QueueItem[] = [
    {
      absDir: resolved.resolvedPath,
      relFromQuery: "",
      depth: 0,
    },
  ];

  let hitTruncation = false;

  while (queue.length > 0) {
    const current = queue.shift()!;

    let dirEntries: import("node:fs").Dirent[];
    try {
      dirEntries = await fs.readdir(current.absDir, { withFileTypes: true });
    } catch {
      // If unable to read directory (e.g. permissions or vanished mid-traversal), continue gracefully
      continue;
    }

    const currentLevelEntries: Array<{
      item: DirectoryEntryItem;
      dirent: import("node:fs").Dirent;
      relPath: string;
      absPath: string;
    }> = [];

    for (const entry of dirEntries) {
      const isDir = entry.isDirectory();
      const isFile = entry.isFile();
      const isSymlink = entry.isSymbolicLink();
      const entryType: "file" | "directory" | "symlink" | "other" = isDir
        ? "directory"
        : isFile
          ? "file"
          : isSymlink
            ? "symlink"
            : "other";

      const relPath = current.relFromQuery
        ? `${current.relFromQuery}/${entry.name}`
        : entry.name;

      currentLevelEntries.push({
        item: {
          name: entry.name,
          type: entryType,
          relativePath: relPath,
        },
        dirent: entry,
        relPath,
        absPath: path.join(current.absDir, entry.name),
      });
    }

    // Sort using the exact same comparator: directories first, then files, then other, then alphabetical
    currentLevelEntries.sort((a, b) => {
      if (a.item.type === "directory" && b.item.type !== "directory") return -1;
      if (a.item.type !== "directory" && b.item.type === "directory") return 1;
      if (a.item.type === "file" && b.item.type !== "file") return -1;
      if (a.item.type !== "file" && b.item.type === "file") return 1;
      return a.item.name.localeCompare(b.item.name);
    });

    for (const entry of currentLevelEntries) {
      if (allEntries.length >= MAX_DIRECTORY_ENTRIES) {
        hitTruncation = true;
        break;
      }
      allEntries.push(entry.item);

      // Recurse into directories if depth allows (DO NOT follow symlinks)
      if (
        entry.item.type === "directory" &&
        !entry.dirent.isSymbolicLink() &&
        current.depth + 1 < effectiveMaxDepth
      ) {
        try {
          const realSubDir = await fs.realpath(entry.absPath);
          if (isContainedWithinRoot(resolved.root.realPath, realSubDir)) {
            queue.push({
              absDir: entry.absPath,
              relFromQuery: entry.relPath,
              depth: current.depth + 1,
            });
          }
        } catch {
          // Skip if resolving realpath fails
        }
      }
    }

    if (hitTruncation) {
      break;
    }
  }

  const totalEntries = allEntries.length;
  const truncated = hitTruncation || totalEntries > MAX_DIRECTORY_ENTRIES;
  const entries = allEntries.slice(0, MAX_DIRECTORY_ENTRIES);

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
  const sha256 = !truncated
    ? crypto.createHash("sha256").update(slice.subarray(0, actualBytesCount)).digest("hex")
    : undefined;

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    text,
    sizeBytes: resolved.stats.size,
    bytesRead: actualBytesCount,
    truncated,
    encoding: "utf-8",
    sha256,
  };
}

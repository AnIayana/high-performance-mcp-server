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
import { COMMON_SEARCH_IGNORED_DIRECTORIES } from "./search.js";

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

export interface FileInfoOptions {
  readonly includeSha256?: boolean;
}

export interface FileInfoResult {
  rootId: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
  isSymlink: boolean;
  sha256?: string;
}

export interface ReadTextFileOptions {
  readonly maxBytes?: number;
  readonly startLine?: number;
  readonly endLine?: number;
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
  startLine?: number;
  endLine?: number;
  totalLines?: number;
}

/**
 * Lists directory entries within an allowed workspace root with deterministic sorting, optional recursion, and 500 entry limit.
 */
export async function listDirectoryService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string = ".",
  maxDepth: number = 1,
  excludeIgnored: boolean = false
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
    const filteredEntries = excludeIgnored
      ? dirEntries.filter(
          (entry) => !(entry.isDirectory() && COMMON_SEARCH_IGNORED_DIRECTORIES.has(entry.name))
        )
      : dirEntries;

    const mappedEntries: DirectoryEntryItem[] = filteredEntries.map((entry) => ({
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
      if (excludeIgnored && isDir && COMMON_SEARCH_IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
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
  relativePath: string,
  options: FileInfoOptions = {}
): Promise<FileInfoResult> {
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);

  const entryType = resolved.isDirectory
    ? "directory"
    : resolved.isFile
      ? "file"
      : resolved.isSymlink
        ? "symlink"
        : "other";

  let sha256: string | undefined;
  if (
    options.includeSha256 === true &&
    resolved.isFile &&
    resolved.stats.size <= MAX_TEXT_READ_BYTES
  ) {
    const buf = await fs.readFile(resolved.resolvedPath);
    if (buf.length <= MAX_TEXT_READ_BYTES) {
      sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    }
  }

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    type: entryType,
    sizeBytes: resolved.stats.size,
    modifiedAt: resolved.stats.mtime.toISOString(),
    createdAt: resolved.stats.birthtime.toISOString(),
    isSymlink: resolved.isSymlink,
    ...(sha256 !== undefined ? { sha256 } : {}),
  };
}

/**
 * Splits UTF-8 text into 1-based lines while preserving original line endings (\n or \r\n).
 */
function splitLinesPreservingEndings(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * Strips any incomplete trailing multi-byte UTF-8 sequence when slicing by byte limit.
 */
function trimIncompleteUtf8Slice(buf: Buffer): Buffer {
  const len = buf.length;
  if (len === 0) return buf;
  for (let i = 1; i <= 4 && i <= len; i++) {
    const byte = buf[len - i]!;
    if ((byte & 0x80) === 0) return buf;
    if ((byte & 0xe0) === 0xc0) return i < 2 ? buf.subarray(0, len - i) : buf;
    if ((byte & 0xf0) === 0xe0) return i < 3 ? buf.subarray(0, len - i) : buf;
    if ((byte & 0xf8) === 0xf0) return i < 4 ? buf.subarray(0, len - i) : buf;
  }
  return buf;
}

/**
 * Reads a text file within an allowed workspace root with binary detection, size limits, and optional 1-based line range slicing.
 */
export async function readTextFileService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  relativePath: string,
  maxBytesOrOptions: number | ReadTextFileOptions = DEFAULT_TEXT_READ_BYTES
): Promise<ReadTextFileResult> {
  const options: ReadTextFileOptions =
    typeof maxBytesOrOptions === "number"
      ? { maxBytes: maxBytesOrOptions }
      : maxBytesOrOptions ?? {};

  const maxBytes = options.maxBytes ?? DEFAULT_TEXT_READ_BYTES;
  const { startLine, endLine } = options;

  if (startLine !== undefined) {
    if (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1) {
      throw new Error("Invalid startLine parameter: Must be a positive integer (>= 1).");
    }
  }

  if (endLine !== undefined) {
    if (typeof endLine !== "number" || !Number.isSafeInteger(endLine) || endLine < 1) {
      throw new Error("Invalid endLine parameter: Must be a positive integer (>= 1).");
    }
  }

  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new Error(
      `Invalid line range: endLine (${endLine}) cannot be less than startLine (${startLine}).`
    );
  }

  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, relativePath);

  if (!resolved.isFile) {
    throw new Error(
      `Target is not a file: "${relativePath}" is a ${resolved.isDirectory ? "directory" : "special entry"}.`
    );
  }

  const requestedLimit = Math.max(1, Math.min(MAX_TEXT_READ_BYTES, Math.floor(maxBytes)));
  const hasLineRange = startLine !== undefined || endLine !== undefined;

  if (!hasLineRange) {
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

  // Line-range mode: read up to MAX_TEXT_READ_BYTES + 1 so target lines anywhere within the 1 MiB ceiling can be sliced
  const bufferToRead = Buffer.alloc(MAX_TEXT_READ_BYTES + 1);
  const fileHandle = await fs.open(resolved.resolvedPath, "r");
  let bytesRead = 0;
  try {
    const readResult = await fileHandle.read(bufferToRead, 0, MAX_TEXT_READ_BYTES + 1, 0);
    bytesRead = readResult.bytesRead;
  } finally {
    await fileHandle.close();
  }

  const rawSlice = bufferToRead.subarray(0, bytesRead);

  // Binary detection: check for NUL bytes in read content
  if (rawSlice.includes(0)) {
    throw new Error(
      `File appears to be binary. Binary reads are not supported by read_text_file: "${relativePath}".`
    );
  }

  const fileExceedsHardCap =
    resolved.stats.size > MAX_TEXT_READ_BYTES || bytesRead > MAX_TEXT_READ_BYTES;
  const fullSlice = trimIncompleteUtf8Slice(
    rawSlice.subarray(0, Math.min(bytesRead, MAX_TEXT_READ_BYTES))
  );
  const fullText = fullSlice.toString("utf8");
  const lines = splitLinesPreservingEndings(fullText);
  const totalLines = lines.length;

  const effectiveStartLine = startLine ?? 1;
  const effectiveEndLine = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;

  const selectedLines =
    effectiveStartLine <= totalLines
      ? lines.slice(effectiveStartLine - 1, effectiveEndLine)
      : [];
  const joinedText = selectedLines.join("");
  const joinedBuffer = Buffer.from(joinedText, "utf8");

  const byteTruncated = joinedBuffer.byteLength > requestedLimit;
  const finalBuffer = byteTruncated
    ? trimIncompleteUtf8Slice(joinedBuffer.subarray(0, requestedLimit))
    : joinedBuffer;
  const text = finalBuffer.toString("utf8");
  const actualBytesCount = finalBuffer.byteLength;

  const isPartialRange =
    totalLines > 0
      ? effectiveStartLine > 1 || effectiveEndLine < totalLines
      : effectiveStartLine > 1;
  const truncated = fileExceedsHardCap || byteTruncated || isPartialRange;
  const sha256 = !truncated
    ? crypto.createHash("sha256").update(fullSlice).digest("hex")
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
    startLine: effectiveStartLine,
    endLine: effectiveStartLine <= totalLines ? effectiveEndLine : totalLines,
    totalLines,
  };
}

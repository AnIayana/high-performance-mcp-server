import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { WorkspaceConfig } from "../config/workspace.js";
import { resolveExistingPathWithinRoot } from "./path-security.js";

export const DEFAULT_SEARCH_MAX_RESULTS = 100;
export const MAX_SEARCH_RESULTS = 500;

export const DEFAULT_SEARCH_MAX_FILES = 5000;
export const MAX_SEARCH_FILES = 50000;

export const DEFAULT_SEARCH_TIMEOUT_MS = 10000;
export const MAX_SEARCH_TIMEOUT_MS = 30000;

export const MAX_SEARCH_QUERY_LENGTH = 256;
export const MAX_SEARCH_FILE_BYTES = 1048576; // 1 MiB
export const MAX_SEARCH_DEPTH = 64;
export const SEARCH_CONCURRENCY = 8;
export const MAX_PREVIEW_LENGTH = 300;

export const COMMON_SEARCH_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
]);

export type SearchStopReason =
  | "completed"
  | "max_results"
  | "max_files"
  | "timeout";

export type SearchFileKind = "file" | "directory" | "all";

export interface SearchFileEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

export interface SearchFilesOptions {
  readonly path?: string;
  readonly caseSensitive?: boolean;
  readonly kind?: SearchFileKind;
  readonly includeIgnored?: boolean;
  readonly maxResults?: number;
  readonly maxFiles?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (scannedCount: number) => Promise<void> | void;
  readonly now?: () => number;
}

export interface SearchFilesResult {
  readonly rootId: string;
  readonly path: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly kind: SearchFileKind;
  readonly results: readonly SearchFileEntry[];
  readonly scannedEntries: number;
  readonly matchedEntries: number;
  readonly truncated: boolean;
  readonly stopReason: SearchStopReason;
  readonly durationMs: number;
}

export interface SearchTextOptions {
  readonly path?: string;
  readonly caseSensitive?: boolean;
  readonly includeIgnored?: boolean;
  readonly extensions?: readonly string[];
  readonly maxResults?: number;
  readonly maxFiles?: number;
  readonly timeoutMs?: number;
  readonly contextLines?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (scannedCount: number) => Promise<void> | void;
  readonly now?: () => number;
}

export interface SearchTextMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly contextBefore?: readonly string[];
  readonly contextAfter?: readonly string[];
}

export interface SearchTextResult {
  readonly rootId: string;
  readonly path: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly extensions?: readonly string[];
  readonly results: readonly SearchTextMatch[];
  readonly scannedFiles: number;
  readonly skippedBinaryFiles: number;
  readonly skippedLargeFiles: number;
  readonly matchedFiles: number;
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly stopReason: SearchStopReason;
  readonly durationMs: number;
}

/**
 * Normalizes an array of file extension filters (e.g. ['ts', '.TS', 'md'] -> ['.ts', '.md']).
 */
export function normalizeExtensions(rawExtensions?: readonly string[]): string[] | undefined {
  if (!rawExtensions || rawExtensions.length === 0) return undefined;
  if (rawExtensions.length > 32) {
    throw new Error("Too many extensions specified (maximum allowed is 32).");
  }
  const set = new Set<string>();
  for (const ext of rawExtensions) {
    if (typeof ext !== "string" || ext.trim().length === 0) {
      throw new Error("Invalid extension: must be a non-empty string.");
    }
    const trimmed = ext.trim().toLowerCase();
    if (trimmed.length > 16) {
      throw new Error(`Extension "${trimmed}" exceeds maximum length of 16 characters.`);
    }
    const normalized = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    set.add(normalized);
  }
  return Array.from(set);
}

/**
 * Normalizes relative path separators to forward slashes across platforms.
 */
function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

/**
 * Formats a single context line with carriage-return stripping and MAX_PREVIEW_LENGTH (300) truncation.
 */
export function formatContextLine(line: string): string {
  const cleanLine = line.replace(/\r$/, "");
  if (cleanLine.length <= MAX_PREVIEW_LENGTH) {
    return cleanLine;
  }
  return cleanLine.slice(0, MAX_PREVIEW_LENGTH) + "...";
}

/**
 * Creates a trimmed line preview around a character match index (max 300 chars).
 */
export function formatLinePreview(line: string, matchIndex: number, matchLength: number): string {
  // Strip carriage returns or trailing whitespace
  const cleanLine = line.replace(/\r$/, "");
  if (cleanLine.length <= MAX_PREVIEW_LENGTH) {
    return cleanLine;
  }

  const halfWindow = Math.floor((MAX_PREVIEW_LENGTH - matchLength) / 2);
  let start = Math.max(0, matchIndex - halfWindow);
  let end = Math.min(cleanLine.length, start + MAX_PREVIEW_LENGTH);

  if (end - start < MAX_PREVIEW_LENGTH && start > 0) {
    start = Math.max(0, end - MAX_PREVIEW_LENGTH);
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < cleanLine.length ? "..." : "";
  return prefix + cleanLine.slice(start, end) + suffix;
}

/**
 * Searches file and directory names within an allowed workspace root using literal matching.
 */
export async function searchFilesService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  query: string,
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const clock = options.now ?? performance.now.bind(performance);
  const startTime = clock();

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Invalid query parameter: Query must be a non-empty string.");
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(
      `Query length (${query.length}) exceeds maximum limit of ${MAX_SEARCH_QUERY_LENGTH} characters.`
    );
  }

  const requestedStartPath = options.path ?? ".";
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, requestedStartPath);
  if (!resolved.isDirectory) {
    throw new Error(
      `Search start path is not a directory: "${requestedStartPath}" within root "${resolved.root.name}".`
    );
  }

  const caseSensitive = options.caseSensitive ?? false;
  const kind = options.kind ?? "all";
  const includeIgnored = options.includeIgnored ?? false;
  const effectiveMaxResults = Math.max(
    1,
    Math.min(MAX_SEARCH_RESULTS, options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS)
  );
  const effectiveMaxFiles = Math.max(
    1,
    Math.min(MAX_SEARCH_FILES, options.maxFiles ?? DEFAULT_SEARCH_MAX_FILES)
  );
  const effectiveTimeoutMs = Math.max(
    100,
    Math.min(MAX_SEARCH_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
  );

  const normalizedQuery = caseSensitive ? query : query.toLowerCase();

  const results: SearchFileEntry[] = [];
  let scannedEntries = 0;
  let lastEmittedProgress = 0;
  let stopReason: SearchStopReason = "completed";

  interface WalkItem {
    absDir: string;
    relDir: string;
    depth: number;
  }

  const startRel = resolved.relativeToRoot === "." ? "" : toPosixPath(resolved.relativeToRoot);
  const queue: WalkItem[] = [
    {
      absDir: resolved.resolvedPath,
      relDir: startRel,
      depth: 0,
    },
  ];

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      throw new DOMException("Search operation was aborted", "AbortError");
    }

    if (clock() - startTime >= effectiveTimeoutMs) {
      stopReason = "timeout";
      break;
    }

    const current = queue.shift()!;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absDir, { withFileTypes: true });
    } catch {
      // If unable to read directory (e.g. permissions), continue
      continue;
    }

    for (const dirent of entries) {
      if (options.signal?.aborted) {
        throw new DOMException("Search operation was aborted", "AbortError");
      }

      if (clock() - startTime >= effectiveTimeoutMs) {
        stopReason = "timeout";
        break;
      }

      scannedEntries++;
      if (scannedEntries % 250 === 0 && options.onProgress) {
        lastEmittedProgress = scannedEntries;
        try {
          await options.onProgress(scannedEntries);
        } catch {
          // Progress failure must never abort the search
        }
      }

      if (scannedEntries > effectiveMaxFiles) {
        stopReason = "max_files";
        break;
      }

      const isDir = dirent.isDirectory();
      const isFile = dirent.isFile();
      const isSymlink = dirent.isSymbolicLink();
      const entryType: "file" | "directory" | "symlink" | "other" = isFile
        ? "file"
        : isDir
          ? "directory"
          : isSymlink
            ? "symlink"
            : "other";

      const entryRelPath = current.relDir
        ? `${current.relDir}/${dirent.name}`
        : dirent.name;

      // Skip ignored directories if not explicitly included
      if (!includeIgnored && isDir && COMMON_SEARCH_IGNORED_DIRECTORIES.has(dirent.name)) {
        continue;
      }

      // Check kind filter
      let matchesKind = false;
      if (kind === "all") {
        matchesKind = true;
      } else if (kind === "file") {
        matchesKind = isFile;
      } else if (kind === "directory") {
        matchesKind = isDir;
      }

      if (matchesKind) {
        const nameToMatch = caseSensitive ? dirent.name : dirent.name.toLowerCase();
        const pathToMatch = caseSensitive ? entryRelPath : entryRelPath.toLowerCase();

        if (nameToMatch.includes(normalizedQuery) || pathToMatch.includes(normalizedQuery)) {
          results.push({
            path: entryRelPath,
            name: dirent.name,
            type: entryType,
          });

          if (results.length >= effectiveMaxResults) {
            stopReason = "max_results";
            break;
          }
        }
      }

      // Recurse into directories (DO NOT follow symlink directories)
      if (isDir && !isSymlink && current.depth < MAX_SEARCH_DEPTH) {
        queue.push({
          absDir: path.join(current.absDir, dirent.name),
          relDir: entryRelPath,
          depth: current.depth + 1,
        });
      }
    }

    if (stopReason !== "completed") {
      break;
    }
  }

  // Final progress notification if scanned entries exist and was not already emitted by cadence
  if (
    scannedEntries > 0 &&
    scannedEntries !== lastEmittedProgress &&
    options.onProgress &&
    !options.signal?.aborted
  ) {
    try {
      await options.onProgress(scannedEntries);
    } catch {
      // Progress failure must never abort the search
    }
  }

  // Deterministic sorting by path
  results.sort((a, b) => a.path.localeCompare(b.path));

  const durationMs = Number((clock() - startTime).toFixed(2));
  const truncated = stopReason !== "completed";

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    query,
    caseSensitive,
    kind,
    results,
    scannedEntries,
    matchedEntries: results.length,
    truncated,
    stopReason,
    durationMs,
  };
}

/**
 * Searches UTF-8 text files inside an allowed workspace root using literal matching with bounded concurrency.
 */
export async function searchTextService(
  workspaceConfig: WorkspaceConfig | undefined,
  rootId: string,
  query: string,
  options: SearchTextOptions = {}
): Promise<SearchTextResult> {
  const clock = options.now ?? performance.now.bind(performance);
  const startTime = clock();

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Invalid query parameter: Query must be a non-empty string.");
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(
      `Query length (${query.length}) exceeds maximum limit of ${MAX_SEARCH_QUERY_LENGTH} characters.`
    );
  }

  const requestedStartPath = options.path ?? ".";
  const resolved = await resolveExistingPathWithinRoot(workspaceConfig, rootId, requestedStartPath);
  if (!resolved.isDirectory) {
    throw new Error(
      `Search start path is not a directory: "${requestedStartPath}" within root "${resolved.root.name}".`
    );
  }

  const caseSensitive = options.caseSensitive ?? false;
  const includeIgnored = options.includeIgnored ?? false;
  const normalizedExtensions = normalizeExtensions(options.extensions);
  const effectiveMaxResults = Math.max(
    1,
    Math.min(MAX_SEARCH_RESULTS, options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS)
  );
  const effectiveMaxFiles = Math.max(
    1,
    Math.min(MAX_SEARCH_FILES, options.maxFiles ?? DEFAULT_SEARCH_MAX_FILES)
  );
  const effectiveTimeoutMs = Math.max(
    100,
    Math.min(MAX_SEARCH_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
  );
  const effectiveContextLines =
    typeof options.contextLines === "number" && Number.isSafeInteger(options.contextLines)
      ? Math.max(0, Math.min(10, options.contextLines))
      : 0;

  const normalizedQuery = caseSensitive ? query : query.toLowerCase();

  const results: SearchTextMatch[] = [];
  let scannedFiles = 0;
  let lastEmittedProgress = 0;
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;
  let matchedFiles = 0;
  let stopReason: SearchStopReason = "completed";

  interface CandidateFile {
    absPath: string;
    relPath: string;
  }

  // 1. Gather candidate files iteratively
  const candidateFiles: CandidateFile[] = [];
  const startRel = resolved.relativeToRoot === "." ? "" : toPosixPath(resolved.relativeToRoot);
  const dirQueue: Array<{ absDir: string; relDir: string; depth: number }> = [
    {
      absDir: resolved.resolvedPath,
      relDir: startRel,
      depth: 0,
    },
  ];

  while (dirQueue.length > 0) {
    if (options.signal?.aborted) {
      throw new DOMException("Search operation was aborted", "AbortError");
    }
    if (clock() - startTime >= effectiveTimeoutMs) {
      stopReason = "timeout";
      break;
    }

    const current = dirQueue.shift()!;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of entries) {
      if (options.signal?.aborted) {
        throw new DOMException("Search operation was aborted", "AbortError");
      }
      if (clock() - startTime >= effectiveTimeoutMs) {
        stopReason = "timeout";
        break;
      }

      const isDir = dirent.isDirectory();
      const isFile = dirent.isFile();
      const isSymlink = dirent.isSymbolicLink();

      const entryRelPath = current.relDir
        ? `${current.relDir}/${dirent.name}`
        : dirent.name;

      if (!includeIgnored && isDir && COMMON_SEARCH_IGNORED_DIRECTORIES.has(dirent.name)) {
        continue;
      }

      // Check extension filter on candidate files
      if (isFile) {
        if (normalizedExtensions) {
          const lowerName = dirent.name.toLowerCase();
          const matchesExt = normalizedExtensions.some((ext) => lowerName.endsWith(ext));
          if (!matchesExt) continue;
        }

        candidateFiles.push({
          absPath: path.join(current.absDir, dirent.name),
          relPath: entryRelPath,
        });
      }

      if (isDir && !isSymlink && current.depth < MAX_SEARCH_DEPTH) {
        dirQueue.push({
          absDir: path.join(current.absDir, dirent.name),
          relDir: entryRelPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  // 2. Scan candidate files with bounded concurrency (fixed 8 concurrency pool)
  let candidateIndex = 0;

  async function processNextFile(): Promise<void> {
    while (candidateIndex < candidateFiles.length) {
      if (options.signal?.aborted) {
        throw new DOMException("Search operation was aborted", "AbortError");
      }
      if (stopReason !== "completed") {
        return;
      }
      if (clock() - startTime >= effectiveTimeoutMs) {
        stopReason = "timeout";
        return;
      }

      const file = candidateFiles[candidateIndex++];
      scannedFiles++;

      if (scannedFiles % 250 === 0 && options.onProgress) {
        lastEmittedProgress = scannedFiles;
        try {
          await options.onProgress(scannedFiles);
        } catch {
          // Ignore progress error
        }
      }

      if (scannedFiles > effectiveMaxFiles) {
        stopReason = "max_files";
        return;
      }

      let stat;
      try {
        stat = await fs.stat(file.absPath);
      } catch {
        continue;
      }

      if (stat.size > MAX_SEARCH_FILE_BYTES) {
        skippedLargeFiles++;
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(file.absPath);
      } catch {
        continue;
      }

      // Check binary: NUL byte detection
      if (buffer.includes(0)) {
        skippedBinaryFiles++;
        continue;
      }

      const text = buffer.toString("utf-8");
      const lines = text.split("\n");
      let fileHadMatch = false;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (stopReason !== "completed") break;
        if (clock() - startTime >= effectiveTimeoutMs) {
          stopReason = "timeout";
          break;
        }

        const rawLine = lines[lineIdx];
        const lineToSearch = caseSensitive ? rawLine : rawLine.toLowerCase();
        let fromIndex = 0;

        while (fromIndex <= lineToSearch.length) {
          const matchIdx = lineToSearch.indexOf(normalizedQuery, fromIndex);
          if (matchIdx === -1) break;

          fileHadMatch = true;
          const preview = formatLinePreview(rawLine, matchIdx, query.length);

          const matchObj: SearchTextMatch = {
            path: file.relPath,
            line: lineIdx + 1,
            column: matchIdx + 1,
            preview,
          };

          if (effectiveContextLines > 0) {
            const beforeLines = lines.slice(Math.max(0, lineIdx - effectiveContextLines), lineIdx);
            const afterLines = lines.slice(lineIdx + 1, Math.min(lines.length, lineIdx + 1 + effectiveContextLines));
            (matchObj as { contextBefore?: readonly string[]; contextAfter?: readonly string[] }).contextBefore = beforeLines.map(formatContextLine);
            (matchObj as { contextBefore?: readonly string[]; contextAfter?: readonly string[] }).contextAfter = afterLines.map(formatContextLine);
          }

          results.push(matchObj);

          if (results.length >= effectiveMaxResults) {
            stopReason = "max_results";
            break;
          }

          fromIndex = matchIdx + Math.max(1, query.length);
        }
      }

      if (fileHadMatch) {
        matchedFiles++;
      }
    }
  }

  // Run workers up to SEARCH_CONCURRENCY
  const workerCount = Math.min(SEARCH_CONCURRENCY, candidateFiles.length || 1);
  const workers = Array.from({ length: workerCount }, () => processNextFile());
  await Promise.all(workers);

  // Final progress notification if scanned files exist and was not already emitted by cadence
  if (
    scannedFiles > 0 &&
    scannedFiles !== lastEmittedProgress &&
    options.onProgress &&
    !options.signal?.aborted
  ) {
    try {
      await options.onProgress(scannedFiles);
    } catch {
      // Ignore progress error
    }
  }

  // Deterministic sorting of matches: by path, then line, then column
  results.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  const durationMs = Number((clock() - startTime).toFixed(2));
  const truncated = stopReason !== "completed";

  return {
    rootId: resolved.root.id,
    path: resolved.relativeToRoot,
    query,
    caseSensitive,
    extensions: normalizedExtensions,
    results,
    scannedFiles,
    skippedBinaryFiles,
    skippedLargeFiles,
    matchedFiles,
    totalMatches: results.length,
    truncated,
    stopReason,
    durationMs,
  };
}

import path from "node:path";

const EXTENSION_TO_MIME: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".xml": "application/xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".mts": "text/typescript; charset=utf-8",
  ".cts": "text/typescript; charset=utf-8",
  ".tsx": "text/typescript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".csv": "text/csv; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".bash": "text/plain; charset=utf-8",
};

/**
 * Deterministically determines the MIME type of a file path based on its extension.
 * Defaults to "text/plain; charset=utf-8" for unknown textual extensions.
 */
export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "text/plain; charset=utf-8";
}

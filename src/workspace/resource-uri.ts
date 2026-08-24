import { WorkspaceSecurityError } from "./types.js";

/**
 * Creates a canonical workspace resource URI from a logical rootId and relative path.
 * Format: workspace:///<rootId>/<relative-path-segments>
 * Example: workspace:///root-1/src/index.ts
 */
export function createWorkspaceResourceUri(rootId: string, relativePath: string): string {
  if (typeof rootId !== "string" || rootId.trim().length === 0) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Invalid rootId: Must be a non-empty string.");
  }

  const cleanRootId = rootId.trim();
  if (cleanRootId.includes("/") || cleanRootId.includes("\\") || cleanRootId.includes("\0")) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Invalid rootId: Cannot contain path separators or NUL bytes.");
  }

  if (typeof relativePath !== "string") {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Invalid relativePath: Must be a string.");
  }

  // Normalize path separators to "/"
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const rawSegments = normalizedPath.split("/").filter((s) => s.length > 0);

  if (rawSegments.length === 0) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Invalid relativePath: Must contain at least one path segment.");
  }

  for (const seg of rawSegments) {
    if (seg === "." || seg === "..") {
      throw new WorkspaceSecurityError("invalid_resource_uri", "Traversal segments ('.' and '..') are forbidden in resource URIs.");
    }
    if (seg.includes("\0")) {
      throw new WorkspaceSecurityError("invalid_resource_uri", "NUL bytes are forbidden in resource URIs.");
    }
  }

  const encodedRootId = encodeURIComponent(cleanRootId);
  const encodedSegments = rawSegments.map((seg) => encodeURIComponent(seg));

  return `workspace:///${encodedRootId}/${encodedSegments.join("/")}`;
}

/**
 * Parses and validates a canonical workspace resource URI.
 * Validates:
 * - Scheme is strictly "workspace:"
 * - No credentials (username / password)
 * - No port
 * - No query parameters (?query)
 * - No fragments (#fragment)
 * - Empty host authority (workspace:///<rootId>/<path>)
 * - Decodes each path segment once
 * - Rejects double-encoded sequences (e.g. %252e)
 * - Rejects decoded traversal (., ..), path separators (/, \), or NUL bytes
 * - Returns logical rootId and canonical relativePath (using "/" as separator)
 */
export function parseWorkspaceResourceUri(rawUri: string | URL): {
  rootId: string;
  relativePath: string;
} {
  const uriStr = typeof rawUri === "string" ? rawUri : rawUri.href;

  // Check for plain or percent-encoded dot segments (. or .. or %2e or %2e%2e) before URL normalization
  const pathPart = uriStr.replace(/^workspace:\/\/\/?/i, "");
  if (/(?:^|\/|\\)(?:\.\.|\.|\%2e\%2e|\%2e|\%2E\%2E|\%2E)(?:\/|\\|$)/i.test(pathPart)) {
    throw new WorkspaceSecurityError(
      "invalid_resource_uri",
      "Traversal segments ('.' and '..') or encoded dot segments are forbidden in resource URIs."
    );
  }

  let url: URL;
  if (rawUri instanceof URL) {
    url = rawUri;
  } else if (typeof rawUri === "string") {
    try {
      url = new URL(rawUri);
    } catch {
      throw new WorkspaceSecurityError("invalid_resource_uri", "Invalid resource URI syntax.");
    }
  } else {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Resource URI must be a string or URL object.");
  }

  if (url.protocol !== "workspace:") {
    throw new WorkspaceSecurityError(
      "invalid_resource_uri",
      `Invalid resource URI scheme "${url.protocol}". Expected "workspace:".`
    );
  }

  if (url.username || url.password) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Resource URI credentials are not permitted.");
  }

  if (url.port) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Resource URI ports are not permitted.");
  }

  if (url.search) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Resource URI query parameters are not permitted.");
  }

  if (url.hash) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Resource URI fragments are not permitted.");
  }

  // Reject non-empty host (e.g. workspace://root-1/path instead of workspace:///root-1/path)
  if (url.host && url.host.length > 0) {
    throw new WorkspaceSecurityError(
      "invalid_resource_uri",
      `Invalid resource URI format: Expected empty authority "workspace:///<rootId>/<path>".`
    );
  }

  const pathname = url.pathname;
  if (!pathname.startsWith("/")) {
    throw new WorkspaceSecurityError("invalid_resource_uri", "Malformed workspace resource URI path.");
  }

  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.length < 2) {
    throw new WorkspaceSecurityError(
      "invalid_resource_uri",
      "Workspace resource URI must include both a rootId and relative path (e.g. workspace:///root-1/file.txt)."
    );
  }

  const decodedSegments: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const rawSeg = rawSegments[i]!;
    if (rawSeg.length === 0) {
      throw new WorkspaceSecurityError("invalid_resource_uri", "Empty path segments are forbidden in resource URIs.");
    }

    // Detect and reject double-encoded sequences (e.g., %252e, %252f, %255c)
    if (/%25[0-9a-fA-F]{2}/.test(rawSeg)) {
      throw new WorkspaceSecurityError(
        "invalid_resource_uri",
        "Double-encoded percent sequences are forbidden in resource URIs."
      );
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      throw new WorkspaceSecurityError("invalid_resource_uri", "Invalid percent-encoding in resource URI.");
    }

    if (decoded.includes("\0")) {
      throw new WorkspaceSecurityError("invalid_resource_uri", "NUL bytes are forbidden in resource URI segments.");
    }

    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new WorkspaceSecurityError(
        "invalid_resource_uri",
        "Encoded path separators ('/' or '\\') are forbidden in resource URI segments."
      );
    }

    if (decoded === "." || decoded === "..") {
      throw new WorkspaceSecurityError(
        "invalid_resource_uri",
        "Path traversal segments ('.' or '..') are forbidden in resource URIs."
      );
    }

    decodedSegments.push(decoded);
  }

  const rootId = decodedSegments[0]!;
  const relativePath = decodedSegments.slice(1).join("/");

  return {
    rootId,
    relativePath,
  };
}

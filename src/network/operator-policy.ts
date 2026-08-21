import net from "node:net";

export const DEFAULT_FETCH_MAX_BYTES = 1_048_576; // 1 MiB
export const MAX_FETCH_MAX_BYTES = 5_242_880;     // 5 MiB
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;    // 10 seconds
export const MAX_FETCH_TIMEOUT_MS = 30_000;        // 30 seconds

/**
 * Immutable operator-configured network egress policy.
 * Serves as an additional layer of restriction on top of built-in SSRF protections.
 */
export interface NetworkOperatorPolicy {
  readonly allowHosts: readonly string[];
  readonly denyHosts: readonly string[];
  readonly httpsOnly: boolean;
  readonly maxResponseBytes: number;
  readonly maxTimeoutMs: number;
}

/**
 * Default network operator policy (Milestone 1 equivalent).
 * - allowHosts = [] (unrestricted by host allowlist)
 * - denyHosts = [] (no hosts explicitly denied)
 * - httpsOnly = false (HTTP and HTTPS permitted on allowed ports)
 * - maxResponseBytes = 5_242_880 (5 MiB hard maximum)
 * - maxTimeoutMs = 30_000 (30 seconds hard maximum)
 */
export const DEFAULT_NETWORK_OPERATOR_POLICY: NetworkOperatorPolicy = Object.freeze({
  allowHosts: Object.freeze([]),
  denyHosts: Object.freeze([]),
  httpsOnly: false,
  maxResponseBytes: MAX_FETCH_MAX_BYTES,
  maxTimeoutMs: MAX_FETCH_TIMEOUT_MS,
});

/**
 * Known forbidden hostnames that must never be allowlisted.
 */
const FORBIDDEN_HOST_PATTERNS = new Set([
  "localhost",
  "local",
  "internal",
  "broadcasthost",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
]);

/**
 * Validates and normalizes a single hostname pattern (exact or subdomain wildcard).
 *
 * Rules:
 * - Exact hostname: e.g. "example.com"
 * - Subdomain wildcard: e.g. "*.example.com"
 * - Rejects: URLs, schemes, paths, query, ports, credentials, whitespace, IP literals, regex.
 * - Rejects forbidden local hostnames (e.g. "localhost", "*.localhost").
 */
export function normalizeHostPattern(pattern: string): string {
  if (typeof pattern !== "string") {
    throw new Error(`Invalid host pattern: Must be a non-empty string.`);
  }

  const raw = pattern.trim();
  if (raw.length === 0) {
    throw new Error(`Invalid host pattern: Pattern cannot be empty.`);
  }

  // Reject URLs, schemes, paths, query strings, ports, credentials, whitespace
  if (
    raw.includes("://") ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("@") ||
    raw.includes(":") ||
    /\s/.test(raw)
  ) {
    throw new Error(
      `Invalid host pattern "${pattern}": Must be a bare hostname or "*.hostname" wildcard (no scheme, path, port, credentials, or whitespace).`
    );
  }

  let isWildcard = false;
  let domainPart = raw;

  if (raw.startsWith("*.")) {
    isWildcard = true;
    domainPart = raw.slice(2);
  } else if (raw.includes("*")) {
    throw new Error(
      `Invalid wildcard pattern "${pattern}": Wildcards are only supported as a leading "*." prefix (e.g. "*.example.com").`
    );
  }

  if (domainPart.length === 0) {
    throw new Error(`Invalid host pattern "${pattern}": Hostname suffix cannot be empty.`);
  }

  // Remove one canonical trailing dot if present
  if (domainPart.endsWith(".")) {
    domainPart = domainPart.slice(0, -1);
  }

  if (domainPart.length === 0) {
    throw new Error(`Invalid host pattern "${pattern}": Hostname cannot be just a dot.`);
  }

  // Reject IP literals (both IPv4 and IPv6)
  if (net.isIP(domainPart)) {
    throw new Error(
      `Invalid host pattern "${pattern}": IP literals are not allowed in operator hostname policy. Use DNS hostnames.`
    );
  }

  // Check for forbidden hosts like localhost
  const lowerDomain = domainPart.toLowerCase();
  if (
    FORBIDDEN_HOST_PATTERNS.has(lowerDomain) ||
    lowerDomain.endsWith(".localhost") ||
    lowerDomain.endsWith(".local") ||
    lowerDomain.endsWith(".internal")
  ) {
    throw new Error(
      `Invalid host pattern "${pattern}": Localhost and private hostnames cannot be configured in operator policy.`
    );
  }

  // Validate hostname structure via WHATWG URL parsing
  try {
    const dummyUrl = new URL(`http://${domainPart}`);
    const normalizedHostname = dummyUrl.hostname.toLowerCase();

    if (net.isIP(normalizedHostname)) {
      throw new Error(
        `Invalid host pattern "${pattern}": Evaluates to an IP address (${normalizedHostname}). IP literals are not allowed.`
      );
    }

    if (normalizedHostname.length === 0 || normalizedHostname.includes("..")) {
      throw new Error(`Invalid host pattern "${pattern}": Invalid domain label structure.`);
    }

    return isWildcard ? `*.${normalizedHostname}` : normalizedHostname;
  } catch (err: any) {
    if (err instanceof Error && err.message.startsWith("Invalid host pattern")) {
      throw err;
    }
    throw new Error(`Invalid host pattern "${pattern}": Malformed domain name.`);
  }
}

/**
 * Canonicalizes a runtime target hostname to ASCII Punycode and lower-case without trailing dot.
 */
export function normalizeRuntimeHostname(hostname: string): string {
  if (typeof hostname !== "string") return "";
  let trimmed = hostname.trim().toLowerCase();
  if (trimmed.endsWith(".")) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed.length === 0) return "";
  try {
    const dummyUrl = new URL(`http://${trimmed}`);
    return dummyUrl.hostname.toLowerCase();
  } catch {
    return trimmed;
  }
}

/**
 * Checks whether a runtime normalized hostname matches a configured pattern.
 *
 * Pattern semantics:
 * - "example.com" matches strictly "example.com"
 * - "*.example.com" matches subdomains "api.example.com", "a.b.example.com", but NOT apex "example.com"
 */
export function matchesHostPattern(targetHostname: string, pattern: string): boolean {
  const normalizedTarget = normalizeRuntimeHostname(targetHostname);

  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // e.g. ".example.com"
    return normalizedTarget.endsWith(suffix) && normalizedTarget.length > suffix.length;
  }

  return normalizedTarget === pattern;
}

/**
 * Evaluates a destination hostname against operator allow and deny policies.
 *
 * Order of Precedence:
 * 1. Deny list evaluation: If matches ANY pattern in denyHosts -> REJECT (host_denied).
 * 2. Allow list evaluation: If allowHosts is non-empty and does NOT match any pattern -> REJECT (host_not_allowed).
 * 3. Otherwise -> ALLOWED.
 */
export function evaluateHostnamePolicy(
  hostname: string,
  policy: NetworkOperatorPolicy
): { allowed: boolean; reason?: "host_denied" | "host_not_allowed" } {
  const normalizedTarget = normalizeRuntimeHostname(hostname);

  // 1. Check Deny list (Deny always takes precedence over Allow)
  if (policy.denyHosts.length > 0) {
    for (const denyPattern of policy.denyHosts) {
      if (matchesHostPattern(normalizedTarget, denyPattern)) {
        return { allowed: false, reason: "host_denied" };
      }
    }
  }

  // 2. Check Allow list (If empty, all destinations passing built-in policy are allowed)
  if (policy.allowHosts.length > 0) {
    let matched = false;
    for (const allowPattern of policy.allowHosts) {
      if (matchesHostPattern(normalizedTarget, allowPattern)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { allowed: false, reason: "host_not_allowed" };
    }
  }

  return { allowed: true };
}

/**
 * Calculates the effective max response bytes for a fetch request.
 * Effective = min(caller maxBytes, operator maxResponseBytes, built-in HARD_MAX_FETCH_BYTES)
 */
export function calculateEffectiveMaxBytes(
  callerMaxBytes: number | undefined,
  policy?: NetworkOperatorPolicy
): number {
  const operatorCap = policy?.maxResponseBytes ?? MAX_FETCH_MAX_BYTES;
  const callerRequested =
    typeof callerMaxBytes === "number" && !isNaN(callerMaxBytes) && callerMaxBytes >= 1
      ? Math.floor(callerMaxBytes)
      : DEFAULT_FETCH_MAX_BYTES;

  return Math.min(callerRequested, operatorCap, MAX_FETCH_MAX_BYTES);
}

/**
 * Calculates the effective timeout in milliseconds for a fetch request.
 * Effective = min(caller timeoutMs, operator maxTimeoutMs, built-in MAX_FETCH_TIMEOUT_MS)
 */
export function calculateEffectiveTimeoutMs(
  callerTimeoutMs: number | undefined,
  policy?: NetworkOperatorPolicy,
  allowLoopbackForTesting = false
): number {
  const minTimeout = allowLoopbackForTesting ? 10 : 1000;
  const operatorCap = policy?.maxTimeoutMs ?? MAX_FETCH_TIMEOUT_MS;
  const callerRequested =
    typeof callerTimeoutMs === "number" && !isNaN(callerTimeoutMs) && callerTimeoutMs >= minTimeout
      ? Math.floor(callerTimeoutMs)
      : DEFAULT_FETCH_TIMEOUT_MS;

  return Math.min(callerRequested, operatorCap, MAX_FETCH_TIMEOUT_MS);
}

/**
 * Validates and constructs an immutable NetworkOperatorPolicy object.
 */
export function createNetworkOperatorPolicy(options: {
  allowHosts?: readonly string[];
  denyHosts?: readonly string[];
  httpsOnly?: boolean;
  maxResponseBytes?: number;
  maxTimeoutMs?: number;
}): NetworkOperatorPolicy {
  const normalizedAllowHosts = (options.allowHosts ?? []).map(normalizeHostPattern);
  const normalizedDenyHosts = (options.denyHosts ?? []).map(normalizeHostPattern);

  const httpsOnly = Boolean(options.httpsOnly);

  let maxResponseBytes = MAX_FETCH_MAX_BYTES;
  if (options.maxResponseBytes !== undefined) {
    if (
      typeof options.maxResponseBytes !== "number" ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1 ||
      options.maxResponseBytes > MAX_FETCH_MAX_BYTES
    ) {
      throw new Error(
        `Invalid maxResponseBytes: "${options.maxResponseBytes}". Must be an integer between 1 and ${MAX_FETCH_MAX_BYTES}.`
      );
    }
    maxResponseBytes = options.maxResponseBytes;
  }

  let maxTimeoutMs = MAX_FETCH_TIMEOUT_MS;
  if (options.maxTimeoutMs !== undefined) {
    if (
      typeof options.maxTimeoutMs !== "number" ||
      !Number.isSafeInteger(options.maxTimeoutMs) ||
      options.maxTimeoutMs < 1000 ||
      options.maxTimeoutMs > MAX_FETCH_TIMEOUT_MS
    ) {
      throw new Error(
        `Invalid maxTimeoutMs: "${options.maxTimeoutMs}". Must be an integer between 1000 and ${MAX_FETCH_TIMEOUT_MS}.`
      );
    }
    maxTimeoutMs = options.maxTimeoutMs;
  }

  return Object.freeze({
    allowHosts: Object.freeze(normalizedAllowHosts),
    denyHosts: Object.freeze(normalizedDenyHosts),
    httpsOnly,
    maxResponseBytes,
    maxTimeoutMs,
  });
}

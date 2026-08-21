import net from "node:net";
import { classifyIpAddress } from "./ip-classifier.js";
import { NetworkSecurityError } from "./types.js";

export const MAX_URL_LENGTH = 2048;
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443] as const;

export const DEFAULT_FETCH_MAX_BYTES = 1_048_576; // 1 MiB
export const MAX_FETCH_MAX_BYTES = 5_242_880;     // 5 MiB

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;    // 10 seconds
export const MAX_FETCH_TIMEOUT_MS = 30_000;        // 30 seconds
export const MAX_REDIRECTS = 5;
export const MAX_HEADER_SIZE = 16_384;             // 16 KiB

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

/**
 * Validates that a raw input URL satisfies basic syntax, scheme, credentials, and port policies.
 *
 * @param rawUrl Input URL string
 * @param allowedPorts Optional allowed ports list (defaults to [80, 443, 8080, 8443])
 * @returns Parsed and validated URL object
 */
export function validateAndParseUrl(
  rawUrl: string,
  allowedPorts: readonly number[] = DEFAULT_ALLOWED_PORTS,
  allowLoopbackForTesting = false
): URL {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new NetworkSecurityError("invalid_url", "URL must be a non-empty string.");
  }

  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new NetworkSecurityError(
      "invalid_url",
      `URL length exceeds maximum limit of ${MAX_URL_LENGTH} characters.`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err: any) {
    throw new NetworkSecurityError("invalid_url", "Malformed URL format.", err.message);
  }

  // 1. Allowed protocols: http: and https: only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkSecurityError(
      "unsupported_protocol",
      `Protocol "${parsed.protocol}" is not supported. Only http: and https: are allowed.`
    );
  }

  // 2. Reject credentials in URL (user:pass@host)
  if (parsed.username || parsed.password) {
    throw new NetworkSecurityError(
      "credentials_not_allowed",
      "URL credentials (username/password) are not allowed."
    );
  }

  // 3. Validate hostname
  const rawHostname = parsed.hostname;
  if (!rawHostname || rawHostname.trim().length === 0) {
    throw new NetworkSecurityError("invalid_url", "URL hostname is required.");
  }

  // Canonicalize hostname for comparison: lowercase, strip trailing dot
  const normalizedHostname = rawHostname.toLowerCase().replace(/\.+$/, "");

  if (
    !allowLoopbackForTesting &&
    (BLOCKED_HOSTNAMES.has(normalizedHostname) ||
      normalizedHostname.endsWith(".localhost"))
  ) {
    throw new NetworkSecurityError(
      "blocked_destination",
      "Destination is not allowed by network security policy."
    );
  }

  // 4. Validate port
  let port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new NetworkSecurityError("port_not_allowed", `Invalid port number specified.`);
  }

  if (!allowedPorts.includes(port)) {
    throw new NetworkSecurityError(
      "port_not_allowed",
      `Port ${port} is not allowed by network security policy. Allowed ports: ${allowedPorts.join(", ")}.`
    );
  }

  // 5. If hostname is already an IP literal (or normalized IPv4 by WHATWG URL), classify it directly
  const cleanIp = normalizedHostname.replace(/^\[|\]$/g, "");
  if (net.isIP(cleanIp) !== 0) {
    const classification = classifyIpAddress(cleanIp, allowLoopbackForTesting);
    if (!classification.allowed) {
      throw new NetworkSecurityError(
        "blocked_destination",
        "Destination is not allowed by network security policy.",
        `Literal IP ${cleanIp} is blocked: ${classification.reason}`
      );
    }
  }

  return parsed;
}

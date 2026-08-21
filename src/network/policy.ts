import net from "node:net";
import { classifyIpAddress } from "./ip-classifier.js";
import { evaluateHostnamePolicy, type NetworkOperatorPolicy } from "./operator-policy.js";
import { NetworkSecurityError } from "./types.js";

export const MAX_URL_LENGTH = 2048;
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443] as const;

export {
  DEFAULT_FETCH_MAX_BYTES,
  MAX_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_TIMEOUT_MS,
} from "./operator-policy.js";

export const MAX_REDIRECTS = 5;
export const MAX_HEADER_SIZE = 16_384;             // 16 KiB

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

/**
 * Validates that a raw input URL satisfies basic syntax, scheme, credentials, port, and operator policies.
 *
 * @param rawUrl Input URL string
 * @param allowedPorts Optional allowed ports list (defaults to [80, 443, 8080, 8443])
 * @param allowLoopbackForTesting Testing bypass for localhost
 * @param operatorPolicy Optional operator-configured egress policy
 * @returns Parsed and validated URL object
 */
export function validateAndParseUrl(
  rawUrl: string,
  allowedPorts: readonly number[] = DEFAULT_ALLOWED_PORTS,
  allowLoopbackForTesting = false,
  operatorPolicy?: NetworkOperatorPolicy
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

  // 2. HTTPS-only enforcement if configured by operator
  if (operatorPolicy?.httpsOnly && parsed.protocol !== "https:") {
    throw new NetworkSecurityError(
      "https_required",
      "HTTPS is required by server network policy."
    );
  }

  // 3. Reject credentials in URL (user:pass@host)
  if (parsed.username || parsed.password) {
    throw new NetworkSecurityError(
      "credentials_not_allowed",
      "URL credentials (username/password) are not allowed."
    );
  }

  // 4. Validate hostname
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

  // 5. Operator Hostname Policy (Deny takes precedence, then Allow)
  if (operatorPolicy) {
    const hostEval = evaluateHostnamePolicy(normalizedHostname, operatorPolicy);
    if (!hostEval.allowed) {
      if (hostEval.reason === "host_denied") {
        throw new NetworkSecurityError(
          "host_denied",
          "Destination hostname is denied by server network policy."
        );
      }
      throw new NetworkSecurityError(
        "host_not_allowed",
        "Destination hostname is not allowed by server network policy."
      );
    }
  }

  // 6. Validate port
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

  // 7. If hostname is already an IP literal (or normalized IPv4 by WHATWG URL), classify it directly
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

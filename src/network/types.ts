/**
 * Network Subsystem Types & Security Error Model.
 */

export type NetworkErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "credentials_not_allowed"
  | "port_not_allowed"
  | "blocked_destination"
  | "dns_resolution_failed"
  | "redirect_limit"
  | "invalid_redirect"
  | "redirect_downgrade_not_allowed"
  | "host_not_allowed"
  | "host_denied"
  | "https_required"
  | "timeout"
  | "unsupported_content_type"
  | "unsupported_content_encoding"
  | "unsupported_charset"
  | "invalid_text_encoding"
  | "protocol_upgrade_not_allowed"
  | "network_error";

/**
 * Sanitized client-safe security error class.
 * Never leaks internal IP addresses, internal DNS topology, or system socket paths.
 */
export class NetworkSecurityError extends Error {
  readonly code: NetworkErrorCode;
  readonly internalDetail?: string;

  constructor(code: NetworkErrorCode, clientMessage: string, internalDetail?: string) {
    super(clientMessage);
    this.name = "NetworkSecurityError";
    this.code = code;
    this.internalDetail = internalDetail;
    Object.setPrototypeOf(this, NetworkSecurityError.prototype);
  }
}

export interface DnsRecord {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface SafeDnsResolver {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly DnsRecord[]>;
}

export interface IpClassificationResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly normalizedIp: string;
  readonly family: 4 | 6;
}

export interface FetchUrlOptions {
  readonly url: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly operatorPolicy?: import("./operator-policy.js").NetworkOperatorPolicy;
  /** Test-only dependency injection for safe testing with ephemeral ports and local mock servers */
  readonly customResolver?: SafeDnsResolver;
  readonly customAllowedPorts?: readonly number[];
  readonly allowLoopbackForTesting?: boolean;
}

export interface FetchUrlResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly body?: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly redirectCount: number;
}

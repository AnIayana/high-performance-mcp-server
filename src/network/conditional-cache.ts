/**
 * Secure In-Memory Conditional HTTP Response Cache for fetch_url.
 *
 * Security Principles:
 * 1. Opt-In Only: Disabled by default unless explicitly configured by server operator.
 * 2. Retention TTL != Freshness TTL: Every cache reuse MUST perform conditional HTTP
 *    revalidation (ETag / Last-Modified) against origin. No unvalidated/offline cache hits.
 * 3. No Stale Fallback: If revalidation encounters network/timeout/security error, the
 *    error is returned. Stale cached bodies are NEVER served on error.
 * 4. Authoritative Security Pipeline: URL policy, operator egress restrictions, safe DNS,
 *    socket-level SSRF classification, TLS verification, and cancellation are evaluated on every reuse.
 * 5. Privacy: Cache keys are opaque SHA-256 hashes of canonical HTTPS URLs. Plaintext URLs
 *    are never stored as keys or in cache entries.
 * 6. Conservative Eligibility (v1): Only direct (0 redirects) 200 OK HTTPS responses without
 *    URL query strings, fragments, no-store, private, Set-Cookie, or Vary: * are cacheable.
 * 7. Memory Bounded: LRU cache enforces hard limits on both entry count and logical payload size.
 * 8. Instance Isolation: Cache lifecycle belongs to ServerContext. No global singleton cache.
 */

import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

export interface NetworkCachePolicy {
  readonly enabled: boolean;
  readonly maxSizeBytes: number;
  readonly maxEntries: number;
  readonly retentionTtlMs: number;
}

export const DEFAULT_NETWORK_CACHE_ENABLED = false;
export const DEFAULT_NETWORK_CACHE_MAX_SIZE_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MIN_NETWORK_CACHE_MAX_SIZE_BYTES = 1024; // 1 KiB
export const MAX_NETWORK_CACHE_MAX_SIZE_BYTES = 64 * 1024 * 1024; // 64 MiB

export const DEFAULT_NETWORK_CACHE_MAX_ENTRIES = 128;
export const MIN_NETWORK_CACHE_MAX_ENTRIES = 1;
export const MAX_NETWORK_CACHE_MAX_ENTRIES = 512;

export const DEFAULT_NETWORK_CACHE_RETENTION_TTL_MS = 300_000; // 5 minutes
export const MIN_NETWORK_CACHE_RETENTION_TTL_MS = 1_000; // 1 second
export const MAX_NETWORK_CACHE_RETENTION_TTL_MS = 3_600_000; // 1 hour

export const DEFAULT_NETWORK_CACHE_POLICY: NetworkCachePolicy = Object.freeze({
  enabled: DEFAULT_NETWORK_CACHE_ENABLED,
  maxSizeBytes: DEFAULT_NETWORK_CACHE_MAX_SIZE_BYTES,
  maxEntries: DEFAULT_NETWORK_CACHE_MAX_ENTRIES,
  retentionTtlMs: DEFAULT_NETWORK_CACHE_RETENTION_TTL_MS,
});

/**
 * Creates and freezes an immutable NetworkCachePolicy with strict boundary validation.
 */
export function createNetworkCachePolicy(
  options: Partial<NetworkCachePolicy> = {}
): NetworkCachePolicy {
  const enabled = options.enabled ?? DEFAULT_NETWORK_CACHE_ENABLED;
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_NETWORK_CACHE_MAX_SIZE_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_NETWORK_CACHE_MAX_ENTRIES;
  const retentionTtlMs = options.retentionTtlMs ?? DEFAULT_NETWORK_CACHE_RETENTION_TTL_MS;

  if (typeof enabled !== "boolean") {
    throw new Error("NetworkCachePolicy 'enabled' must be a boolean.");
  }

  if (
    !Number.isSafeInteger(maxSizeBytes) ||
    maxSizeBytes < MIN_NETWORK_CACHE_MAX_SIZE_BYTES ||
    maxSizeBytes > MAX_NETWORK_CACHE_MAX_SIZE_BYTES
  ) {
    throw new Error(
      `NetworkCachePolicy 'maxSizeBytes' must be an integer between ${MIN_NETWORK_CACHE_MAX_SIZE_BYTES} and ${MAX_NETWORK_CACHE_MAX_SIZE_BYTES}. Received: ${maxSizeBytes}`
    );
  }

  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < MIN_NETWORK_CACHE_MAX_ENTRIES ||
    maxEntries > MAX_NETWORK_CACHE_MAX_ENTRIES
  ) {
    throw new Error(
      `NetworkCachePolicy 'maxEntries' must be an integer between ${MIN_NETWORK_CACHE_MAX_ENTRIES} and ${MAX_NETWORK_CACHE_MAX_ENTRIES}. Received: ${maxEntries}`
    );
  }

  if (
    !Number.isSafeInteger(retentionTtlMs) ||
    retentionTtlMs < MIN_NETWORK_CACHE_RETENTION_TTL_MS ||
    retentionTtlMs > MAX_NETWORK_CACHE_RETENTION_TTL_MS
  ) {
    throw new Error(
      `NetworkCachePolicy 'retentionTtlMs' must be an integer between ${MIN_NETWORK_CACHE_RETENTION_TTL_MS} and ${MAX_NETWORK_CACHE_RETENTION_TTL_MS}. Received: ${retentionTtlMs}`
    );
  }

  return Object.freeze({
    enabled,
    maxSizeBytes,
    maxEntries,
    retentionTtlMs,
  });
}

/**
 * Cached HTTP representation entry.
 * Note: Plaintext URLs, query strings, DNS IP addresses, socket paths, and operator lists are NEVER stored.
 */
export interface CachedHttpResponse {
  readonly bodyBuffer: Buffer;
  readonly status: number;
  readonly statusText: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly storedAt: number;
}

const MAX_ETAG_LENGTH = 1024;
const MAX_LAST_MODIFIED_LENGTH = 256;
const FORBIDDEN_CONTROL_CHARS_REGEX = /[\r\n\0\x00-\x1F\x7F]/;

/**
 * Validates and sanitizes an ETag validator header.
 */
export function sanitizeETag(rawEtag?: string): string | undefined {
  if (!rawEtag || typeof rawEtag !== "string") return undefined;
  const trimmed = rawEtag.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ETAG_LENGTH) return undefined;
  if (FORBIDDEN_CONTROL_CHARS_REGEX.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Validates and sanitizes a Last-Modified validator header.
 */
export function sanitizeLastModified(rawLastModified?: string): string | undefined {
  if (!rawLastModified || typeof rawLastModified !== "string") return undefined;
  const trimmed = rawLastModified.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LAST_MODIFIED_LENGTH) return undefined;
  if (FORBIDDEN_CONTROL_CHARS_REGEX.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Computes an opaque SHA-256 cache key from a canonical HTTPS URL.
 * Discards fragments and verifies absence of query parameters.
 */
export function computeCacheKey(targetUrl: URL): string | null {
  if (targetUrl.protocol !== "https:") {
    return null;
  }
  // Query parameters bypass caching for privacy and security
  if (targetUrl.search && targetUrl.search.length > 0) {
    return null;
  }

  const hostname = targetUrl.hostname.toLowerCase();
  const portPart = targetUrl.port && targetUrl.port !== "443" ? `:${targetUrl.port}` : "";
  const pathname = targetUrl.pathname || "/";
  const canonicalUrl = `https://${hostname}${portPart}${pathname}`;

  const preimage = `network-fetch-v1\0${canonicalUrl}`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

export interface CacheEligibilityCheck {
  readonly eligible: boolean;
  readonly reason?: string;
  readonly sanitizedEtag?: string;
  readonly sanitizedLastModified?: string;
}

/**
 * Checks whether an HTTP response is eligible for conditional caching under v1 conservative policy.
 */
export function checkResponseCacheEligibility(params: {
  readonly targetUrl: URL;
  readonly redirectCount: number;
  readonly status: number;
  readonly truncated: boolean;
  readonly headers: Record<string, string | string[] | undefined>;
}): CacheEligibilityCheck {
  const { targetUrl, redirectCount, status, truncated, headers } = params;

  // 1. Must be HTTPS
  if (targetUrl.protocol !== "https:") {
    return { eligible: false, reason: "http_not_cached" };
  }

  // 2. Must have no query parameters
  if (targetUrl.search && targetUrl.search.length > 0) {
    return { eligible: false, reason: "query_urls_not_cached" };
  }

  // 3. Must be a direct response (no redirects)
  if (redirectCount !== 0) {
    return { eligible: false, reason: "redirects_not_cached" };
  }

  // 4. Must be 200 OK
  if (status !== 200) {
    return { eligible: false, reason: "non_200_status" };
  }

  // 5. Must be a complete response (never cache truncated prefixes)
  if (truncated) {
    return { eligible: false, reason: "truncated_response" };
  }

  // 6. Check Cache-Control headers (no-store, private)
  const cacheControlRaw = headers["cache-control"];
  const cacheControl = Array.isArray(cacheControlRaw)
    ? cacheControlRaw.join(", ").toLowerCase()
    : (cacheControlRaw || "").toLowerCase();

  if (cacheControl.includes("no-store") || cacheControl.includes("private")) {
    return { eligible: false, reason: "cache_control_no_store_or_private" };
  }

  // 7. Check Set-Cookie header
  if (headers["set-cookie"] !== undefined) {
    return { eligible: false, reason: "set_cookie_present" };
  }

  // 8. Check Vary: *
  const varyRaw = headers["vary"];
  const vary = Array.isArray(varyRaw) ? varyRaw.join(", ") : (varyRaw || "");
  if (vary.trim() === "*" || vary.includes("*")) {
    return { eligible: false, reason: "vary_asterisk" };
  }

  // 9. Check Content-Encoding (only absent or identity)
  const contentEncodingRaw = headers["content-encoding"];
  const contentEncoding = Array.isArray(contentEncodingRaw)
    ? contentEncodingRaw[0]
    : contentEncodingRaw;
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return { eligible: false, reason: "compressed_content_encoding" };
  }

  // 10. Must have valid sanitized ETag or Last-Modified validator
  const rawEtag = headers["etag"];
  const etagVal = Array.isArray(rawEtag) ? rawEtag[0] : rawEtag;
  const sanitizedEtag = sanitizeETag(etagVal);

  const rawLastModified = headers["last-modified"];
  const lmVal = Array.isArray(rawLastModified) ? rawLastModified[0] : rawLastModified;
  const sanitizedLastModified = sanitizeLastModified(lmVal);

  if (!sanitizedEtag && !sanitizedLastModified) {
    return { eligible: false, reason: "missing_or_invalid_validator" };
  }

  return {
    eligible: true,
    sanitizedEtag,
    sanitizedLastModified,
  };
}

/**
 * In-memory HTTP conditional response cache instance.
 */
export class HttpConditionalCache {
  readonly policy: NetworkCachePolicy;
  private readonly lru: LRUCache<string, CachedHttpResponse> | null;

  constructor(policy: NetworkCachePolicy = DEFAULT_NETWORK_CACHE_POLICY) {
    this.policy = policy;
    if (policy.enabled) {
      this.lru = new LRUCache<string, CachedHttpResponse>({
        max: policy.maxEntries,
        maxSize: policy.maxSizeBytes,
        ttl: policy.retentionTtlMs,
        sizeCalculation: (entry: CachedHttpResponse) => {
          // Logical cached payload size = body bytes + validator lengths + content-type length + fixed metadata overhead
          const bodyBytes = entry.bodyBuffer.byteLength;
          const etagBytes = entry.etag ? Buffer.byteLength(entry.etag, "utf8") : 0;
          const lmBytes = entry.lastModified ? Buffer.byteLength(entry.lastModified, "utf8") : 0;
          const ctBytes = entry.contentType ? Buffer.byteLength(entry.contentType, "utf8") : 0;
          return bodyBytes + etagBytes + lmBytes + ctBytes + 128;
        },
      });
    } else {
      this.lru = null;
    }
  }

  get enabled(): boolean {
    return this.policy.enabled && this.lru !== null;
  }

  get(key: string): CachedHttpResponse | undefined {
    if (!this.lru) return undefined;
    return this.lru.get(key);
  }

  set(key: string, entry: CachedHttpResponse): void {
    if (!this.lru) return;
    this.lru.set(key, entry);
  }

  delete(key: string): void {
    if (!this.lru) return;
    this.lru.delete(key);
  }

  clear(): void {
    if (!this.lru) return;
    this.lru.clear();
  }

  get size(): number {
    return this.lru?.size ?? 0;
  }

  get calculatedSize(): number {
    return this.lru?.calculatedSize ?? 0;
  }
}

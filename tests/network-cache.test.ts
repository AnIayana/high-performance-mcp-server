import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkResponseCacheEligibility,
  computeCacheKey,
  createNetworkCachePolicy,
  DEFAULT_NETWORK_CACHE_POLICY,
  HttpConditionalCache,
  MAX_NETWORK_CACHE_MAX_ENTRIES,
  MAX_NETWORK_CACHE_MAX_SIZE_BYTES,
  MAX_NETWORK_CACHE_RETENTION_TTL_MS,
  MIN_NETWORK_CACHE_MAX_ENTRIES,
  MIN_NETWORK_CACHE_MAX_SIZE_BYTES,
  MIN_NETWORK_CACHE_RETENTION_TTL_MS,
  sanitizeETag,
  sanitizeLastModified,
  type CachedHttpResponse,
  type NetworkCachePolicy,
} from "../src/network/conditional-cache.js";

test("Network Cache Policy — Default Invariants & Immutability", () => {
  assert.equal(DEFAULT_NETWORK_CACHE_POLICY.enabled, false);
  assert.equal(DEFAULT_NETWORK_CACHE_POLICY.maxSizeBytes, 16 * 1024 * 1024);
  assert.equal(DEFAULT_NETWORK_CACHE_POLICY.maxEntries, 128);
  assert.equal(DEFAULT_NETWORK_CACHE_POLICY.retentionTtlMs, 300_000);
  assert.ok(Object.isFrozen(DEFAULT_NETWORK_CACHE_POLICY));

  const customPolicy = createNetworkCachePolicy({
    enabled: true,
    maxSizeBytes: 8 * 1024 * 1024,
    maxEntries: 64,
    retentionTtlMs: 60_000,
  });

  assert.equal(customPolicy.enabled, true);
  assert.equal(customPolicy.maxSizeBytes, 8 * 1024 * 1024);
  assert.equal(customPolicy.maxEntries, 64);
  assert.equal(customPolicy.retentionTtlMs, 60_000);
  assert.ok(Object.isFrozen(customPolicy));

  assert.throws(
    () => {
      (customPolicy as any).enabled = false;
    },
    { name: "TypeError" }
  );
});

test("Network Cache Policy — Boundary Validations & Fail Fast", () => {
  // Invalid enabled
  assert.throws(() => createNetworkCachePolicy({ enabled: "true" as any }), {
    message: /must be a boolean/,
  });

  // Invalid maxSizeBytes
  assert.throws(
    () => createNetworkCachePolicy({ maxSizeBytes: MIN_NETWORK_CACHE_MAX_SIZE_BYTES - 1 }),
    { message: /maxSizeBytes/ }
  );
  assert.throws(
    () => createNetworkCachePolicy({ maxSizeBytes: MAX_NETWORK_CACHE_MAX_SIZE_BYTES + 1 }),
    { message: /maxSizeBytes/ }
  );

  // Invalid maxEntries
  assert.throws(
    () => createNetworkCachePolicy({ maxEntries: MIN_NETWORK_CACHE_MAX_ENTRIES - 1 }),
    { message: /maxEntries/ }
  );
  assert.throws(
    () => createNetworkCachePolicy({ maxEntries: MAX_NETWORK_CACHE_MAX_ENTRIES + 1 }),
    { message: /maxEntries/ }
  );

  // Invalid retentionTtlMs
  assert.throws(
    () => createNetworkCachePolicy({ retentionTtlMs: MIN_NETWORK_CACHE_RETENTION_TTL_MS - 1 }),
    { message: /retentionTtlMs/ }
  );
  assert.throws(
    () => createNetworkCachePolicy({ retentionTtlMs: MAX_NETWORK_CACHE_RETENTION_TTL_MS + 1 }),
    { message: /retentionTtlMs/ }
  );
});

test("Validator Sanitization — ETag and Last-Modified Rules", () => {
  // Valid ETag
  assert.equal(sanitizeETag('"v1-abc"'), '"v1-abc"');
  assert.equal(sanitizeETag('W/"weak-123"'), 'W/"weak-123"');
  assert.equal(sanitizeETag("  \"trimmed\"  "), '"trimmed"');

  // Invalid ETag: control characters (CR, LF, NUL)
  assert.equal(sanitizeETag('"bad\r\ntag"'), undefined);
  assert.equal(sanitizeETag('"bad\0tag"'), undefined);
  assert.equal(sanitizeETag('"bad\x1btag"'), undefined);

  // Length limit (1024)
  const longEtag = `"${"x".repeat(1025)}"`;
  assert.equal(sanitizeETag(longEtag), undefined);
  assert.equal(sanitizeETag(""), undefined);
  assert.equal(sanitizeETag(undefined), undefined);

  // Valid Last-Modified
  assert.equal(
    sanitizeLastModified("Wed, 21 Oct 2026 07:28:00 GMT"),
    "Wed, 21 Oct 2026 07:28:00 GMT"
  );

  // Invalid Last-Modified: control characters & length (256)
  assert.equal(sanitizeLastModified("Wed, 21 Oct 2026\r\nGMT"), undefined);
  assert.equal(sanitizeLastModified("x".repeat(257)), undefined);
  assert.equal(sanitizeLastModified(""), undefined);
  assert.equal(sanitizeLastModified(undefined), undefined);
});

test("Cache Key — Privacy, Canonicalization, and SHA-256 Hashing", () => {
  // HTTPS URL with default port vs explicit port 443
  const url1 = new URL("https://example.com/api/resource");
  const url2 = new URL("https://EXAMPLE.com:443/api/resource#fragment");
  const key1 = computeCacheKey(url1);
  const key2 = computeCacheKey(url2);

  assert.ok(key1);
  assert.ok(key2);
  assert.equal(key1, key2); // Canonicalization matches
  assert.match(key1, /^[0-9a-f]{64}$/); // 64 hex characters (SHA-256)
  assert.ok(!key1.includes("example.com")); // Opaque hash

  // HTTP URL is rejected
  const httpUrl = new URL("http://example.com/api");
  assert.equal(computeCacheKey(httpUrl), null);

  // URL with query parameter is rejected for privacy/security
  const queryUrl = new URL("https://example.com/api?token=secret123");
  assert.equal(computeCacheKey(queryUrl), null);
});

test("Cache Eligibility — Conservative v1 Rules", () => {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    etag: '"12345"',
  };

  // Eligible standard 200 response
  const check1 = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: baseHeaders,
  });
  assert.equal(check1.eligible, true);
  assert.equal(check1.sanitizedEtag, '"12345"');

  // Ineligible: HTTP
  const checkHttp = checkResponseCacheEligibility({
    targetUrl: new URL("http://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: baseHeaders,
  });
  assert.equal(checkHttp.eligible, false);
  assert.equal(checkHttp.reason, "http_not_cached");

  // Ineligible: Query string
  const checkQuery = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data?key=val"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: baseHeaders,
  });
  assert.equal(checkQuery.eligible, false);
  assert.equal(checkQuery.reason, "query_urls_not_cached");

  // Ineligible: Redirect
  const checkRedirect = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 1,
    status: 200,
    truncated: false,
    headers: baseHeaders,
  });
  assert.equal(checkRedirect.eligible, false);
  assert.equal(checkRedirect.reason, "redirects_not_cached");

  // Ineligible: Non-200
  const check404 = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 404,
    truncated: false,
    headers: baseHeaders,
  });
  assert.equal(check404.eligible, false);
  assert.equal(check404.reason, "non_200_status");

  // Ineligible: Truncated response
  const checkTrunc = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: true,
    headers: baseHeaders,
  });
  assert.equal(checkTrunc.eligible, false);
  assert.equal(checkTrunc.reason, "truncated_response");

  // Ineligible: Cache-Control no-store
  const checkNoStore = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, "cache-control": "no-store, no-cache" },
  });
  assert.equal(checkNoStore.eligible, false);
  assert.equal(checkNoStore.reason, "cache_control_no_store_or_private");

  // Ineligible: Cache-Control private
  const checkPrivate = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, "cache-control": "private, max-age=3600" },
  });
  assert.equal(checkPrivate.eligible, false);
  assert.equal(checkPrivate.reason, "cache_control_no_store_or_private");

  // Ineligible: Set-Cookie header present
  const checkCookie = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, "set-cookie": "session=abc; Secure" },
  });
  assert.equal(checkCookie.eligible, false);
  assert.equal(checkCookie.reason, "set_cookie_present");

  // Ineligible: Vary: *
  const checkVary = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, vary: "*" },
  });
  assert.equal(checkVary.eligible, false);
  assert.equal(checkVary.reason, "vary_asterisk");

  // Ineligible: Compressed Content-Encoding
  const checkGzip = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, "content-encoding": "gzip" },
  });
  assert.equal(checkGzip.eligible, false);
  assert.equal(checkGzip.reason, "compressed_content_encoding");

  // Ineligible: Missing validator
  const checkNoVal = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { "content-type": "text/plain" },
  });
  assert.equal(checkNoVal.eligible, false);
  assert.equal(checkNoVal.reason, "missing_or_invalid_validator");

  // Eligible with Last-Modified only
  const checkLm = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: {
      "content-type": "text/plain",
      "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
    },
  });
  assert.equal(checkLm.eligible, true);
  assert.equal(checkLm.sanitizedLastModified, "Wed, 21 Oct 2026 07:28:00 GMT");
});

test("HttpConditionalCache — Disabled Cache Invariant", () => {
  const disabledCache = new HttpConditionalCache(DEFAULT_NETWORK_CACHE_POLICY);
  assert.equal(disabledCache.enabled, false);
  assert.equal(disabledCache.size, 0);

  // Set / get on disabled cache are safe no-ops
  const dummyEntry: CachedHttpResponse = {
    bodyBuffer: Buffer.from("hello"),
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  };

  disabledCache.set("key1", dummyEntry);
  assert.equal(disabledCache.get("key1"), undefined);
  assert.equal(disabledCache.size, 0);
});

test("HttpConditionalCache — Entry Storage, Retrieval & Replacement", () => {
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );
  assert.equal(cache.enabled, true);

  const entry1: CachedHttpResponse = {
    bodyBuffer: Buffer.from("version-1"),
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    etag: '"v1"',
    storedAt: Date.now(),
  };

  cache.set("hash-key-1", entry1);
  assert.equal(cache.size, 1);
  const retrieved1 = cache.get("hash-key-1");
  assert.ok(retrieved1);
  assert.equal(retrieved1.bodyBuffer.toString("utf-8"), "version-1");
  assert.equal(retrieved1.etag, '"v1"');

  // Replace entry with version-2
  const entry2: CachedHttpResponse = {
    bodyBuffer: Buffer.from("version-2"),
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    etag: '"v2"',
    storedAt: Date.now(),
  };
  cache.set("hash-key-1", entry2);
  assert.equal(cache.size, 1);
  const retrieved2 = cache.get("hash-key-1");
  assert.ok(retrieved2);
  assert.equal(retrieved2.bodyBuffer.toString("utf-8"), "version-2");
  assert.equal(retrieved2.etag, '"v2"');

  // Delete entry
  cache.delete("hash-key-1");
  assert.equal(cache.size, 0);
  assert.equal(cache.get("hash-key-1"), undefined);
});

test("HttpConditionalCache — LRU Entry Eviction", () => {
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 2,
      maxSizeBytes: 1024 * 1024,
    })
  );

  cache.set("k1", {
    bodyBuffer: Buffer.from("1"),
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  });
  cache.set("k2", {
    bodyBuffer: Buffer.from("2"),
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  });
  assert.equal(cache.size, 2);

  // Access k1 to make k2 least recently used
  cache.get("k1");

  // Insert k3 -> k2 should be evicted
  cache.set("k3", {
    bodyBuffer: Buffer.from("3"),
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  });

  assert.equal(cache.size, 2);
  assert.ok(cache.get("k1"));
  assert.equal(cache.get("k2"), undefined); // Evicted
  assert.ok(cache.get("k3"));
});

test("HttpConditionalCache — MaxSize Logical Payload Eviction", () => {
  // Max size is 1000 bytes. Each entry sizeCalculation includes body length + 128 overhead.
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 100,
      maxSizeBytes: 1024, // 1 KiB
    })
  );

  const bigBuffer = Buffer.alloc(400, "a"); // 400 + 128 = 528 bytes per entry
  cache.set("e1", {
    bodyBuffer: bigBuffer,
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  });

  assert.equal(cache.size, 1);
  assert.ok(cache.calculatedSize >= 528);

  // Insert second entry (total ~1056 > 1024) -> e1 evicted
  cache.set("e2", {
    bodyBuffer: bigBuffer,
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  });

  assert.equal(cache.size, 1);
  assert.equal(cache.get("e1"), undefined);
  assert.ok(cache.get("e2"));
});

test("HttpConditionalCache — Retention TTL Expiration", async () => {
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
      retentionTtlMs: 1000, // 1 second retention
    })
  );

  cache.set("temp-key", {
    bodyBuffer: Buffer.from("temp-data"),
    status: 200,
    statusText: "OK",
    storedAt: Date.now(),
  });

  assert.ok(cache.get("temp-key"));

  // Wait for retention TTL expiry
  await new Promise((resolve) => setTimeout(resolve, 1100));

  assert.equal(cache.get("temp-key"), undefined);
});

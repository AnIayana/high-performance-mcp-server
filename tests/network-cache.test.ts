import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const checkVaryAsterisk = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, vary: "*" },
  });
  assert.equal(checkVaryAsterisk.eligible, false);
  assert.equal(checkVaryAsterisk.reason, "vary_header_present");

  // Ineligible: Vary: Accept (v1 policy: ANY Vary header is uncacheable)
  const checkVaryAccept = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, vary: "Accept" },
  });
  assert.equal(checkVaryAccept.eligible, false);
  assert.equal(checkVaryAccept.reason, "vary_header_present");

  // Ineligible: Vary: Accept-Encoding, User-Agent
  const checkVaryMulti = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data"),
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { ...baseHeaders, vary: "Accept-Encoding, User-Agent" },
  });
  assert.equal(checkVaryMulti.eligible, false);
  assert.equal(checkVaryMulti.reason, "vary_header_present");

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
  // Max size is 1024 bytes. Each entry sizeCalculation includes body length + 128 overhead.
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

test("HttpConditionalCache — Large Validator Size Accounting (1000-byte ETag)", () => {
  // Configured max size: 1024 bytes (1 KiB)
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 100,
      maxSizeBytes: 1024,
    })
  );

  // Small body (16 bytes), but large ETag (1000 bytes) + 128 metadata = 1144 bytes > 1024 maxSizeBytes
  const largeEtag = `"${"x".repeat(998)}"`; // 1000 bytes string
  const entry: CachedHttpResponse = {
    bodyBuffer: Buffer.from("1234567890123456"), // 16 bytes
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    etag: largeEtag,
    storedAt: Date.now(),
  };

  cache.set("large-etag-entry", entry);

  // Under old `bodyBuffer.length + 128` (16 + 128 = 144 bytes), it would have been retained!
  // Under accurate sizeCalculation (16 + 1000 + 10 + 2 + 128 = 1156 > 1024), it exceeds maxSize and is not retained.
  assert.equal(cache.get("large-etag-entry"), undefined);
  assert.equal(cache.size, 0);
});

test("HttpConditionalCache — Multi-Entry Logical Size Accounting with Metadata", () => {
  // Configured max size: 1024 bytes (1 KiB)
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024,
    })
  );

  // Each entry: 200 bytes body + 200 bytes ETag + 20 bytes Content-Type + 128 overhead = 548 bytes
  // Two entries: ~1096 bytes > 1024 -> Inserting entry 2 evicts entry 1
  const entry1: CachedHttpResponse = {
    bodyBuffer: Buffer.alloc(200, "1"),
    status: 200,
    statusText: "OK",
    contentType: "application/json",
    etag: `"${"a".repeat(198)}"`,
    storedAt: Date.now(),
  };

  const entry2: CachedHttpResponse = {
    bodyBuffer: Buffer.alloc(200, "2"),
    status: 200,
    statusText: "OK",
    contentType: "application/json",
    etag: `"${"b".repeat(198)}"`,
    storedAt: Date.now(),
  };

  cache.set("entry-1", entry1);
  assert.equal(cache.size, 1);
  assert.ok(cache.get("entry-1"));

  // Body sizes alone (200 + 200 = 400) would fit in 1024!
  // But body + metadata (548 + 548 = 1096) exceeds 1024 -> entry 1 must be evicted.
  cache.set("entry-2", entry2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("entry-1"), undefined); // Evicted
  assert.ok(cache.get("entry-2"));
  assert.ok(cache.calculatedSize <= 1024);
});

test("HttpConditionalCache — Oversized Single Entry (> maxSizeBytes) Safe Rejection", () => {
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024, // 1 KiB limit
    })
  );

  // Single entry whose logical payload is 2000 bytes > 1024
  const oversizedEntry: CachedHttpResponse = {
    bodyBuffer: Buffer.alloc(2000, "x"),
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    etag: '"oversized"',
    storedAt: Date.now(),
  };

  // set() should not crash/throw, but LRUCache drops the entry immediately
  cache.set("too-big", oversizedEntry);
  assert.equal(cache.get("too-big"), undefined);
  assert.equal(cache.size, 0);
  assert.equal(cache.calculatedSize, 0);
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

test("Network Cache Key — Legacy GET preimage preservation and HEAD isolation", () => {
  const testUrls = [
    new URL("https://example.com/data"),
    new URL("https://example.com/api/v1/resource#hash"),
    new URL("https://example.com:443/data"),
  ];

  // Query parameter URLs are uncacheable for both GET and HEAD
  const queryUrl = new URL("https://example.com/data?query=1");
  assert.equal(computeCacheKey(queryUrl), null);
  assert.equal(computeCacheKey(queryUrl, "GET"), null);
  assert.equal(computeCacheKey(queryUrl, "HEAD"), null);

  for (const url of testUrls) {
    const canonicalUrl = url.protocol + "//" + url.host + url.pathname;

    // 1. GET omitted key === GET explicit key
    const omittedKey = computeCacheKey(url);
    const explicitGetKey = computeCacheKey(url, "GET");
    assert.equal(omittedKey, explicitGetKey, "Omitted method must match explicit GET key");

    // 2. Existing legacy GET preimage is exactly preserved: "network-fetch-v1\0" + canonicalUrl
    const expectedLegacyPreimage = "network-fetch-v1\0" + canonicalUrl;
    const expectedLegacyHash = createHash("sha256").update(expectedLegacyPreimage, "utf8").digest("hex");
    assert.equal(omittedKey, expectedLegacyHash, "GET cache key must match legacy preimage hash");
    assert.equal(explicitGetKey, expectedLegacyHash, "Explicit GET cache key must match legacy preimage hash");

    // 3. HEAD key !== GET key
    const headKey = computeCacheKey(url, "HEAD");
    assert.notEqual(headKey, explicitGetKey, "HEAD cache key must never equal GET cache key");
    assert.notEqual(headKey, omittedKey, "HEAD cache key must never equal omitted method cache key");

    // 4. HEAD preimage is collision-safe and isolated: "network-fetch-v1\0HEAD\0" + canonicalUrl
    const expectedHeadPreimage = "network-fetch-v1\0HEAD\0" + canonicalUrl;
    const expectedHeadHash = createHash("sha256").update(expectedHeadPreimage, "utf8").digest("hex");
    assert.equal(headKey, expectedHeadHash, "HEAD cache key must match HEAD preimage hash");
  }
});

test("Network Cache Eligibility — HEAD binary metadata and Content-Encoding rules", () => {
  const httpsUrl = new URL("https://example.com/image.png");

  // 1. HEAD binary metadata (image/png) with ETag is eligible
  const headPng = checkResponseCacheEligibility({
    targetUrl: httpsUrl,
    method: "HEAD",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: {
      "content-type": "image/png",
      etag: '"png-123"',
    },
  });
  assert.equal(headPng.eligible, true);
  assert.equal(headPng.sanitizedEtag, '"png-123"');

  // 2. HEAD application/pdf with Last-Modified is eligible
  const headPdf = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/doc.pdf"),
    method: "HEAD",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: {
      "content-type": "application/pdf",
      "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
    },
  });
  assert.equal(headPdf.eligible, true);
  assert.equal(headPdf.sanitizedLastModified, "Wed, 21 Oct 2026 07:28:00 GMT");

  // 3. Content-Encoding: gzip
  // For GET: rejected as compressed_content_encoding
  const getGzip = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data.json"),
    method: "GET",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      etag: '"gzip-123"',
    },
  });
  assert.equal(getGzip.eligible, false);
  assert.equal(getGzip.reason, "compressed_content_encoding");

  // For HEAD: eligible since no body is cached or decoded
  const headGzip = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/data.json"),
    method: "HEAD",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      etag: '"gzip-123"',
    },
  });
  assert.equal(headGzip.eligible, true);

  // 4. Standard security constraints still apply to HEAD
  // HTTP (non-https) rejected
  const headHttp = checkResponseCacheEligibility({
    targetUrl: new URL("http://example.com/image.png"),
    method: "HEAD",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { etag: '"tag"' },
  });
  assert.equal(headHttp.eligible, false);
  assert.equal(headHttp.reason, "http_not_cached");

  // Query parameters rejected
  const headQuery = checkResponseCacheEligibility({
    targetUrl: new URL("https://example.com/image.png?v=1"),
    method: "HEAD",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { etag: '"tag"' },
  });
  assert.equal(headQuery.eligible, false);
  assert.equal(headQuery.reason, "query_urls_not_cached");

  // Redirect hops rejected
  const headRedirect = checkResponseCacheEligibility({
    targetUrl: httpsUrl,
    method: "HEAD",
    redirectCount: 1,
    status: 200,
    truncated: false,
    headers: { etag: '"tag"' },
  });
  assert.equal(headRedirect.eligible, false);
  assert.equal(headRedirect.reason, "redirects_not_cached");

  // Missing validator rejected
  const headNoValidator = checkResponseCacheEligibility({
    targetUrl: httpsUrl,
    method: "HEAD",
    redirectCount: 0,
    status: 200,
    truncated: false,
    headers: { "content-type": "image/png" },
  });
  assert.equal(headNoValidator.eligible, false);
  assert.equal(headNoValidator.reason, "missing_or_invalid_validator");
});

test("HttpConditionalCache — HEAD entries storage (Buffer.alloc(0)) and bidirectional method isolation", () => {
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  const testUrl = new URL("https://example.com/resource");
  const getKey = computeCacheKey(testUrl, "GET");
  const headKey = computeCacheKey(testUrl, "HEAD");

  // Store HEAD entry
  const headEntry: CachedHttpResponse = {
    bodyBuffer: Buffer.alloc(0),
    status: 200,
    statusText: "OK",
    contentType: "image/png",
    contentLength: 204800,
    etag: '"head-etag-1"',
    storedAt: Date.now(),
  };
  cache.set(headKey, headEntry);

  // HEAD key retrieves the entry
  const retrievedHead = cache.get(headKey);
  assert.ok(retrievedHead);
  assert.equal(retrievedHead.status, 200);
  assert.equal(retrievedHead.contentType, "image/png");
  assert.equal(retrievedHead.contentLength, 204800);
  assert.equal(retrievedHead.bodyBuffer.byteLength, 0);

  // Invariant: GET cache query cannot satisfy HEAD entry
  assert.equal(cache.get(getKey), undefined, "GET lookup MUST NOT find HEAD entry");

  // Store GET entry for same resource
  const getEntry: CachedHttpResponse = {
    bodyBuffer: Buffer.from("GET representation text", "utf8"),
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    contentLength: 23,
    etag: '"get-etag-1"',
    storedAt: Date.now(),
  };
  cache.set(getKey, getEntry);

  // Invariant: HEAD lookup retrieves HEAD entry, NOT GET entry
  const secondHeadLookup = cache.get(headKey);
  assert.ok(secondHeadLookup);
  assert.equal(secondHeadLookup.etag, '"head-etag-1"');
  assert.equal(secondHeadLookup.contentType, "image/png");
  assert.equal(secondHeadLookup.bodyBuffer.byteLength, 0);

  // Invariant: GET lookup retrieves GET entry, NOT HEAD entry
  const getLookup = cache.get(getKey);
  assert.ok(getLookup);
  assert.equal(getLookup.etag, '"get-etag-1"');
  assert.equal(getLookup.contentType, "text/plain");
  assert.equal(getLookup.bodyBuffer.toString("utf8"), "GET representation text");
});

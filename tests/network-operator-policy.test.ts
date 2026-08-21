import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateEffectiveMaxBytes,
  calculateEffectiveTimeoutMs,
  createNetworkOperatorPolicy,
  DEFAULT_NETWORK_OPERATOR_POLICY,
  evaluateHostnamePolicy,
  matchesHostPattern,
  normalizeHostPattern,
} from "../src/network/operator-policy.js";
import {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_MAX_BYTES,
  MAX_FETCH_TIMEOUT_MS,
} from "../src/network/policy.js";

test("Operator Policy — DEFAULT_NETWORK_OPERATOR_POLICY invariants", () => {
  assert.deepEqual(DEFAULT_NETWORK_OPERATOR_POLICY.allowHosts, []);
  assert.deepEqual(DEFAULT_NETWORK_OPERATOR_POLICY.denyHosts, []);
  assert.equal(DEFAULT_NETWORK_OPERATOR_POLICY.httpsOnly, false);
  assert.equal(DEFAULT_NETWORK_OPERATOR_POLICY.maxResponseBytes, MAX_FETCH_MAX_BYTES);
  assert.equal(DEFAULT_NETWORK_OPERATOR_POLICY.maxTimeoutMs, MAX_FETCH_TIMEOUT_MS);
});

test("Operator Policy — normalizeHostPattern exact hostname rules", () => {
  assert.equal(normalizeHostPattern("example.com"), "example.com");
  assert.equal(normalizeHostPattern("EXAMPLE.COM"), "example.com");
  assert.equal(normalizeHostPattern("  example.com.  "), "example.com");
  assert.equal(normalizeHostPattern("sub.domain.co.uk"), "sub.domain.co.uk");
  assert.equal(normalizeHostPattern("api-v2.service.io"), "api-v2.service.io");
});

test("Operator Policy — normalizeHostPattern wildcard rules", () => {
  assert.equal(normalizeHostPattern("*.example.com"), "*.example.com");
  assert.equal(normalizeHostPattern("*.EXAMPLE.COM"), "*.example.com");
  assert.equal(normalizeHostPattern("  *.example.com.  "), "*.example.com");
  assert.equal(normalizeHostPattern("*.sub.domain.co.uk"), "*.sub.domain.co.uk");
});

test("Operator Policy — normalizeHostPattern rejects invalid formats", () => {
  // Empty or whitespace
  assert.throws(() => normalizeHostPattern(""), /cannot be empty/i);
  assert.throws(() => normalizeHostPattern("   "), /cannot be empty/i);

  // Scheme, path, query, port, credentials
  assert.throws(() => normalizeHostPattern("https://example.com"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("http://example.com"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("example.com/path"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("example.com?query=1"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("example.com#hash"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("example.com:443"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("user:pass@example.com"), /bare hostname/i);
  assert.throws(() => normalizeHostPattern("example com"), /bare hostname/i);

  // Invalid wildcard positions
  assert.throws(() => normalizeHostPattern("*"), /leading "\*\."/i);
  assert.throws(() => normalizeHostPattern("**"), /leading "\*\."/i);
  assert.throws(() => normalizeHostPattern("*example.com"), /leading "\*\."/i);
  assert.throws(() => normalizeHostPattern("example.*"), /leading "\*\."/i);
  assert.throws(() => normalizeHostPattern("api.*.example.com"), /leading "\*\."/i);
  assert.throws(() => normalizeHostPattern("*."), /Invalid host pattern/i);
  assert.throws(() => normalizeHostPattern("*.."), /Invalid host pattern/i);

  // IP literals are rejected in hostname policies
  assert.throws(() => normalizeHostPattern("127.0.0.1"), /IP literals are not allowed/i);
  assert.throws(() => normalizeHostPattern("10.0.0.1"), /IP literals are not allowed/i);
  assert.throws(() => normalizeHostPattern("::1"), /Invalid host pattern/i);
  assert.throws(() => normalizeHostPattern("[::1]"), /Invalid host pattern/i);

  // Forbidden local / internal hostnames
  assert.throws(() => normalizeHostPattern("localhost"), /Localhost and private hostnames/i);
  assert.throws(() => normalizeHostPattern("*.localhost"), /Localhost and private hostnames/i);
  assert.throws(() => normalizeHostPattern("local"), /Localhost and private hostnames/i);
  assert.throws(() => normalizeHostPattern("*.local"), /Localhost and private hostnames/i);
  assert.throws(() => normalizeHostPattern("internal"), /Localhost and private hostnames/i);
  assert.throws(() => normalizeHostPattern("*.internal"), /Localhost and private hostnames/i);
});

test("Operator Policy — matchesHostPattern matching semantics", () => {
  // Exact match
  assert.equal(matchesHostPattern("example.com", "example.com"), true);
  assert.equal(matchesHostPattern("EXAMPLE.COM", "example.com"), true);
  assert.equal(matchesHostPattern("example.com.", "example.com"), true);
  assert.equal(matchesHostPattern("sub.example.com", "example.com"), false);
  assert.equal(matchesHostPattern("notexample.com", "example.com"), false);

  // Wildcard match
  assert.equal(matchesHostPattern("api.example.com", "*.example.com"), true);
  assert.equal(matchesHostPattern("sub.api.example.com", "*.example.com"), true);
  assert.equal(matchesHostPattern("API.EXAMPLE.COM", "*.example.com"), true);
  // Wildcard does NOT match apex domain
  assert.equal(matchesHostPattern("example.com", "*.example.com"), false);
  // Wildcard does NOT match unrelated domain ending with same suffix
  assert.equal(matchesHostPattern("badexample.com", "*.example.com"), false);
  assert.equal(matchesHostPattern("not-example.com", "*.example.com"), false);
});

test("Operator Policy — evaluateHostnamePolicy allow and deny evaluation", () => {
  // Empty policy allows everything passing built-in checks
  const emptyPolicy = createNetworkOperatorPolicy({});
  assert.deepEqual(evaluateHostnamePolicy("example.com", emptyPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("api.github.com", emptyPolicy), { allowed: true });

  // Allowlist only
  const allowPolicy = createNetworkOperatorPolicy({
    allowHosts: ["example.com", "*.github.com"],
  });
  assert.deepEqual(evaluateHostnamePolicy("example.com", allowPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("api.github.com", allowPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("raw.github.com", allowPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("github.com", allowPolicy), {
    allowed: false,
    reason: "host_not_allowed",
  });
  assert.deepEqual(evaluateHostnamePolicy("evil.com", allowPolicy), {
    allowed: false,
    reason: "host_not_allowed",
  });

  // Denylist only
  const denyPolicy = createNetworkOperatorPolicy({
    denyHosts: ["tracker.example.com", "*.ads.net"],
  });
  assert.deepEqual(evaluateHostnamePolicy("example.com", denyPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("tracker.example.com", denyPolicy), {
    allowed: false,
    reason: "host_denied",
  });
  assert.deepEqual(evaluateHostnamePolicy("banner.ads.net", denyPolicy), {
    allowed: false,
    reason: "host_denied",
  });
  assert.deepEqual(evaluateHostnamePolicy("ads.net", denyPolicy), { allowed: true });

  // Deny takes PRECEDENCE over Allow
  const mixedPolicy = createNetworkOperatorPolicy({
    allowHosts: ["*.example.com", "example.com"],
    denyHosts: ["secret.example.com", "evil.example.com"],
  });
  assert.deepEqual(evaluateHostnamePolicy("example.com", mixedPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("api.example.com", mixedPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("secret.example.com", mixedPolicy), {
    allowed: false,
    reason: "host_denied",
  });
  assert.deepEqual(evaluateHostnamePolicy("evil.example.com", mixedPolicy), {
    allowed: false,
    reason: "host_denied",
  });
  assert.deepEqual(evaluateHostnamePolicy("other.org", mixedPolicy), {
    allowed: false,
    reason: "host_not_allowed",
  });
});

test("Operator Policy — calculateEffectiveMaxBytes bounding rules", () => {
  const customPolicy = createNetworkOperatorPolicy({
    maxResponseBytes: 262_144, // 256 KiB
  });

  // Caller asks default (1 MiB), operator restricts to 256 KiB
  assert.equal(calculateEffectiveMaxBytes(undefined, customPolicy), 262_144);
  assert.equal(calculateEffectiveMaxBytes(DEFAULT_FETCH_MAX_BYTES, customPolicy), 262_144);

  // Caller asks for 64 KiB, which is below operator 256 KiB
  assert.equal(calculateEffectiveMaxBytes(65_536, customPolicy), 65_536);

  // Caller asks for 10 MiB, operator cap is 256 KiB
  assert.equal(calculateEffectiveMaxBytes(10_000_000, customPolicy), 262_144);

  // No operator cap (default policy)
  assert.equal(
    calculateEffectiveMaxBytes(undefined, DEFAULT_NETWORK_OPERATOR_POLICY),
    DEFAULT_FETCH_MAX_BYTES
  );
  assert.equal(
    calculateEffectiveMaxBytes(3_000_000, DEFAULT_NETWORK_OPERATOR_POLICY),
    3_000_000
  );
  // Capped at MAX_FETCH_MAX_BYTES (5 MiB)
  assert.equal(
    calculateEffectiveMaxBytes(10_000_000, DEFAULT_NETWORK_OPERATOR_POLICY),
    MAX_FETCH_MAX_BYTES
  );
});

test("Operator Policy — calculateEffectiveTimeoutMs bounding rules", () => {
  const customPolicy = createNetworkOperatorPolicy({
    maxTimeoutMs: 5000, // 5s
  });

  // Caller asks default (10s), operator restricts to 5s
  assert.equal(calculateEffectiveTimeoutMs(undefined, customPolicy), 5000);
  assert.equal(calculateEffectiveTimeoutMs(DEFAULT_FETCH_TIMEOUT_MS, customPolicy), 5000);

  // Caller asks for 2s, below operator 5s
  assert.equal(calculateEffectiveTimeoutMs(2000, customPolicy), 2000);

  // Caller asks for 25s, operator cap is 5s
  assert.equal(calculateEffectiveTimeoutMs(25_000, customPolicy), 5000);

  // No operator cap (default policy)
  assert.equal(
    calculateEffectiveTimeoutMs(undefined, DEFAULT_NETWORK_OPERATOR_POLICY),
    DEFAULT_FETCH_TIMEOUT_MS
  );
  assert.equal(
    calculateEffectiveTimeoutMs(15_000, DEFAULT_NETWORK_OPERATOR_POLICY),
    15_000
  );
  // Capped at MAX_FETCH_TIMEOUT_MS (30s)
  assert.equal(
    calculateEffectiveTimeoutMs(60_000, DEFAULT_NETWORK_OPERATOR_POLICY),
    MAX_FETCH_TIMEOUT_MS
  );
});

test("Operator Policy — createNetworkOperatorPolicy boundary validations", () => {
  // Invalid maxResponseBytes
  assert.throws(
    () => createNetworkOperatorPolicy({ maxResponseBytes: 0 }),
    /Invalid maxResponseBytes/
  );
  assert.throws(
    () => createNetworkOperatorPolicy({ maxResponseBytes: -100 }),
    /Invalid maxResponseBytes/
  );
  assert.throws(
    () => createNetworkOperatorPolicy({ maxResponseBytes: 6_000_000 }),
    /Invalid maxResponseBytes/
  );

  // Invalid maxTimeoutMs
  assert.throws(
    () => createNetworkOperatorPolicy({ maxTimeoutMs: 500 }),
    /Invalid maxTimeoutMs/
  );
  assert.throws(
    () => createNetworkOperatorPolicy({ maxTimeoutMs: 35_000 }),
    /Invalid maxTimeoutMs/
  );
});

test("Operator Policy — Unicode / IDN normalization & invalid IDNA fail-fast", () => {
  // Unicode/IDN hostnames are canonicalized to Punycode ASCII
  assert.equal(normalizeHostPattern("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeHostPattern("MÜNCHEN.DE"), "xn--mnchen-3ya.de");
  assert.equal(normalizeHostPattern("*.münchen.de"), "*.xn--mnchen-3ya.de");
  assert.equal(normalizeHostPattern("xn--mnchen-3ya.de"), "xn--mnchen-3ya.de");

  // Matching works seamlessly across IDN / Punycode representations
  const idnPolicy = createNetworkOperatorPolicy({
    allowHosts: ["münchen.de", "*.københavn.dk"],
  });
  assert.deepEqual(evaluateHostnamePolicy("xn--mnchen-3ya.de", idnPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("münchen.de", idnPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("turist.københavn.dk", idnPolicy), { allowed: true });
  assert.deepEqual(evaluateHostnamePolicy("turist.xn--kbenhavn-54a.dk", idnPolicy), {
    allowed: true,
  });
  assert.deepEqual(evaluateHostnamePolicy("københavn.dk", idnPolicy), {
    allowed: false,
    reason: "host_not_allowed",
  });
});

test("Operator Policy — Raw Public IP literals vs Allowlist", () => {
  // Case A: Empty allowlist permits public IP literal (subject to SSRF blocklist)
  const emptyPolicy = createNetworkOperatorPolicy({});
  assert.deepEqual(evaluateHostnamePolicy("93.184.216.34", emptyPolicy), { allowed: true });

  // Case B: Non-empty allowlist containing only DNS hostnames blocks raw IP literals
  const hostAllowPolicy = createNetworkOperatorPolicy({
    allowHosts: ["example.com", "*.example.com"],
  });
  assert.deepEqual(evaluateHostnamePolicy("93.184.216.34", hostAllowPolicy), {
    allowed: false,
    reason: "host_not_allowed",
  });
});

test("Operator Policy — Runtime Immutability and Object.freeze", () => {
  const policy = createNetworkOperatorPolicy({
    allowHosts: ["example.com"],
    denyHosts: ["bad.example.com"],
    httpsOnly: true,
    maxResponseBytes: 1_000_000,
    maxTimeoutMs: 5000,
  });

  assert.ok(Object.isFrozen(policy), "policy object must be frozen");
  assert.ok(Object.isFrozen(policy.allowHosts), "allowHosts array must be frozen");
  assert.ok(Object.isFrozen(policy.denyHosts), "denyHosts array must be frozen");

  // Attempting runtime mutation throws in strict mode
  assert.throws(() => {
    (policy as any).httpsOnly = false;
  }, TypeError);
  assert.throws(() => {
    (policy.allowHosts as any).push("attacker.com");
  }, TypeError);
  assert.throws(() => {
    (policy.denyHosts as any).pop();
  }, TypeError);
});


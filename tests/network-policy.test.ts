import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIpAddress } from "../src/network/ip-classifier.js";
import { createSafeLookupFunction } from "../src/network/dns.js";
import {
  DEFAULT_ALLOWED_PORTS,
  validateAndParseUrl,
} from "../src/network/policy.js";
import type { DnsRecord, SafeDnsResolver } from "../src/network/types.js";
import { NetworkSecurityError } from "../src/network/types.js";

// =====================================================================
// 1. IP CLASSIFICATION TESTS
// =====================================================================

test("Network IP Classifier — Blocks all IPv4 private and special-use ranges", () => {
  const blockedIpv4 = [
    // Loopback (127.0.0.0/8)
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.255",
    // Unspecified / Current network (0.0.0.0/8)
    "0.0.0.0",
    "0.255.255.255",
    // Private RFC 1918 (10.0.0.0/8)
    "10.0.0.1",
    "10.254.254.254",
    "10.255.255.255",
    // Private RFC 1918 (172.16.0.0/12)
    "172.16.0.1",
    "172.24.100.50",
    "172.31.255.255",
    // Private RFC 1918 (192.168.0.0/16)
    "192.168.0.1",
    "192.168.1.1",
    "192.168.254.254",
    // Link-Local / Cloud Metadata (169.254.0.0/16)
    "169.254.0.1",
    "169.254.169.254",
    "169.254.255.254",
    // Carrier-Grade NAT RFC 6598 (100.64.0.0/10)
    "100.64.0.1",
    "100.100.100.100",
    "100.127.255.254",
    // Multicast (224.0.0.0/4)
    "224.0.0.1",
    "239.255.255.255",
    // Reserved / Broadcast (240.0.0.0/4)
    "240.0.0.1",
    "255.255.255.255",
    // Documentation ranges
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    // Benchmarking (198.18.0.0/15)
    "198.18.0.1",
    "198.19.255.254",
  ];

  for (const ip of blockedIpv4) {
    const res = classifyIpAddress(ip);
    assert.equal(res.allowed, false, `Expected ${ip} to be blocked`);
    assert.equal(res.family, 4);
    assert.ok(res.reason, `Expected reason for blocking ${ip}`);
  }
});

test("Network IP Classifier — Blocks all IPv6 private, loopback, and special-use ranges", () => {
  const blockedIpv6 = [
    // Loopback (::1)
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    // Unspecified (::)
    "::",
    "[::]",
    "0:0:0:0:0:0:0:0",
    // Unique-Local RFC 4193 (fc00::/7)
    "fc00::1",
    "fc00:1234::1",
    "fd00::1",
    "fd12:3456:789a::1",
    // Link-Local RFC 4291 (fe80::/10)
    "fe80::1",
    "fe80::169:254:169:254",
    "febf::ffff",
    // Multicast (ff00::/8)
    "ff02::1",
    "ff05::2",
    // Documentation (2001:db8::/32)
    "2001:db8::1",
    // Discard-only (100::/64)
    "100::1",
    // Local-Use translation (64:ff9b:1::/48)
    "64:ff9b:1::1",
  ];

  for (const ip of blockedIpv6) {
    const res = classifyIpAddress(ip);
    assert.equal(res.allowed, false, `Expected ${ip} to be blocked`);
    assert.equal(res.family, 6);
  }
});

test("Network IP Classifier — Blocks IPv4-Mapped and Transition IPv6 encapsulating private IPv4", () => {
  const transitionBlocked = [
    // IPv4-mapped IPv6 (::ffff:0:0/96)
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.1.1",
    "::ffff:172.16.0.1",
    "::ffff:7f00:1", // 127.0.0.1 in hex
    "::ffff:a00:1",  // 10.0.0.1 in hex
    // IPv4-compatible (::/96)
    "::127.0.0.1",
    "::10.0.0.1",
    "::192.168.1.1",
    // NAT64 Well-Known Prefix (64:ff9b::/96)
    "64:ff9b::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "64:ff9b::169.254.169.254",
    "64:ff9b::192.168.1.1",
    // 6to4 RFC 3056 (2002::/16)
    "2002:7f00:0001::", // 127.0.0.1
    "2002:0a00:0001::", // 10.0.0.1
    "2002:c0a8:0101::", // 192.168.1.1
    "2002:a9fe:a9fe::", // 169.254.169.254
  ];

  for (const ip of transitionBlocked) {
    const res = classifyIpAddress(ip);
    assert.equal(res.allowed, false, `Expected transition IP ${ip} to be blocked`);
  }
});

test("Network IP Classifier — Allows valid public IPv4 and IPv6 addresses", () => {
  const allowedPublic = [
    // Standard public IPv4 (RFC 5737 public ranges)
    "93.184.216.34",   // example.com
    "8.8.8.8",
    "1.1.1.1",
    "151.101.1.140",
    "104.244.42.1",
    // Standard public IPv6 (Global Unicast 2000::/3)
    "2606:2800:220:1:248:1893:25c8:1946",
    "2001:4860:4860::8888",
    "2607:f8b0:4005:805::200e",
    // Transition with public IPv4 (93.184.216.34 = 0x5db8d822)
    "::ffff:93.184.216.34",
    "64:ff9b::93.184.216.34",
    "2002:5db8:d822::",
  ];

  for (const ip of allowedPublic) {
    const res = classifyIpAddress(ip);
    assert.equal(res.allowed, true, `Expected public IP ${ip} to be allowed`);
  }
});

// =====================================================================
// 2. URL & POLICY VALIDATION TESTS
// =====================================================================

test("Network Policy — Allowed and disallowed URL schemes", () => {
  // Allowed
  assert.doesNotThrow(() => validateAndParseUrl("http://example.com"));
  assert.doesNotThrow(() => validateAndParseUrl("https://example.com"));
  assert.doesNotThrow(() => validateAndParseUrl("https://example.com:8443/api?q=1"));

  // Disallowed schemes
  const invalidSchemes = [
    "file:///etc/passwd",
    "ftp://example.com/file.txt",
    "data:text/plain;base64,SGVsbG8=",
    "javascript:alert(1)",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "gopher://example.com",
    "blob:https://example.com/123",
  ];

  for (const url of invalidSchemes) {
    assert.throws(
      () => validateAndParseUrl(url),
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_protocol"
    );
  }
});

test("Network Policy — Rejects embedded credentials in URL", () => {
  const credentialUrls = [
    "https://user:password@example.com",
    "http://admin:@example.com/secret",
    "https://:pass@example.com/",
    "http://user@example.com/",
  ];

  for (const url of credentialUrls) {
    assert.throws(
      () => validateAndParseUrl(url),
      (err: any) => err instanceof NetworkSecurityError && err.code === "credentials_not_allowed"
    );
  }
});

test("Network Policy — Rejects URLs exceeding max length", () => {
  const longUrl = "https://example.com/" + "a".repeat(2048);
  assert.throws(
    () => validateAndParseUrl(longUrl),
    (err: any) => err instanceof NetworkSecurityError && err.code === "invalid_url"
  );
});

test("Network Policy — Port allowlist enforcement", () => {
  // Allowed default ports
  for (const port of DEFAULT_ALLOWED_PORTS) {
    const scheme = port === 443 || port === 8443 ? "https" : "http";
    assert.doesNotThrow(() => validateAndParseUrl(`${scheme}://example.com:${port}/`));
  }

  // Disallowed ports
  const disallowedPorts = [21, 22, 25, 53, 3000, 3306, 5432, 6379, 8000, 9200, 27017];
  for (const port of disallowedPorts) {
    assert.throws(
      () => validateAndParseUrl(`http://example.com:${port}/`),
      (err: any) => err instanceof NetworkSecurityError && err.code === "port_not_allowed"
    );
  }
});

test("Network Policy — Unusual IPv4 syntax canonicalization and blocking", () => {
  // WHATWG URL parser normalizes decimal, octal, hex, and shorthand IPv4 formats to canonical IPv4
  const weirdIpv4Urls = [
    "http://127.1/",             // Short for 127.0.0.1
    "http://2130706433/",        // Decimal integer for 127.0.0.1
    "http://0x7f000001/",        // Hexadecimal for 127.0.0.1
    "http://0177.0.0.1/",        // Octal prefix for 127.0.0.1
    "http://0x7f.1/",            // Mixed hex/shorthand
    "http://10.1/",              // Shorthand for 10.0.0.1
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ];

  for (const url of weirdIpv4Urls) {
    assert.throws(
      () => validateAndParseUrl(url),
      (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination",
      `Expected ${url} to be rejected as blocked destination`
    );
  }
});

test("Network Policy — Hostname canonicalization and blocked hostnames", () => {
  const blockedHostnames = [
    "http://localhost/",
    "http://LOCALHOST/",
    "http://localhost./",
    "http://LOCALHOST./",
    "http://sub.localhost/",
    "http://a.b.c.localhost/",
    "http://metadata.google.internal/",
    "http://METADATA.GOOGLE.INTERNAL/",
    "http://metadata.google.internal./",
  ];

  for (const url of blockedHostnames) {
    assert.throws(
      () => validateAndParseUrl(url),
      (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination",
      `Expected ${url} to be rejected as blocked hostname`
    );
  }
});

// =====================================================================
// 3. DNS POLICY & REBINDING PROTECTION TESTS
// =====================================================================

test("Network DNS — Safe Lookup resolves public addresses successfully", async () => {
  const mockResolver: SafeDnsResolver = {
    async resolve(hostname: string) {
      if (hostname === "public.example.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      throw new Error("Unknown host");
    },
  };

  const safeLookup = createSafeLookupFunction(mockResolver);

  await new Promise<void>((resolve, reject) => {
    safeLookup("public.example.com", { all: true }, (err, records) => {
      if (err) return reject(err);
      assert.deepEqual(records, [{ address: "93.184.216.34", family: 4 }]);
      resolve();
    });
  });
});

test("Network DNS — Safe Lookup rejects hostname if resolved IP is private", async () => {
  const mockResolver: SafeDnsResolver = {
    async resolve() {
      return [{ address: "192.168.1.100", family: 4 }];
    },
  };

  const safeLookup = createSafeLookupFunction(mockResolver);

  await new Promise<void>((resolve) => {
    safeLookup("internal.example.com", {}, (err) => {
      assert.ok(err);
      assert.equal((err as any).code, "EBLOCKEDDESTINATION");
      assert.equal(err?.message, "Destination is not allowed by network security policy.");
      // Prove no private IP is leaked in the error message
      assert.equal(err?.message.includes("192.168"), false);
      resolve();
    });
  });
});

test("Network DNS — Safe Lookup All-or-Nothing rule: rejects hostname if ANY address is private", async () => {
  const mockResolver: SafeDnsResolver = {
    async resolve() {
      return [
        { address: "93.184.216.34", family: 4 }, // public
        { address: "10.0.0.1", family: 4 },      // private
      ];
    },
  };

  const safeLookup = createSafeLookupFunction(mockResolver);

  await new Promise<void>((resolve) => {
    safeLookup("mixed.example.com", { all: true }, (err) => {
      assert.ok(err);
      assert.equal((err as any).code, "EBLOCKEDDESTINATION");
      resolve();
    });
  });
});

test("Network DNS — DNS Rebinding Protection at socket connection time", async () => {
  // Simulates a DNS rebinding scenario:
  // Preflight validation lookup may have returned a public IP,
  // but at TCP connection establishment time, DNS rebinds to 127.0.0.1.
  let callCount = 0;
  const rebindingResolver: SafeDnsResolver = {
    async resolve() {
      callCount++;
      if (callCount === 1) {
        // First lookup (preflight)
        return [{ address: "93.184.216.34", family: 4 }];
      }
      // Rebound lookup at socket connect time
      return [{ address: "127.0.0.1", family: 4 }];
    }
  };

  const socketLookup = createSafeLookupFunction(rebindingResolver);

  // Preflight call
  await new Promise<void>((resolve, reject) => {
    socketLookup("rebind.example.com", {}, (err, address) => {
      if (err) return reject(err);
      assert.equal(address, "93.184.216.34");
      resolve();
    });
  });

  // Socket connection lookup: rebinds to 127.0.0.1 -> MUST BE BLOCKED
  await new Promise<void>((resolve) => {
    socketLookup("rebind.example.com", {}, (err) => {
      assert.ok(err);
      assert.equal((err as any).code, "EBLOCKEDDESTINATION");
      assert.equal(err?.message, "Destination is not allowed by network security policy.");
      resolve();
    });
  });
});

test("Network DNS — Safe Lookup respects cancellation signal", async () => {
  const controller = new AbortController();
  controller.abort(); // Cancelled before lookup

  const mockResolver: SafeDnsResolver = {
    async resolve() {
      return [{ address: "93.184.216.34", family: 4 }];
    }
  };

  const safeLookup = createSafeLookupFunction(mockResolver, controller.signal);

  await new Promise<void>((resolve) => {
    safeLookup("example.com", {}, (err) => {
      assert.ok(err);
      assert.equal((err as any).code, "ECANCELED");
      resolve();
    });
  });
});

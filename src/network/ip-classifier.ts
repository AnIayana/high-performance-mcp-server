import net from "node:net";
import type { IpClassificationResult } from "./types.js";

/**
 * Node.js net.BlockList instances initialized with all standard special-use and non-public CIDR subnets.
 */
const ipv4BlockList = new net.BlockList();
const ipv6BlockList = new net.BlockList();

// === IPv4 Blocked CIDR Ranges ===
// 0.0.0.0/8         - "This network" / Unspecified (RFC 1122)
ipv4BlockList.addSubnet("0.0.0.0", 8, "ipv4");
// 10.0.0.0/8        - Private-Use (RFC 1918)
ipv4BlockList.addSubnet("10.0.0.0", 8, "ipv4");
// 100.64.0.0/10     - Carrier-Grade NAT (RFC 6598)
ipv4BlockList.addSubnet("100.64.0.0", 10, "ipv4");
// 127.0.0.0/8       - Loopback (RFC 1122)
ipv4BlockList.addSubnet("127.0.0.0", 8, "ipv4");
// 169.254.0.0/16    - Link-Local / Cloud Metadata 169.254.169.254 (RFC 3927)
ipv4BlockList.addSubnet("169.254.0.0", 16, "ipv4");
// 172.16.0.0/12     - Private-Use (RFC 1918)
ipv4BlockList.addSubnet("172.16.0.0", 12, "ipv4");
// 192.0.0.0/24      - IETF Protocol Assignments (RFC 6890)
ipv4BlockList.addSubnet("192.0.0.0", 24, "ipv4");
// 192.0.2.0/24      - Documentation TEST-NET-1 (RFC 5737)
ipv4BlockList.addSubnet("192.0.2.0", 24, "ipv4");
// 192.88.99.0/24    - 6to4 Relay Anycast (RFC 7526)
ipv4BlockList.addSubnet("192.88.99.0", 24, "ipv4");
// 192.168.0.0/16    - Private-Use (RFC 1918)
ipv4BlockList.addSubnet("192.168.0.0", 16, "ipv4");
// 198.18.0.0/15     - Benchmarking (RFC 2544)
ipv4BlockList.addSubnet("198.18.0.0", 15, "ipv4");
// 198.51.100.0/24   - Documentation TEST-NET-2 (RFC 5737)
ipv4BlockList.addSubnet("198.51.100.0", 24, "ipv4");
// 203.0.113.0/24    - Documentation TEST-NET-3 (RFC 5737)
ipv4BlockList.addSubnet("203.0.113.0", 24, "ipv4");
// 224.0.0.0/4       - Multicast (RFC 5771)
ipv4BlockList.addSubnet("224.0.0.0", 4, "ipv4");
// 240.0.0.0/4       - Reserved for Future Use & Broadcast 255.255.255.255 (RFC 1112)
ipv4BlockList.addSubnet("240.0.0.0", 4, "ipv4");

// === IPv6 Blocked CIDR Ranges ===
// ::/128            - Unspecified (RFC 4291)
ipv6BlockList.addAddress("::", "ipv6");
// ::1/128           - Loopback (RFC 4291)
ipv6BlockList.addAddress("::1", "ipv6");
// 64:ff9b:1::/48    - Local-Use IPv4/IPv6 Translation (RFC 8215)
ipv6BlockList.addSubnet("64:ff9b:1::", 48, "ipv6");
// 100::/64          - Discard-Only (RFC 6666)
ipv6BlockList.addSubnet("100::", 64, "ipv6");
// 2001:20::/28      - ORCHIDv2 (RFC 7343)
ipv6BlockList.addSubnet("2001:20::", 28, "ipv6");
// 2001:db8::/32     - Documentation (RFC 3849)
ipv6BlockList.addSubnet("2001:db8::", 32, "ipv6");
// fc00::/7          - Unique-Local Unicast (RFC 4193)
ipv6BlockList.addSubnet("fc00::", 7, "ipv6");
// fe80::/10         - Link-Local Unicast (RFC 4291)
ipv6BlockList.addSubnet("fe80::", 10, "ipv6");
// ff00::/8          - Multicast (RFC 4291)
ipv6BlockList.addSubnet("ff00::", 8, "ipv6");

/**
 * Normalizes an IPv6 address string by expanding standard abbreviations into 8 16-bit hex words.
 */
function expandIpv6ToWords(ip: string): number[] | null {
  // Strip enclosing brackets if present
  let clean = ip.replace(/^\[|\]$/g, "").trim().toLowerCase();

  // Check if it ends in dotted-decimal IPv4 (e.g. ::ffff:192.168.1.1 or 64:ff9b::192.168.1.1)
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const potentialIpv4 = clean.slice(lastColon + 1);
    if (net.isIP(potentialIpv4) === 4) {
      const parts = potentialIpv4.split(".").map(Number);
      const highWord = (parts[0]! << 8) | parts[1]!;
      const lowWord = (parts[2]! << 8) | parts[3]!;
      clean = clean.slice(0, lastColon) + `:${highWord.toString(16)}:${lowWord.toString(16)}`;
    }
  }

  const halves = clean.split("::");
  if (halves.length > 2) {
    return null; // Invalid IPv6 with multiple '::'
  }

  let words: number[] = [];
  if (halves.length === 1) {
    const split = clean.split(":");
    if (split.length !== 8) return null;
    words = split.map((h) => parseInt(h || "0", 16));
  } else {
    const left = halves[0] ? halves[0].split(":").map((h) => parseInt(h || "0", 16)) : [];
    const right = halves[1] ? halves[1].split(":").map((h) => parseInt(h || "0", 16)) : [];
    const middleCount = 8 - (left.length + right.length);
    if (middleCount < 0) return null;
    const middle = new Array(middleCount).fill(0);
    words = [...left, ...middle, ...right];
  }

  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/**
 * Extracts and classifies embedded IPv4 addresses from transition IPv6 formats:
 * - ::ffff:0:0/96 (IPv4-mapped)
 * - ::/96 (IPv4-compatible)
 * - 64:ff9b::/96 (NAT64 well-known prefix)
 * - 2002::/16 (6to4)
 * - 2001::/32 (Teredo)
 */
function extractEmbeddedIpv4(words: number[]): string | null {
  // 1. ::ffff:a.b.c.d (words: [0, 0, 0, 0, 0, 0xffff, w6, w7])
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const b0 = (words[6]! >> 8) & 0xff;
    const b1 = words[6]! & 0xff;
    const b2 = (words[7]! >> 8) & 0xff;
    const b3 = words[7]! & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  // 2. ::a.b.c.d (IPv4-compatible deprecated, words: [0, 0, 0, 0, 0, 0, w6, w7] with non-zero w6/w7 except ::1)
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0 &&
    (words[6] !== 0 || words[7]! > 1)
  ) {
    const b0 = (words[6]! >> 8) & 0xff;
    const b1 = words[6]! & 0xff;
    const b2 = (words[7]! >> 8) & 0xff;
    const b3 = words[7]! & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  // 3. 64:ff9b::/96 (Well-Known Prefix for IPv4/IPv6 translation RFC 6052)
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    const b0 = (words[6]! >> 8) & 0xff;
    const b1 = words[6]! & 0xff;
    const b2 = (words[7]! >> 8) & 0xff;
    const b3 = words[7]! & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  // 4. 2002::/16 (6to4 RFC 3056, words: [0x2002, ipv4_high, ipv4_low, ...])
  if (words[0] === 0x2002) {
    const b0 = (words[1]! >> 8) & 0xff;
    const b1 = words[1]! & 0xff;
    const b2 = (words[2]! >> 8) & 0xff;
    const b3 = words[2]! & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  // 5. 2001::/32 (Teredo RFC 4380, client IPv4 is XOR-obfuscated in words[6] and words[7])
  if (words[0] === 0x2001 && words[1] === 0x0000) {
    const xorHigh = words[6]! ^ 0xffff;
    const xorLow = words[7]! ^ 0xffff;
    const b0 = (xorHigh >> 8) & 0xff;
    const b1 = xorHigh & 0xff;
    const b2 = (xorLow >> 8) & 0xff;
    const b3 = xorLow & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  return null;
}

/**
 * Classifies an IP address against strict SSRF policy rules.
 * Uses Node.js net.BlockList subnets and transition range decomposition.
 *
 * @param rawIp IPv4 or IPv6 string (e.g. "127.0.0.1", "[::1]", "::ffff:192.168.1.1")
 * @returns IpClassificationResult detailing whether the destination is allowed.
 */
export function classifyIpAddress(
  rawIp: string,
  allowLoopbackForTesting = false
): IpClassificationResult {
  // Normalize string and strip brackets
  let ip = rawIp.trim().replace(/^\[|\]$/g, "");

  // Check IP family using Node built-in
  const family = net.isIP(ip);
  if (family === 0) {
    return {
      allowed: false,
      reason: "Invalid IP address format",
      normalizedIp: rawIp,
      family: 4,
    };
  }

  if (allowLoopbackForTesting && (ip === "127.0.0.1" || ip === "::1")) {
    return {
      allowed: true,
      normalizedIp: ip,
      family: family as 4 | 6,
    };
  }

  if (family === 4) {
    if (ipv4BlockList.check(ip, "ipv4")) {
      return {
        allowed: false,
        reason: "IPv4 address falls within a reserved/private/special-use range",
        normalizedIp: ip,
        family: 4,
      };
    }
    return {
      allowed: true,
      normalizedIp: ip,
      family: 4,
    };
  }

  // family === 6
  // Check IPv6 BlockList first
  if (ipv6BlockList.check(ip, "ipv6")) {
    return {
      allowed: false,
      reason: "IPv6 address falls within a reserved/private/special-use range",
      normalizedIp: ip,
      family: 6,
    };
  }

  // Check IPv6 transition & embedded IPv4 ranges
  const words = expandIpv6ToWords(ip);
  if (!words) {
    return {
      allowed: false,
      reason: "Failed to parse IPv6 words",
      normalizedIp: ip,
      family: 6,
    };
  }

  const embeddedIpv4 = extractEmbeddedIpv4(words);
  if (embeddedIpv4) {
    const ipv4Classification = classifyIpAddress(embeddedIpv4);
    if (!ipv4Classification.allowed) {
      return {
        allowed: false,
        reason: `IPv6 address encapsulates a blocked IPv4 destination: ${ipv4Classification.reason}`,
        normalizedIp: ip,
        family: 6,
      };
    }
  }

  return {
    allowed: true,
    normalizedIp: ip,
    family: 6,
  };
}

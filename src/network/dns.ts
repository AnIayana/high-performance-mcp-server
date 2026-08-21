import dns from "node:dns";
import type { DnsRecord, SafeDnsResolver } from "./types.js";
import { classifyIpAddress } from "./ip-classifier.js";
import { NetworkSecurityError } from "./types.js";

/**
 * Default production DNS resolver using Node.js dns.promises.lookup with order: "verbatim".
 */
export class DefaultDnsResolver implements SafeDnsResolver {
  async resolve(hostname: string, signal?: AbortSignal): Promise<readonly DnsRecord[]> {
    if (signal?.aborted) {
      throw new Error("DNS lookup cancelled before start");
    }

    try {
      const records = await dns.promises.lookup(hostname, {
        all: true,
        order: "verbatim",
      });

      if (signal?.aborted) {
        throw new Error("DNS lookup cancelled after completion");
      }

      return records.map((r) => ({
        address: r.address,
        family: r.family as 4 | 6,
      }));
    } catch (err: any) {
      if (signal?.aborted) {
        throw new Error("DNS lookup cancelled during operation");
      }
      throw err;
    }
  }
}

export type NodeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | readonly DnsRecord[],
  family?: number
) => void;

/**
 * Creates a Node.js-compatible custom lookup function for http.request/https.request socket establishment.
 *
 * Key Security Guarantees:
 * 1. Resolves all addresses for the target hostname.
 * 2. Conservative All-or-Nothing Rule: If ANY resolved IP is blocked by our IP policy, the entire hostname is rejected.
 * 3. Socket connects strictly to the policy-validated IP address, eliminating TOCTOU DNS rebinding.
 * 4. Cancellation Guarantee: If signal is aborted, socket establishment is immediately stopped.
 */
export function createSafeLookupFunction(
  resolver: SafeDnsResolver,
  signal?: AbortSignal,
  allowLoopbackForTesting = false
): (hostname: string, options: any, callback: NodeLookupCallback) => void {
  return (hostname: string, optionsOrCb: any, maybeCb?: NodeLookupCallback) => {
    const callback: NodeLookupCallback = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb!;
    const options = typeof optionsOrCb === "object" && optionsOrCb !== null ? optionsOrCb : {};

    if (signal?.aborted) {
      const cancelErr = new Error("Operation cancelled before DNS lookup") as NodeJS.ErrnoException;
      cancelErr.code = "ECANCELED";
      return callback(cancelErr);
    }

    resolver
      .resolve(hostname, signal)
      .then((records) => {
        if (signal?.aborted) {
          const cancelErr = new Error("Operation cancelled during DNS lookup") as NodeJS.ErrnoException;
          cancelErr.code = "ECANCELED";
          return callback(cancelErr);
        }

        if (!records || records.length === 0) {
          const notFoundErr = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
          notFoundErr.code = "ENOTFOUND";
          notFoundErr.syscall = "getaddrinfo";
          (notFoundErr as any).hostname = hostname;
          return callback(notFoundErr);
        }

        // Validate EVERY returned address against the IP security policy
        for (const record of records) {
          const classification = classifyIpAddress(record.address, allowLoopbackForTesting);
          if (!classification.allowed) {
            const blockedErr = new NetworkSecurityError(
              "blocked_destination",
              "Destination is not allowed by network security policy.",
              `Resolved address ${record.address} is blocked: ${classification.reason}`
            ) as any;
            blockedErr.code = "EBLOCKEDDESTINATION";
            return callback(blockedErr);
          }
        }

        // If specific IP family requested in options (e.g. { family: 4 }), filter appropriately
        let filtered = records;
        if (options.family === 4) {
          filtered = records.filter((r) => r.family === 4);
        } else if (options.family === 6) {
          filtered = records.filter((r) => r.family === 6);
        }

        if (filtered.length === 0) {
          filtered = records; // Fallback to all valid records if specific family absent
        }

        if (options.all) {
          return callback(null, filtered);
        }

        const chosen = filtered[0]!;
        return callback(null, chosen.address, chosen.family);
      })
      .catch((err) => {
        if (signal?.aborted) {
          const cancelErr = new Error("Operation cancelled during DNS resolution") as NodeJS.ErrnoException;
          cancelErr.code = "ECANCELED";
          return callback(cancelErr);
        }
        return callback(err);
      });
  };
}

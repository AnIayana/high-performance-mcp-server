import process from "node:process";
import { CLI_BIN_NAME, PACKAGE_VERSION } from "../generated/build-meta.js";
import {
  createNetworkCachePolicy,
  DEFAULT_NETWORK_CACHE_MAX_ENTRIES,
  DEFAULT_NETWORK_CACHE_MAX_SIZE_BYTES,
  DEFAULT_NETWORK_CACHE_POLICY,
  DEFAULT_NETWORK_CACHE_RETENTION_TTL_MS,
  MAX_NETWORK_CACHE_MAX_ENTRIES,
  MAX_NETWORK_CACHE_MAX_SIZE_BYTES,
  MAX_NETWORK_CACHE_RETENTION_TTL_MS,
  MIN_NETWORK_CACHE_MAX_ENTRIES,
  MIN_NETWORK_CACHE_MAX_SIZE_BYTES,
  MIN_NETWORK_CACHE_RETENTION_TTL_MS,
  type NetworkCachePolicy,
} from "../network/conditional-cache.js";
import {
  createNetworkOperatorPolicy,
  DEFAULT_NETWORK_OPERATOR_POLICY,
  type NetworkOperatorPolicy,
  normalizeHostPattern,
} from "../network/operator-policy.js";
import {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_MAX_BYTES,
  MAX_FETCH_TIMEOUT_MS,
} from "../network/policy.js";
import {
  DEFAULT_TOOL_PROFILE,
  isValidToolProfile,
  type ToolProfile,
  VALID_TOOL_PROFILES,
} from "./tool-profile.js";

export type CliAction = "start" | "help" | "version" | "list-tools";

export interface ParsedCliConfig {
  action: CliAction;
  transport: "stdio" | "http";
  port: number;
  profile: ToolProfile;
  roots: string[];
  networkPolicy: NetworkOperatorPolicy;
  networkCachePolicy: NetworkCachePolicy;
  error?: string;
}

/**
 * Returns the package version from generated build metadata.
 */
export function getPackageVersion(): string {
  return PACKAGE_VERSION;
}

/**
 * Strictly parses a TCP port string.
 * Requires exclusively decimal digits and range [1, 65535].
 * Rejects scientific notation, floats, negative numbers, and trailing characters.
 */
export function parseStrictPort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Must consist solely of decimal digits
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }
  return parsed;
}

/**
 * Strictly parses an integer within [min, max].
 */
export function parseStrictInteger(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

/**
 * Returns human-readable help text with OS-agnostic command examples.
 */
export function getHelpText(): string {
  return [
    "High-Performance Model Context Protocol (MCP) Server",
    "",
    "Usage:",
    `  ${CLI_BIN_NAME} [options]`,
    "",
    "Options:",
    "  --transport=<stdio|http>       Transport protocol to run (default: stdio)",
    "  --port=<number>                HTTP server port (default: 3000, only for http transport)",
    "  --profile=<profile>            Security tool profile (default: safe)",
    "  --root=<path>                  Allowlisted read-only workspace root (repeatable, max 16)",
    "  --network-allow-host=<pattern> Allowlisted public hostname or *.domain pattern (repeatable, operator restriction)",
    "  --network-deny-host=<pattern>  Denylisted hostname or *.domain pattern (repeatable, operator restriction)",
    "  --network-https-only           Enforce HTTPS-only mode for all network requests (operator restriction)",
    "  --network-max-response-bytes=<n> Operator hard cap for response size in bytes (1-5242880, default: 5242880)",
    "  --network-max-timeout-ms=<n>   Operator hard cap for request timeout in ms (1000-30000, default: 30000)",
    "  --network-cache                Enable conditional in-memory response cache for fetch_url (operator restriction)",
    "  --network-cache-max-size-bytes=<n> Logical max cache payload size in bytes (1024-67108864, default: 16777216)",
    "  --network-cache-max-entries=<n> Max cache entry count (1-512, default: 128)",
    "  --network-cache-ttl-ms=<n>     Max cache retention TTL in ms (1000-3600000, default: 300000)",
    "  --list-tools                   Display available tools for the active profile and exit",
    "  --help, -h                     Show this help message and exit",
    "  --version, -v                  Show version and exit",
    "",
    "Tool Profiles:",
    "  safe          Lightweight utilities (echo, ping). Safe default for public exposure.",
    "  workspace     Read-only filesystem tools strictly limited to configured --root directories.",
    "  network       SSRF-hardened read-only web fetching (fetch_url) for public web resources.",
    "  diagnostics   Observability tools (system stats, metrics, cache stats, pool stats).",
    "  benchmark     Compute workloads (main/worker prime calculations, cached prime count).",
    "  admin         Diagnostics plus operational mutations (reset cache, reset metrics).",
    "  all           Enables all registered tool categories (safe, workspace, network, diagnostics, benchmark, admin).",
    "",
    "Environment Variables:",
    "  MCP_PROFILE                    Default tool profile override (safe|workspace|network|diagnostics|benchmark|admin|all)",
    "  PORT                           Default HTTP port override (e.g. 3000)",
    "  MCP_ROOTS_JSON                 JSON array of read-only workspace root paths (e.g. [\"/path/to/project\"])",
    "  MCP_NETWORK_ALLOW_HOSTS_JSON   JSON array of allowed public hostname patterns (e.g. [\"example.com\",\"*.githubusercontent.com\"])",
    "  MCP_NETWORK_DENY_HOSTS_JSON    JSON array of denied hostname patterns (e.g. [\"ads.example.com\"])",
    "  MCP_NETWORK_HTTPS_ONLY         Enforce HTTPS-only mode (true/1/false/0)",
    "  MCP_NETWORK_MAX_RESPONSE_BYTES Operator response byte cap override (1-5242880)",
    "  MCP_NETWORK_MAX_TIMEOUT_MS     Operator timeout cap in ms override (1000-30000)",
    "  MCP_NETWORK_CACHE_ENABLED      Enable conditional response cache (true/1/false/0)",
    "  MCP_NETWORK_CACHE_MAX_SIZE_BYTES Logical max cache size in bytes override (1024-67108864)",
    "  MCP_NETWORK_CACHE_MAX_ENTRIES  Max cache entries override (1-512)",
    "  MCP_NETWORK_CACHE_TTL_MS       Max cache retention TTL in ms override (1000-3600000)",
    "  MCP_WORKER_COUNT               Worker thread count override (1-16)",
    "  MCP_CACHE_MAX_ENTRIES          LRU cache capacity override (1-10000)",
    "  MCP_CACHE_TTL_MS               LRU cache TTL in ms (1000-86400000)",
    "",
    "Examples:",
    `  ${CLI_BIN_NAME}`,
    `  ${CLI_BIN_NAME} --profile=workspace --root=./project`,
    `  ${CLI_BIN_NAME} --profile=network --network-allow-host=example.com --network-allow-host="*.githubusercontent.com" --network-https-only`,
    `  ${CLI_BIN_NAME} --profile=network --network-max-response-bytes=262144 --network-max-timeout-ms=5000`,
    `  ${CLI_BIN_NAME} --profile=network --network-cache --network-cache-max-entries=256`,
    `  ${CLI_BIN_NAME} --transport=http --port=3000`,
    `  ${CLI_BIN_NAME} --profile=workspace --list-tools`,
    "",
  ].join("\n");
}

/**
 * Parses and validates a JSON array of strings from an environment variable.
 */
function parseJsonStringArray(envName: string, rawJson: string): string[] {
  const trimmed = rawJson.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `Invalid ${envName} environment variable: Must be valid JSON array syntax.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Invalid ${envName} environment variable: Must be a valid JSON array of non-empty strings.`
    );
  }
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(
        `Invalid ${envName} environment variable: Array items must be non-empty strings.`
      );
    }
    result.push(item.trim());
  }
  return result;
}

/**
 * Pure and testable CLI argument and environment parser.
 */
export function parseCliArgs(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): ParsedCliConfig {
  let transport: "stdio" | "http" = "stdio";
  let port = 3000;
  let profileArg: string | undefined;
  let action: CliAction = "start";
  const cliRoots: string[] = [];
  let envRoots: string[] | undefined;

  // Network operator policy accumulators
  const cliAllowHosts: string[] = [];
  const cliDenyHosts: string[] = [];
  let cliHttpsOnly: boolean | undefined;
  let cliMaxResponseBytes: number | undefined;
  let cliMaxTimeoutMs: number | undefined;

  let envAllowHosts: string[] | undefined;
  let envDenyHosts: string[] | undefined;
  let envHttpsOnly: boolean | undefined;
  let envMaxResponseBytes: number | undefined;
  let envMaxTimeoutMs: number | undefined;

  // Network conditional cache accumulators
  let cliCacheEnabled: boolean | undefined;
  let cliCacheMaxSizeBytes: number | undefined;
  let cliCacheMaxEntries: number | undefined;
  let cliCacheTtlMs: number | undefined;

  let envCacheEnabled: boolean | undefined;
  let envCacheMaxSizeBytes: number | undefined;
  let envCacheMaxEntries: number | undefined;
  let envCacheTtlMs: number | undefined;

  const defaultPolicy = DEFAULT_NETWORK_OPERATOR_POLICY;
  const defaultCachePolicy = DEFAULT_NETWORK_CACHE_POLICY;

  // 1. Check for immediate explicit help or version flags
  if (args.includes("--help") || args.includes("-h")) {
    return {
      action: "help",
      transport,
      port,
      profile: DEFAULT_TOOL_PROFILE,
      roots: [],
      networkPolicy: defaultPolicy,
      networkCachePolicy: defaultCachePolicy,
    };
  }
  if (args.includes("--version") || args.includes("-v")) {
    return {
      action: "version",
      transport,
      port,
      profile: DEFAULT_TOOL_PROFILE,
      roots: [],
      networkPolicy: defaultPolicy,
      networkCachePolicy: defaultCachePolicy,
    };
  }

  // 2. Parse environment variables first
  if (env.PORT !== undefined && env.PORT.trim().length > 0) {
    const parsedPort = parseStrictPort(env.PORT);
    if (parsedPort === null) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid PORT environment variable: "${env.PORT}". Must be an integer between 1 and 65535.`,
      };
    }
    port = parsedPort;
  }

  const envProfile = env.MCP_PROFILE?.trim().toLowerCase();
  if (envProfile) {
    if (isValidToolProfile(envProfile)) {
      profileArg = envProfile;
    } else {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_PROFILE environment variable: "${envProfile}". Valid profiles: ${VALID_TOOL_PROFILES.join(", ")}`,
      };
    }
  }

  if (env.MCP_ROOTS_JSON !== undefined) {
    try {
      envRoots = parseJsonStringArray("MCP_ROOTS_JSON", env.MCP_ROOTS_JSON);
    } catch (err: any) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: err.message,
      };
    }
  }

  // Network environment variables
  if (env.MCP_NETWORK_ALLOW_HOSTS_JSON !== undefined) {
    try {
      const rawHosts = parseJsonStringArray(
        "MCP_NETWORK_ALLOW_HOSTS_JSON",
        env.MCP_NETWORK_ALLOW_HOSTS_JSON
      );
      envAllowHosts = rawHosts.map(normalizeHostPattern);
    } catch (err: any) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: err.message,
      };
    }
  }

  if (env.MCP_NETWORK_DENY_HOSTS_JSON !== undefined) {
    try {
      const rawHosts = parseJsonStringArray(
        "MCP_NETWORK_DENY_HOSTS_JSON",
        env.MCP_NETWORK_DENY_HOSTS_JSON
      );
      envDenyHosts = rawHosts.map(normalizeHostPattern);
    } catch (err: any) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: err.message,
      };
    }
  }

  if (env.MCP_NETWORK_HTTPS_ONLY !== undefined && env.MCP_NETWORK_HTTPS_ONLY.trim().length > 0) {
    const val = env.MCP_NETWORK_HTTPS_ONLY.trim().toLowerCase();
    if (val === "true" || val === "1") {
      envHttpsOnly = true;
    } else if (val === "false" || val === "0") {
      envHttpsOnly = false;
    } else {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_HTTPS_ONLY environment variable: "${env.MCP_NETWORK_HTTPS_ONLY}". Must be true or false.`,
      };
    }
  }

  if (
    env.MCP_NETWORK_MAX_RESPONSE_BYTES !== undefined &&
    env.MCP_NETWORK_MAX_RESPONSE_BYTES.trim().length > 0
  ) {
    const parsed = parseStrictInteger(env.MCP_NETWORK_MAX_RESPONSE_BYTES, 1, MAX_FETCH_MAX_BYTES);
    if (parsed === null) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_MAX_RESPONSE_BYTES environment variable: "${env.MCP_NETWORK_MAX_RESPONSE_BYTES}". Must be an integer between 1 and ${MAX_FETCH_MAX_BYTES}.`,
      };
    }
    envMaxResponseBytes = parsed;
  }

  if (
    env.MCP_NETWORK_MAX_TIMEOUT_MS !== undefined &&
    env.MCP_NETWORK_MAX_TIMEOUT_MS.trim().length > 0
  ) {
    const parsed = parseStrictInteger(env.MCP_NETWORK_MAX_TIMEOUT_MS, 1000, MAX_FETCH_TIMEOUT_MS);
    if (parsed === null) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_MAX_TIMEOUT_MS environment variable: "${env.MCP_NETWORK_MAX_TIMEOUT_MS}". Must be an integer between 1000 and ${MAX_FETCH_TIMEOUT_MS}.`,
      };
    }
    envMaxTimeoutMs = parsed;
  }

  // Network conditional cache environment variables
  if (
    env.MCP_NETWORK_CACHE_ENABLED !== undefined &&
    env.MCP_NETWORK_CACHE_ENABLED.trim().length > 0
  ) {
    const val = env.MCP_NETWORK_CACHE_ENABLED.trim().toLowerCase();
    if (val === "true" || val === "1") {
      envCacheEnabled = true;
    } else if (val === "false" || val === "0") {
      envCacheEnabled = false;
    } else {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_CACHE_ENABLED environment variable: "${env.MCP_NETWORK_CACHE_ENABLED}". Must be true or false.`,
      };
    }
  }

  if (
    env.MCP_NETWORK_CACHE_MAX_SIZE_BYTES !== undefined &&
    env.MCP_NETWORK_CACHE_MAX_SIZE_BYTES.trim().length > 0
  ) {
    const parsed = parseStrictInteger(
      env.MCP_NETWORK_CACHE_MAX_SIZE_BYTES,
      MIN_NETWORK_CACHE_MAX_SIZE_BYTES,
      MAX_NETWORK_CACHE_MAX_SIZE_BYTES
    );
    if (parsed === null) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_CACHE_MAX_SIZE_BYTES environment variable: "${env.MCP_NETWORK_CACHE_MAX_SIZE_BYTES}". Must be an integer between ${MIN_NETWORK_CACHE_MAX_SIZE_BYTES} and ${MAX_NETWORK_CACHE_MAX_SIZE_BYTES}.`,
      };
    }
    envCacheMaxSizeBytes = parsed;
  }

  if (
    env.MCP_NETWORK_CACHE_MAX_ENTRIES !== undefined &&
    env.MCP_NETWORK_CACHE_MAX_ENTRIES.trim().length > 0
  ) {
    const parsed = parseStrictInteger(
      env.MCP_NETWORK_CACHE_MAX_ENTRIES,
      MIN_NETWORK_CACHE_MAX_ENTRIES,
      MAX_NETWORK_CACHE_MAX_ENTRIES
    );
    if (parsed === null) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_CACHE_MAX_ENTRIES environment variable: "${env.MCP_NETWORK_CACHE_MAX_ENTRIES}". Must be an integer between ${MIN_NETWORK_CACHE_MAX_ENTRIES} and ${MAX_NETWORK_CACHE_MAX_ENTRIES}.`,
      };
    }
    envCacheMaxEntries = parsed;
  }

  if (
    env.MCP_NETWORK_CACHE_TTL_MS !== undefined &&
    env.MCP_NETWORK_CACHE_TTL_MS.trim().length > 0
  ) {
    const parsed = parseStrictInteger(
      env.MCP_NETWORK_CACHE_TTL_MS,
      MIN_NETWORK_CACHE_RETENTION_TTL_MS,
      MAX_NETWORK_CACHE_RETENTION_TTL_MS
    );
    if (parsed === null) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Invalid MCP_NETWORK_CACHE_TTL_MS environment variable: "${env.MCP_NETWORK_CACHE_TTL_MS}". Must be an integer between ${MIN_NETWORK_CACHE_RETENTION_TTL_MS} and ${MAX_NETWORK_CACHE_RETENTION_TTL_MS}.`,
      };
    }
    envCacheTtlMs = parsed;
  }

  // 3. Parse and validate CLI arguments
  let seenTransport = false;
  let seenPort = false;
  let seenProfile = false;
  let seenListTools = false;
  let seenHttpsOnly = false;
  let seenMaxResponseBytes = false;
  let seenMaxTimeoutMs = false;
  let seenCache = false;
  let seenCacheMaxSize = false;
  let seenCacheMaxEntries = false;
  let seenCacheTtl = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // Disallow positional arguments
    if (!arg.startsWith("-")) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Unexpected positional argument: "${arg}". Use --help for usage syntax.`,
      };
    }

    if (arg === "--list-tools") {
      if (seenListTools) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--list-tools". This option may only be specified once.`,
        };
      }
      seenListTools = true;
      action = "list-tools";
      continue;
    }

    if (arg === "--network-https-only") {
      if (seenHttpsOnly) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-https-only". This option may only be specified once.`,
        };
      }
      seenHttpsOnly = true;
      cliHttpsOnly = true;
      continue;
    }

    if (arg === "--network-cache") {
      if (seenCache) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-cache". This option may only be specified once.`,
        };
      }
      seenCache = true;
      cliCacheEnabled = true;
      continue;
    }

    // Handle options that can have values either via = or space
    let optName = arg;
    let optValue: string | undefined;

    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      optName = arg.slice(0, eqIdx);
      optValue = arg.slice(eqIdx + 1);
    }

    if (optName === "--transport") {
      if (seenTransport) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--transport". This option may only be specified once.`,
        };
      }
      seenTransport = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--transport".`,
          };
        }
        optValue = args[++i]!;
      }
      const value = optValue.trim().toLowerCase();
      if (value === "stdio" || value === "http") {
        transport = value;
      } else {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid transport option: "${value}". Supported transports: stdio, http`,
        };
      }
    } else if (optName === "--port") {
      if (seenPort) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--port". This option may only be specified once.`,
        };
      }
      seenPort = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--port".`,
          };
        }
        optValue = args[++i]!;
      }
      const parsedPort = parseStrictPort(optValue);
      if (parsedPort !== null) {
        port = parsedPort;
      } else {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid port option: "${optValue}". Must be a valid TCP port (1-65535).`,
        };
      }
    } else if (optName === "--profile") {
      if (seenProfile) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--profile". This option may only be specified once.`,
        };
      }
      seenProfile = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--profile".`,
          };
        }
        optValue = args[++i]!;
      }
      const value = optValue.trim().toLowerCase();
      if (isValidToolProfile(value)) {
        profileArg = value;
      } else {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid tool profile: "${value}". Valid profiles: ${VALID_TOOL_PROFILES.join(", ")}`,
        };
      }
    } else if (optName === "--root") {
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--root".`,
          };
        }
        optValue = args[++i]!;
      }
      const rootPath = optValue.trim();
      if (rootPath.length === 0) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --root option: Root path cannot be empty.`,
        };
      }
      cliRoots.push(rootPath);
    } else if (optName === "--network-allow-host") {
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-allow-host".`,
          };
        }
        optValue = args[++i]!;
      }
      try {
        const normalized = normalizeHostPattern(optValue);
        cliAllowHosts.push(normalized);
      } catch (err: any) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-allow-host option: ${err.message}`,
        };
      }
    } else if (optName === "--network-deny-host") {
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-deny-host".`,
          };
        }
        optValue = args[++i]!;
      }
      try {
        const normalized = normalizeHostPattern(optValue);
        cliDenyHosts.push(normalized);
      } catch (err: any) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-deny-host option: ${err.message}`,
        };
      }
    } else if (optName === "--network-max-response-bytes") {
      if (seenMaxResponseBytes) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-max-response-bytes". This option may only be specified once.`,
        };
      }
      seenMaxResponseBytes = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-max-response-bytes".`,
          };
        }
        optValue = args[++i]!;
      }
      const parsed = parseStrictInteger(optValue, 1, MAX_FETCH_MAX_BYTES);
      if (parsed === null) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-max-response-bytes option: "${optValue}". Must be an integer between 1 and ${MAX_FETCH_MAX_BYTES}.`,
        };
      }
      cliMaxResponseBytes = parsed;
    } else if (optName === "--network-max-timeout-ms") {
      if (seenMaxTimeoutMs) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-max-timeout-ms". This option may only be specified once.`,
        };
      }
      seenMaxTimeoutMs = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-max-timeout-ms".`,
          };
        }
        optValue = args[++i]!;
      }
      const parsed = parseStrictInteger(optValue, 1000, MAX_FETCH_TIMEOUT_MS);
      if (parsed === null) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-max-timeout-ms option: "${optValue}". Must be an integer between 1000 and ${MAX_FETCH_TIMEOUT_MS}.`,
        };
      }
      cliMaxTimeoutMs = parsed;
    } else if (optName === "--network-cache-max-size-bytes") {
      if (seenCacheMaxSize) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-cache-max-size-bytes". This option may only be specified once.`,
        };
      }
      seenCacheMaxSize = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-cache-max-size-bytes".`,
          };
        }
        optValue = args[++i]!;
      }
      const parsed = parseStrictInteger(
        optValue,
        MIN_NETWORK_CACHE_MAX_SIZE_BYTES,
        MAX_NETWORK_CACHE_MAX_SIZE_BYTES
      );
      if (parsed === null) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-cache-max-size-bytes option: "${optValue}". Must be an integer between ${MIN_NETWORK_CACHE_MAX_SIZE_BYTES} and ${MAX_NETWORK_CACHE_MAX_SIZE_BYTES}.`,
        };
      }
      cliCacheMaxSizeBytes = parsed;
    } else if (optName === "--network-cache-max-entries") {
      if (seenCacheMaxEntries) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-cache-max-entries". This option may only be specified once.`,
        };
      }
      seenCacheMaxEntries = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-cache-max-entries".`,
          };
        }
        optValue = args[++i]!;
      }
      const parsed = parseStrictInteger(
        optValue,
        MIN_NETWORK_CACHE_MAX_ENTRIES,
        MAX_NETWORK_CACHE_MAX_ENTRIES
      );
      if (parsed === null) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-cache-max-entries option: "${optValue}". Must be an integer between ${MIN_NETWORK_CACHE_MAX_ENTRIES} and ${MAX_NETWORK_CACHE_MAX_ENTRIES}.`,
        };
      }
      cliCacheMaxEntries = parsed;
    } else if (optName === "--network-cache-ttl-ms") {
      if (seenCacheTtl) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Duplicate option specified: "--network-cache-ttl-ms". This option may only be specified once.`,
        };
      }
      seenCacheTtl = true;
      if (optValue === undefined) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
          return {
            action,
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            networkPolicy: defaultPolicy,
            networkCachePolicy: defaultCachePolicy,
            error: `Missing value for option "--network-cache-ttl-ms".`,
          };
        }
        optValue = args[++i]!;
      }
      const parsed = parseStrictInteger(
        optValue,
        MIN_NETWORK_CACHE_RETENTION_TTL_MS,
        MAX_NETWORK_CACHE_RETENTION_TTL_MS
      );
      if (parsed === null) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          networkPolicy: defaultPolicy,
          networkCachePolicy: defaultCachePolicy,
          error: `Invalid --network-cache-ttl-ms option: "${optValue}". Must be an integer between ${MIN_NETWORK_CACHE_RETENTION_TTL_MS} and ${MAX_NETWORK_CACHE_RETENTION_TTL_MS}.`,
        };
      }
      cliCacheTtlMs = parsed;
    } else {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        networkPolicy: defaultPolicy,
        networkCachePolicy: defaultCachePolicy,
        error: `Unknown CLI option: "${arg}". Use --help to view available options.`,
      };
    }
  }

  const profile: ToolProfile =
    profileArg && isValidToolProfile(profileArg) ? profileArg : DEFAULT_TOOL_PROFILE;
  const roots = cliRoots.length > 0 ? cliRoots : (envRoots ?? []);

  // Precedence resolution for network policy:
  // Explicit CLI list overrides environment list completely (no silent merge)
  const effectiveAllowHosts =
    cliAllowHosts.length > 0 ? cliAllowHosts : (envAllowHosts ?? []);
  const effectiveDenyHosts =
    cliDenyHosts.length > 0 ? cliDenyHosts : (envDenyHosts ?? []);
  const effectiveHttpsOnly = cliHttpsOnly ?? envHttpsOnly ?? false;
  const effectiveMaxResponseBytes =
    cliMaxResponseBytes ?? envMaxResponseBytes ?? MAX_FETCH_MAX_BYTES;
  const effectiveMaxTimeoutMs =
    cliMaxTimeoutMs ?? envMaxTimeoutMs ?? MAX_FETCH_TIMEOUT_MS;

  const networkPolicy = createNetworkOperatorPolicy({
    allowHosts: effectiveAllowHosts,
    denyHosts: effectiveDenyHosts,
    httpsOnly: effectiveHttpsOnly,
    maxResponseBytes: effectiveMaxResponseBytes,
    maxTimeoutMs: effectiveMaxTimeoutMs,
  });

  // Precedence resolution for network conditional cache policy:
  const effectiveCacheEnabled = cliCacheEnabled ?? envCacheEnabled ?? false;
  const effectiveCacheMaxSizeBytes =
    cliCacheMaxSizeBytes ?? envCacheMaxSizeBytes ?? DEFAULT_NETWORK_CACHE_MAX_SIZE_BYTES;
  const effectiveCacheMaxEntries =
    cliCacheMaxEntries ?? envCacheMaxEntries ?? DEFAULT_NETWORK_CACHE_MAX_ENTRIES;
  const effectiveCacheTtlMs =
    cliCacheTtlMs ?? envCacheTtlMs ?? DEFAULT_NETWORK_CACHE_RETENTION_TTL_MS;

  const networkCachePolicy = createNetworkCachePolicy({
    enabled: effectiveCacheEnabled,
    maxSizeBytes: effectiveCacheMaxSizeBytes,
    maxEntries: effectiveCacheMaxEntries,
    retentionTtlMs: effectiveCacheTtlMs,
  });

  // Validation: Workspace profile requires at least one allowed root when starting server
  if (action === "start" && (profile === "workspace" || profile === "all") && roots.length === 0) {
    return {
      action,
      transport,
      port,
      profile,
      roots,
      networkPolicy,
      networkCachePolicy,
      error: "Workspace profile requires at least one allowed root. Use --root=<path> or MCP_ROOTS_JSON.",
    };
  }

  return {
    action,
    transport,
    port,
    profile,
    roots,
    networkPolicy,
    networkCachePolicy,
  };
}


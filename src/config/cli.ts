import process from "node:process";
import { CLI_BIN_NAME, PACKAGE_VERSION } from "../generated/build-meta.js";
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
    "  --transport=<stdio|http>   Transport protocol to run (default: stdio)",
    "  --port=<number>            HTTP server port (default: 3000, only for http transport)",
    "  --profile=<profile>        Security tool profile (default: safe)",
    "  --root=<path>              Allowlisted read-only workspace root (repeatable, max 16)",
    "  --list-tools               Display available tools for the active profile and exit",
    "  --help, -h                 Show this help message and exit",
    "  --version, -v              Show version and exit",
    "",
    "Tool Profiles:",
    "  safe          Lightweight utilities (echo, ping). Safe default for public exposure.",
    "  workspace     Read-only filesystem tools strictly limited to configured --root directories.",
    "  diagnostics   Observability tools (system stats, metrics, cache stats, pool stats).",
    "  benchmark     Compute workloads (main/worker prime calculations, cached prime count).",
    "  admin         Diagnostics plus operational mutations (reset cache, reset metrics).",
    "  all           Enables all registered tool categories (safe, workspace, diagnostics, benchmark, admin).",
    "",
    "Environment Variables:",
    "  MCP_PROFILE                Default tool profile override (safe|workspace|diagnostics|benchmark|admin|all)",
    "  PORT                       Default HTTP port override (e.g. 3000)",
    "  MCP_ROOTS_JSON             JSON array of read-only workspace root paths (e.g. [\"/path/to/project\"])",
    "  MCP_WORKER_COUNT           Worker thread count override (1-16)",
    "  MCP_CACHE_MAX_ENTRIES      LRU cache capacity override (1-10000)",
    "  MCP_CACHE_TTL_MS           LRU cache TTL in ms (1000-86400000)",
    "",
    "Examples:",
    `  ${CLI_BIN_NAME}`,
    `  ${CLI_BIN_NAME} --profile=workspace --root=./project`,
    `  ${CLI_BIN_NAME} --profile=workspace --root=./project-a --root=./project-b`,
    `  ${CLI_BIN_NAME} --profile=diagnostics`,
    `  ${CLI_BIN_NAME} --transport=http --port=3000`,
    `  ${CLI_BIN_NAME} --profile=workspace --list-tools`,
    "",
  ].join("\n");
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

  // 1. Check for immediate explicit help or version flags
  if (args.includes("--help") || args.includes("-h")) {
    return { action: "help", transport, port, profile: DEFAULT_TOOL_PROFILE, roots: [] };
  }
  if (args.includes("--version") || args.includes("-v")) {
    return { action: "version", transport, port, profile: DEFAULT_TOOL_PROFILE, roots: [] };
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
        error: `Invalid MCP_PROFILE environment variable: "${envProfile}". Valid profiles: ${VALID_TOOL_PROFILES.join(", ")}`,
      };
    }
  }

  if (env.MCP_ROOTS_JSON) {
    const rawEnvRoots = env.MCP_ROOTS_JSON.trim();
    if (rawEnvRoots.length > 0) {
      try {
        const parsed = JSON.parse(rawEnvRoots);
        if (!Array.isArray(parsed)) {
          return {
            action: "start",
            transport,
            port,
            profile: DEFAULT_TOOL_PROFILE,
            roots: [],
            error: `Invalid MCP_ROOTS_JSON environment variable: Must be a valid JSON array of non-empty string paths.`,
          };
        }
        for (const item of parsed) {
          if (typeof item !== "string" || item.trim().length === 0) {
            return {
              action: "start",
              transport,
              port,
              profile: DEFAULT_TOOL_PROFILE,
              roots: [],
              error: `Invalid MCP_ROOTS_JSON environment variable: Array items must be non-empty strings.`,
            };
          }
        }
        envRoots = parsed.map((item: string) => item.trim());
      } catch {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Invalid MCP_ROOTS_JSON environment variable: Must be valid JSON array syntax.`,
        };
      }
    }
  }

  // 3. Parse and validate CLI arguments
  let seenTransport = false;
  let seenPort = false;
  let seenProfile = false;
  let seenListTools = false;

  for (const arg of args) {
    // Disallow positional arguments
    if (!arg.startsWith("-")) {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
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
          error: `Duplicate option specified: "--list-tools". This option may only be specified once.`,
        };
      }
      seenListTools = true;
      action = "list-tools";
      continue;
    }

    if (arg.startsWith("--transport=")) {
      if (seenTransport) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Duplicate option specified: "--transport". This option may only be specified once.`,
        };
      }
      seenTransport = true;
      const value = arg.slice("--transport=".length).trim().toLowerCase();
      if (value === "stdio" || value === "http") {
        transport = value;
      } else {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Invalid transport option: "${value}". Supported transports: stdio, http`,
        };
      }
    } else if (arg.startsWith("--port=")) {
      if (seenPort) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Duplicate option specified: "--port". This option may only be specified once.`,
        };
      }
      seenPort = true;
      const rawValue = arg.slice("--port=".length);
      const parsedPort = parseStrictPort(rawValue);
      if (parsedPort !== null) {
        port = parsedPort;
      } else {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Invalid port option: "${rawValue}". Must be a valid TCP port (1-65535).`,
        };
      }
    } else if (arg.startsWith("--profile=")) {
      if (seenProfile) {
        return {
          action: "start",
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Duplicate option specified: "--profile". This option may only be specified once.`,
        };
      }
      seenProfile = true;
      const value = arg.slice("--profile=".length).trim().toLowerCase();
      if (isValidToolProfile(value)) {
        profileArg = value;
      } else {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Invalid tool profile: "${value}". Valid profiles: ${VALID_TOOL_PROFILES.join(", ")}`,
        };
      }
    } else if (arg.startsWith("--root=")) {
      const rootPath = arg.slice("--root=".length).trim();
      if (rootPath.length === 0) {
        return {
          action,
          transport,
          port,
          profile: DEFAULT_TOOL_PROFILE,
          roots: [],
          error: `Invalid --root option: Root path cannot be empty.`,
        };
      }
      cliRoots.push(rootPath);
    } else {
      return {
        action: "start",
        transport,
        port,
        profile: DEFAULT_TOOL_PROFILE,
        roots: [],
        error: `Unknown CLI option: "${arg}". Use --help to view available options.`,
      };
    }
  }

  const profile: ToolProfile =
    profileArg && isValidToolProfile(profileArg) ? profileArg : DEFAULT_TOOL_PROFILE;
  const roots = cliRoots.length > 0 ? cliRoots : (envRoots ?? []);

  // Validation: Workspace profile requires at least one allowed root when starting server
  if (action === "start" && (profile === "workspace" || profile === "all") && roots.length === 0) {
    return {
      action,
      transport,
      port,
      profile,
      roots,
      error: "Workspace profile requires at least one allowed root. Use --root=<path> or MCP_ROOTS_JSON.",
    };
  }

  return {
    action,
    transport,
    port,
    profile,
    roots,
  };
}

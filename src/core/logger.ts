import process from "node:process";

/**
 * Severity level of an emitted operational log event.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Configured operational log filtering threshold.
 * "off" suppresses all operational log events.
 */
export type LogThreshold = LogLevel | "off";

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const THRESHOLD_MIN_SEVERITY: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
};

/**
 * Pure parser for log threshold values.
 * Performs zero logging, zero I/O, and zero global state mutation.
 */
export function parseLogThreshold(raw: string | undefined): {
  threshold: LogThreshold;
  warningNeeded: boolean;
} {
  if (raw === undefined) {
    return { threshold: "info", warningNeeded: false };
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    // Empty string is treated as unset; defaults to info without warning
    return { threshold: "info", warningNeeded: false };
  }
  if (
    trimmed === "debug" ||
    trimmed === "info" ||
    trimmed === "warn" ||
    trimmed === "error" ||
    trimmed === "off"
  ) {
    return { threshold: trimmed, warningNeeded: false };
  }
  // Invalid non-empty string: fallback to default "info" and flag warning needed
  return { threshold: "info", warningNeeded: true };
}

// Non-recursive module initialization
const bootstrapResult = parseLogThreshold(process.env.MCP_LOG_LEVEL);
let currentThreshold: LogThreshold = bootstrapResult.threshold;

/**
 * Updates the process-global operational log threshold.
 * Internal to the server implementation; not exported from package root.
 */
export function setLogLevel(threshold: LogThreshold): void {
  currentThreshold = threshold;
}

/**
 * Returns the active process-global operational log threshold.
 * Internal to the server implementation; not exported from package root.
 */
export function getLogLevel(): LogThreshold {
  return currentThreshold;
}

/**
 * Checks whether an event at the specified severity level should be emitted under the active threshold.
 */
function isLevelEnabled(level: LogLevel, threshold: LogThreshold): boolean {
  return SEVERITY[level] >= THRESHOLD_MIN_SEVERITY[threshold];
}

/**
 * Recursively sanitizes objects, converting Error instances to serializable structures,
 * stringifying BigInt values, and safely handling circular references.
 */
function safeSerialize(obj: unknown, includeStack: boolean): unknown {
  const seen = new WeakSet();

  function sanitize(value: unknown): unknown {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Error) {
      const errObj: Record<string, unknown> = {
        name: value.name,
        message: value.message,
      };
      if (includeStack && value.stack) {
        errObj.stack = value.stack;
      }
      return errObj;
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      if (Array.isArray(value)) {
        return value.map(sanitize);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = sanitize(v);
      }
      return out;
    }
    return value;
  }

  return sanitize(obj);
}

/**
 * Stdio-safe structured logger emitting JSON Lines exclusively to stderr.
 * Never writes to stdout, filters events before serialization, protects reserved fields,
 * and never throws on unhandled serialization errors.
 */
export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>
): void {
  // Filter-before-serialization: bypass all allocations, sanitization, and I/O if suppressed
  if (!isLevelEnabled(level, currentThreshold)) {
    return;
  }

  try {
    const entry: Record<string, unknown> = {};
    const includeStack = currentThreshold === "debug";

    if (data && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) {
        // Protect reserved fields from caller spoofing
        if (key !== "timestamp" && key !== "level" && key !== "event") {
          entry[key] = safeSerialize(value, includeStack);
        }
      }
    }

    // Set authoritative reserved fields
    entry.timestamp = new Date().toISOString();
    entry.level = level;
    entry.event = event;

    const json = JSON.stringify(entry);
    process.stderr.write(`${json}\n`);
  } catch {
    // Structured fallback without caller data or recursive log() invocation
    try {
      const fallbackEntry = {
        timestamp: new Date().toISOString(),
        level: "error",
        event: "logger_serialization_failed",
      };
      process.stderr.write(`${JSON.stringify(fallbackEntry)}\n`);
    } catch {
      // Ultimate safety: never crash host application logic
    }
  }
}

// Safely emit bootstrap warning if MCP_LOG_LEVEL was invalid
if (bootstrapResult.warningNeeded) {
  log("warn", "invalid_log_level_override", {
    variable: "MCP_LOG_LEVEL",
    fallback: "info",
    message:
      "MCP_LOG_LEVEL must be one of: debug, info, warn, error, off. Falling back to default.",
  });
}

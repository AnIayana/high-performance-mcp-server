import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Recursively sanitizes objects, converting Error instances to serializable structures
 * and safely handling circular references.
 */
function safeSerialize(obj: unknown): unknown {
  const seen = new WeakSet();

  function sanitize(value: unknown): unknown {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
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
 * Never writes to stdout and never throws on unhandled serialization errors.
 */
export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>
): void {
  try {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      event,
    };

    if (data && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) {
        entry[key] = safeSerialize(value);
      }
    }

    const json = JSON.stringify(entry);
    process.stderr.write(`${json}\n`);
  } catch (err) {
    // Ultimate fallback to prevent crashing the server process
    process.stderr.write(
      `[Logger Fallback] ${new Date().toISOString()} [${level}] ${event}: ${String(err)}\n`
    );
  }
}

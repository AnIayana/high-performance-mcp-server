import type { McpProtocolLogLevel } from "./levels.js";

export type McpToolLifecycleEventName =
  | "tool.started"
  | "tool.completed"
  | "tool.cancelled"
  | "tool.timeout"
  | "tool.failed";

export type McpToolOutcome = "success" | "error" | "cancelled" | "timeout";

export type SafeNormalizedErrorCode =
  | "cancelled"
  | "timeout"
  | "invalid_request"
  | "not_found"
  | "content_conflict"
  | "access_denied"
  | "network_error"
  | "internal_error";

/**
 * Allowlisted and bounded structured logging payload.
 * Strictly free of raw arguments, file contents, absolute paths, secrets, headers, and tokens.
 */
export interface McpToolLogData {
  readonly event: McpToolLifecycleEventName;
  readonly tool: string;
  readonly profile?: string;
  readonly outcome: McpToolOutcome;
  readonly durationMs?: number;
  readonly errorCode?: SafeNormalizedErrorCode;
}

export interface McpLogEvent {
  readonly level: McpProtocolLogLevel;
  readonly data: McpToolLogData;
}

/**
 * Classifies an unknown error into a normalized, safe error code enum without exposing
 * internal messages, stack traces, path canaries, or control characters.
 */
export function classifySafeErrorCode(error: unknown): SafeNormalizedErrorCode {
  if (!error) {
    return "internal_error";
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return error.name === "TimeoutError" ? "timeout" : "cancelled";
    }

    const msg = error.message.toLowerCase();

    if (msg.includes("aborted") || msg.includes("cancelled") || msg.includes("canceled")) {
      return "cancelled";
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return "timeout";
    }
    if (msg.includes("not found") || msg.includes("not_found") || msg.includes("enoent")) {
      return "not_found";
    }
    if (
      msg.includes("conflict") ||
      msg.includes("content_conflict") ||
      msg.includes("mismatch") ||
      msg.includes("already exists")
    ) {
      return "content_conflict";
    }
    if (
      msg.includes("invalid") ||
      msg.includes("must be") ||
      msg.includes("syntax") ||
      msg.includes("unsupported")
    ) {
      return "invalid_request";
    }
    if (
      msg.includes("denied") ||
      msg.includes("forbidden") ||
      msg.includes("access_denied") ||
      msg.includes("disallowed") ||
      msg.includes("escape")
    ) {
      return "access_denied";
    }
    if (
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("enotfound") ||
      msg.includes("econnrefused") ||
      msg.includes("socket") ||
      msg.includes("dns") ||
      msg.includes("ssrf") ||
      msg.includes("http")
    ) {
      return "network_error";
    }
  }

  return "internal_error";
}

/**
 * Constructs a sanitized, allowlisted MCP log event for tool start.
 */
export function createToolStartedEvent(tool: string, profile?: string): McpLogEvent {
  return {
    level: "debug",
    data: {
      event: "tool.started",
      tool,
      profile,
      outcome: "success",
    },
  };
}

/**
 * Constructs a sanitized, allowlisted MCP log event for tool completion.
 */
export function createToolCompletedEvent(
  tool: string,
  durationMs: number,
  profile?: string
): McpLogEvent {
  return {
    level: "info",
    data: {
      event: "tool.completed",
      tool,
      profile,
      outcome: "success",
      durationMs: Number(durationMs.toFixed(2)),
    },
  };
}

/**
 * Constructs a sanitized, allowlisted MCP log event for tool failure / cancellation / timeout.
 */
export function createToolFailedEvent(
  tool: string,
  error: unknown,
  durationMs: number,
  profile?: string
): McpLogEvent {
  const safeCode = classifySafeErrorCode(error);

  if (safeCode === "cancelled") {
    return {
      level: "notice",
      data: {
        event: "tool.cancelled",
        tool,
        profile,
        outcome: "cancelled",
        durationMs: Number(durationMs.toFixed(2)),
        errorCode: "cancelled",
      },
    };
  }

  if (safeCode === "timeout") {
    return {
      level: "warning",
      data: {
        event: "tool.timeout",
        tool,
        profile,
        outcome: "timeout",
        durationMs: Number(durationMs.toFixed(2)),
        errorCode: "timeout",
      },
    };
  }

  return {
    level: "error",
    data: {
      event: "tool.failed",
      tool,
      profile,
      outcome: "error",
      durationMs: Number(durationMs.toFixed(2)),
      errorCode: safeCode,
    },
  };
}

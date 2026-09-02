/**
 * MCP Protocol Logging Levels according to the Model Context Protocol specification
 * and @modelcontextprotocol/core LoggingLevelSchema.
 */
export type McpProtocolLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export type OperatorMcpLogLevel = "off" | McpProtocolLogLevel;

export const DEFAULT_OPERATOR_MCP_LOG_LEVEL: OperatorMcpLogLevel = "off";

export const MCP_LOG_LEVEL_SEVERITY: Record<McpProtocolLogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export const VALID_MCP_LOG_LEVELS: readonly McpProtocolLogLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

export const VALID_OPERATOR_MCP_LOG_LEVELS: readonly OperatorMcpLogLevel[] = [
  "off",
  ...VALID_MCP_LOG_LEVELS,
] as const;

/**
 * Validates whether a string is a valid MCP protocol logging level.
 */
export function isValidMcpProtocolLogLevel(level: string): level is McpProtocolLogLevel {
  return VALID_MCP_LOG_LEVELS.includes(level as McpProtocolLogLevel);
}

/**
 * Validates whether a string is a valid operator MCP logging level (including 'off').
 */
export function isValidOperatorMcpLogLevel(level: string): level is OperatorMcpLogLevel {
  return VALID_OPERATOR_MCP_LOG_LEVELS.includes(level as OperatorMcpLogLevel);
}

/**
 * Normalizes a log level string to canonical lowercase, or undefined if invalid.
 */
export function normalizeOperatorMcpLogLevel(raw?: string): OperatorMcpLogLevel | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (isValidOperatorMcpLogLevel(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * Returns true if messageLevel meets or exceeds the effective minimum severity threshold.
 */
export function isLevelVisible(
  messageLevel: McpProtocolLogLevel,
  effectiveThreshold: McpProtocolLogLevel
): boolean {
  return MCP_LOG_LEVEL_SEVERITY[messageLevel] >= MCP_LOG_LEVEL_SEVERITY[effectiveThreshold];
}

/**
 * Computes the stricter (higher severity index / less verbose) of operator and client thresholds.
 */
export function computeEffectiveLogLevel(
  operatorThreshold: OperatorMcpLogLevel,
  clientRequestedLevel?: McpProtocolLogLevel
): McpProtocolLogLevel | undefined {
  if (operatorThreshold === "off") {
    return undefined;
  }
  if (!clientRequestedLevel) {
    // If client has not called logging/setLevel, do not emit unsolicited logs
    return undefined;
  }

  const operatorSeverity = MCP_LOG_LEVEL_SEVERITY[operatorThreshold];
  const clientSeverity = MCP_LOG_LEVEL_SEVERITY[clientRequestedLevel];

  // Stricter = max severity number (least verbose)
  const effectiveSeverity = Math.max(operatorSeverity, clientSeverity);

  const found = (Object.entries(MCP_LOG_LEVEL_SEVERITY) as [McpProtocolLogLevel, number][]).find(
    ([, sev]) => sev === effectiveSeverity
  );

  return found ? found[0] : undefined;
}

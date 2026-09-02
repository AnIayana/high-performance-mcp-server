import type { McpServer } from "@modelcontextprotocol/server";
import {
  computeEffectiveLogLevel,
  isLevelVisible,
  type McpProtocolLogLevel,
  type OperatorMcpLogLevel,
} from "./levels.js";
import type { McpLogEvent } from "./sanitization.js";

const MAX_PENDING_LOGS_PER_SESSION = 64;

/**
 * Manages MCP client-visible protocol logging with strict operator ceiling,
 * per-session level isolation, and bounded asynchronous delivery.
 */
export class McpLoggingManager {
  private readonly operatorThreshold: OperatorMcpLogLevel;
  private readonly sessionLevels = new Map<string | undefined, McpProtocolLogLevel>();
  private readonly sessionPendingSets = new Map<string | undefined, Set<Promise<void>>>();

  constructor(operatorThreshold: OperatorMcpLogLevel = "off") {
    this.operatorThreshold = operatorThreshold;
  }

  /**
   * Returns true if MCP protocol logging capability should be advertised to clients.
   */
  public isCapabilityEnabled(): boolean {
    return this.operatorThreshold !== "off";
  }

  /**
   * Returns the operator-configured maximum verbosity / minimum severity threshold.
   */
  public getOperatorThreshold(): OperatorMcpLogLevel {
    return this.operatorThreshold;
  }

  /**
   * Records a client's requested logging level for a specific session ID.
   */
  public setClientLevel(sessionId: string | undefined, level: McpProtocolLogLevel): void {
    if (this.operatorThreshold === "off") {
      return;
    }
    this.sessionLevels.set(sessionId, level);
  }

  /**
   * Returns the raw client-requested logging level for a session, if set.
   */
  public getClientLevel(sessionId: string | undefined): McpProtocolLogLevel | undefined {
    return this.sessionLevels.get(sessionId);
  }

  /**
   * Computes the effective logging threshold for a session by taking the stricter of
   * operator ceiling and client requested level.
   */
  public getEffectiveLevel(sessionId: string | undefined): McpProtocolLogLevel | undefined {
    const clientLevel = this.sessionLevels.get(sessionId);
    return computeEffectiveLogLevel(this.operatorThreshold, clientLevel);
  }

  /**
   * Returns true if a message at messageLevel should be delivered to the session.
   */
  public shouldEmit(sessionId: string | undefined, messageLevel: McpProtocolLogLevel): boolean {
    const effective = this.getEffectiveLevel(sessionId);
    if (!effective) {
      return false;
    }
    return isLevelVisible(messageLevel, effective);
  }

  /**
   * Extracts the canonical session ID from an MCP request context or extra object.
   */
  public extractSessionId(extra?: any): string | undefined {
    if (!extra) return undefined;
    return (
      extra.sessionId ??
      extra.mcpReq?.sessionId ??
      extra.http?.req?.headers?.get?.("mcp-session-id") ??
      undefined
    );
  }

  /**
   * Asynchronously emits a structured, allowlisted MCP protocol log event to the client
   * without blocking core tool operations or leaking unhandled promise rejections.
   */
  public emitLog(server: McpServer, extra: any, event: McpLogEvent): void {
    if (!this.isCapabilityEnabled()) {
      return;
    }

    const sessionId = this.extractSessionId(extra);

    if (!this.shouldEmit(sessionId, event.level)) {
      return;
    }

    let pendingSet = this.sessionPendingSets.get(sessionId);
    if (!pendingSet) {
      pendingSet = new Set<Promise<void>>();
      this.sessionPendingSets.set(sessionId, pendingSet);
    }

    // Bounded backpressure: if client is stalled and pending logs exceed limit, drop oldest
    if (pendingSet.size >= MAX_PENDING_LOGS_PER_SESSION) {
      return;
    }

    try {
      const sendPromise = server.server
        .sendLoggingMessage(
          {
            level: event.level,
            logger: "high-performance-mcp-server",
            data: event.data,
          },
          sessionId
        )
        .catch(() => {
          // Auxiliary delivery failure ignored
        })
        .finally(() => {
          pendingSet?.delete(sendPromise);
        });

      pendingSet.add(sendPromise);
    } catch {
      // Synchronous send error ignored
    }
  }

  /**
   * Cleans up all state and pending promises for a closing session.
   */
  public clearSession(sessionId: string | undefined): void {
    this.sessionLevels.delete(sessionId);
    const pending = this.sessionPendingSets.get(sessionId);
    if (pending) {
      pending.clear();
      this.sessionPendingSets.delete(sessionId);
    }
  }

  /**
   * Closes the manager and clears all active sessions.
   */
  public close(): void {
    this.sessionLevels.clear();
    for (const set of this.sessionPendingSets.values()) {
      set.clear();
    }
    this.sessionPendingSets.clear();
  }
}

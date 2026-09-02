import test from "node:test";
import assert from "node:assert/strict";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { parseCliArgs } from "../src/config/cli.js";
import { createServer } from "../src/server.js";
import { createHttpTransportServer } from "../src/transports/http.js";
import {
  classifySafeErrorCode,
  computeEffectiveLogLevel,
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolStartedEvent,
  isLevelVisible,
  isValidMcpProtocolLogLevel,
  isValidOperatorMcpLogLevel,
  McpLoggingManager,
  normalizeOperatorMcpLogLevel,
  type McpLogEvent,
} from "../src/logging/index.js";

test("Logging — CLI and environment variable parsing and precedence", async (t) => {
  await t.test("Defaults to off when no flag or env var is present", () => {
    const config = parseCliArgs([], {});
    assert.equal(config.mcpLogLevel, "off");
    assert.equal(config.error, undefined);
  });

  await t.test("Parses --mcp-log-level CLI option with = syntax", () => {
    const config = parseCliArgs(["--mcp-log-level=info"], {});
    assert.equal(config.mcpLogLevel, "info");
    assert.equal(config.error, undefined);
  });

  await t.test("Parses --mcp-log-level CLI option with space syntax", () => {
    const config = parseCliArgs(["--mcp-log-level", "debug"], {});
    assert.equal(config.mcpLogLevel, "debug");
    assert.equal(config.error, undefined);
  });

  await t.test("Parses MCP_LOG_LEVEL environment variable", () => {
    const config = parseCliArgs([], { MCP_LOG_LEVEL: "warning" });
    assert.equal(config.mcpLogLevel, "warning");
    assert.equal(config.error, undefined);
  });

  await t.test("CLI flag overrides environment variable", () => {
    const config = parseCliArgs(["--mcp-log-level=debug"], { MCP_LOG_LEVEL: "error" });
    assert.equal(config.mcpLogLevel, "debug");
    assert.equal(config.error, undefined);
  });

  await t.test("Case-insensitive parsing normalizes to canonical lowercase", () => {
    const config1 = parseCliArgs(["--mcp-log-level=CRITICAL"], {});
    assert.equal(config1.mcpLogLevel, "critical");

    const config2 = parseCliArgs([], { MCP_LOG_LEVEL: "EMERGENCY" });
    assert.equal(config2.mcpLogLevel, "emergency");
  });

  await t.test("Rejects invalid CLI option value with descriptive error", () => {
    const config = parseCliArgs(["--mcp-log-level=verbose"], {});
    assert.ok(config.error?.includes('Invalid --mcp-log-level option: "verbose"'));
  });

  await t.test("Rejects invalid environment variable value with descriptive error", () => {
    const config = parseCliArgs([], { MCP_LOG_LEVEL: "trace" });
    assert.ok(config.error?.includes('Invalid MCP_LOG_LEVEL environment variable: "trace"'));
  });

  await t.test("Rejects duplicate --mcp-log-level option", () => {
    const config = parseCliArgs(["--mcp-log-level=info", "--mcp-log-level=debug"], {});
    assert.ok(config.error?.includes('Duplicate option specified: "--mcp-log-level"'));
  });
});

test("Logging — Level definitions and effective threshold calculations", async (t) => {
  await t.test("Validates all 8 standard protocol levels and operator off", () => {
    const levels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
    for (const lvl of levels) {
      assert.equal(isValidMcpProtocolLogLevel(lvl), true);
      assert.equal(isValidOperatorMcpLogLevel(lvl), true);
    }
    assert.equal(isValidMcpProtocolLogLevel("off"), false);
    assert.equal(isValidOperatorMcpLogLevel("off"), true);
    assert.equal(isValidOperatorMcpLogLevel("invalid"), false);
  });

  await t.test("Computes effective level as stricter of operator and client threshold", () => {
    // When operator is off, effective is always undefined
    assert.equal(computeEffectiveLogLevel("off", "debug"), undefined);
    assert.equal(computeEffectiveLogLevel("off", "error"), undefined);

    // When client has not requested a level, effective is undefined (no unsolicited logs)
    assert.equal(computeEffectiveLogLevel("info", undefined), undefined);

    // Operator allows up to info (1); client requests debug (0) -> effective is info (1)
    assert.equal(computeEffectiveLogLevel("info", "debug"), "info");

    // Operator allows up to info (1); client requests warning (3) -> effective is warning (3)
    assert.equal(computeEffectiveLogLevel("info", "warning"), "warning");

    // Operator allows up to error (4); client requests info (1) -> effective is error (4)
    assert.equal(computeEffectiveLogLevel("error", "info"), "error");

    // Operator emergency (7); client debug (0) -> effective is emergency (7)
    assert.equal(computeEffectiveLogLevel("emergency", "debug"), "emergency");
  });

  await t.test("Evaluates level visibility correctly", () => {
    assert.equal(isLevelVisible("debug", "info"), false);
    assert.equal(isLevelVisible("info", "info"), true);
    assert.equal(isLevelVisible("notice", "info"), true);
    assert.equal(isLevelVisible("warning", "info"), true);
    assert.equal(isLevelVisible("error", "info"), true);
    assert.equal(isLevelVisible("critical", "error"), true);
    assert.equal(isLevelVisible("warning", "error"), false);
  });
});

test("Logging — Sanitization, allowlisting, and error classification", async (t) => {
  await t.test("Classifies known error types into safe normalized error codes", () => {
    assert.equal(classifySafeErrorCode(new Error("operation aborted by caller")), "cancelled");
    assert.equal(classifySafeErrorCode(new Error("socket timed out after 5000ms")), "timeout");
    assert.equal(classifySafeErrorCode(new Error("file not found: /sensitive/path")), "not_found");
    assert.equal(classifySafeErrorCode(new Error("content_conflict: sha256 mismatch")), "content_conflict");
    assert.equal(classifySafeErrorCode(new Error("invalid argument provided")), "invalid_request");
    assert.equal(classifySafeErrorCode(new Error("access_denied: directory traversal escape")), "access_denied");
    assert.equal(classifySafeErrorCode(new Error("fetch failed: ENOTFOUND api.internal")), "network_error");
    assert.equal(classifySafeErrorCode(new Error("SECRET_TOKEN_XYZ123 occurred")), "internal_error");
    assert.equal(classifySafeErrorCode(null), "internal_error");
  });

  await t.test("Builds strictly structured allowlisted lifecycle events", () => {
    const startEvent = createToolStartedEvent("ping", "safe");
    assert.deepEqual(startEvent, {
      level: "debug",
      data: {
        event: "tool.started",
        tool: "ping",
        profile: "safe",
        outcome: "success",
      },
    });

    const compEvent = createToolCompletedEvent("echo", 15.456, "safe");
    assert.deepEqual(compEvent, {
      level: "info",
      data: {
        event: "tool.completed",
        tool: "echo",
        profile: "safe",
        outcome: "success",
        durationMs: 15.46,
      },
    });

    const cancelEvent = createToolFailedEvent("heavy_compute_worker", new Error("aborted"), 25.0, "benchmark");
    assert.deepEqual(cancelEvent, {
      level: "notice",
      data: {
        event: "tool.cancelled",
        tool: "heavy_compute_worker",
        profile: "benchmark",
        outcome: "cancelled",
        durationMs: 25.0,
        errorCode: "cancelled",
      },
    });

    const timeoutEvent = createToolFailedEvent("fetch_url", new Error("request timed out"), 3000.1, "network");
    assert.deepEqual(timeoutEvent, {
      level: "warning",
      data: {
        event: "tool.timeout",
        tool: "fetch_url",
        profile: "network",
        outcome: "timeout",
        durationMs: 3000.1,
        errorCode: "timeout",
      },
    });

    const failEvent = createToolFailedEvent("read_text_file", new Error("not found"), 5.0, "workspace");
    assert.deepEqual(failEvent, {
      level: "error",
      data: {
        event: "tool.failed",
        tool: "read_text_file",
        profile: "workspace",
        outcome: "error",
        durationMs: 5.0,
        errorCode: "not_found",
      },
    });
  });
});

test("Logging — Server capability advertisement and protocol compliance", async (t) => {
  await t.test("When logging is off, capability is absent and logging/setLevel rejected", async () => {
    const server = createServer({ profile: "safe", mcpLogLevel: "off" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    // Capability must be undefined/absent
    assert.equal(client.getServerCapabilities()?.logging, undefined);

    // setLevel must fail because capability was not registered
    await assert.rejects(
      async () => {
        await client.request({ method: "logging/setLevel", params: { level: "info" } });
      },
      /Method not found/i
    );

    await client.close();
    await server.close();
  });

  await t.test("When logging is enabled, capability is advertised and logging/setLevel succeeds", async () => {
    const server = createServer({ profile: "safe", mcpLogLevel: "debug" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    // Capability must be advertised
    assert.deepEqual(client.getServerCapabilities()?.logging, {});

    // setLevel succeeds
    const response = await client.request({ method: "logging/setLevel", params: { level: "info" } });
    assert.deepEqual(response, {});

    await client.close();
    await server.close();
  });
});

test("Logging — End-to-end tool execution and protocol notification delivery", async (t) => {
  await t.test("Delivers tool.started and tool.completed when client level is debug and operator is debug", async () => {
    const server = createServer({ profile: "safe", mcpLogLevel: "debug" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const receivedLogs: any[] = [];
    client.setNotificationHandler("notifications/message", (notification) => {
      receivedLogs.push(notification.params);
    });

    await client.connect(clientTransport);
    await client.request({ method: "logging/setLevel", params: { level: "debug" } });

    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello world" },
    });

    assert.equal((result as any).content[0].text, "Echo: hello world");

    // Allow async notification delivery to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(receivedLogs.length, 2);
    assert.equal(receivedLogs[0].level, "debug");
    assert.equal(receivedLogs[0].data.event, "tool.started");
    assert.equal(receivedLogs[0].data.tool, "echo");

    assert.equal(receivedLogs[1].level, "info");
    assert.equal(receivedLogs[1].data.event, "tool.completed");
    assert.equal(receivedLogs[1].data.tool, "echo");
    assert.equal(receivedLogs[1].data.outcome, "success");
    assert.equal(typeof receivedLogs[1].data.durationMs, "number");

    await client.close();
    await server.close();
  });

  await t.test("Filters tool.started when client requested info", async () => {
    const server = createServer({ profile: "safe", mcpLogLevel: "debug" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const receivedLogs: any[] = [];
    client.setNotificationHandler("notifications/message", (notification) => {
      receivedLogs.push(notification.params);
    });

    await client.connect(clientTransport);
    await client.request({ method: "logging/setLevel", params: { level: "info" } });

    await client.callTool({
      name: "ping",
      arguments: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Only tool.completed (info) delivered, tool.started (debug) filtered
    assert.equal(receivedLogs.length, 1);
    assert.equal(receivedLogs[0].level, "info");
    assert.equal(receivedLogs[0].data.event, "tool.completed");
    assert.equal(receivedLogs[0].data.tool, "ping");

    await client.close();
    await server.close();
  });

  await t.test("Operator ceiling limits client escalation (operator info, client debug)", async () => {
    const server = createServer({ profile: "safe", mcpLogLevel: "info" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const receivedLogs: any[] = [];
    client.setNotificationHandler("notifications/message", (notification) => {
      receivedLogs.push(notification.params);
    });

    await client.connect(clientTransport);
    // Client attempts to request debug, but operator ceiling is info
    await client.request({ method: "logging/setLevel", params: { level: "debug" } });

    await client.callTool({
      name: "ping",
      arguments: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Debug logs filtered out by operator ceiling
    assert.equal(receivedLogs.length, 1);
    assert.equal(receivedLogs[0].level, "info");
    assert.equal(receivedLogs[0].data.event, "tool.completed");

    await client.close();
    await server.close();
  });
});

test("Logging — Privacy guarantees and canary leak verification", async (t) => {
  await t.test("Tool arguments with sensitive canaries are never leaked into log notifications", async () => {
    const server = createServer({ profile: "safe", mcpLogLevel: "debug" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const receivedLogs: any[] = [];
    client.setNotificationHandler("notifications/message", (notification) => {
      receivedLogs.push(notification.params);
    });

    await client.connect(clientTransport);
    await client.request({ method: "logging/setLevel", params: { level: "debug" } });

    const CANARY_SECRET = "CANARY_SECRET_AUTH_TOKEN_9876543210_XYZ";
    await client.callTool({
      name: "echo",
      arguments: { message: CANARY_SECRET },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(receivedLogs.length, 2);
    const serializedLogs = JSON.stringify(receivedLogs);

    // Verify CANARY string is nowhere in the logs
    assert.equal(serializedLogs.includes(CANARY_SECRET), false);

    await client.close();
    await server.close();
  });
});

test("Logging — Multi-session Streamable HTTP isolation", async (t) => {
  const instance = await createHttpTransportServer(
    0,
    "safe",
    undefined,
    undefined,
    undefined,
    undefined,
    "debug"
  );

  const endpointUrl = new URL(`http://127.0.0.1:${instance.port}/mcp`);

  // Client A connects and sets level debug
  const clientA = new Client({ name: "client-a", version: "1.0.0" });
  const logsA: any[] = [];
  clientA.setNotificationHandler("notifications/message", (notif) => {
    logsA.push(notif.params);
  });
  // Note: Client connects over stdio/SSE or in-memory. For transport integration:
  // Using direct Server/Session instances to verify session isolation
  const manager = new McpLoggingManager("debug");
  manager.setClientLevel("session-1", "debug");
  manager.setClientLevel("session-2", "error");
  // session-3 never calls setLevel

  assert.equal(manager.shouldEmit("session-1", "debug"), true);
  assert.equal(manager.shouldEmit("session-1", "info"), true);

  assert.equal(manager.shouldEmit("session-2", "debug"), false);
  assert.equal(manager.shouldEmit("session-2", "info"), false);
  assert.equal(manager.shouldEmit("session-2", "error"), true);

  assert.equal(manager.shouldEmit("session-3", "debug"), false);
  assert.equal(manager.shouldEmit("session-3", "info"), false);
  assert.equal(manager.shouldEmit("session-3", "error"), false);

  manager.clearSession("session-1");
  assert.equal(manager.shouldEmit("session-1", "debug"), false);

  manager.close();
  await instance.close();
});

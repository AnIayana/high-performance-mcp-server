import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync, spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  getLogLevel,
  log,
  parseLogThreshold,
  setLogLevel,
  type LogLevel,
  type LogThreshold,
} from "../src/core/logger.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const distIndexPath = path.resolve(rootDir, "dist/index.js");
const distCliPath = path.resolve(rootDir, "dist/cli.js");
if (!fs.existsSync(distIndexPath) || !fs.existsSync(distCliPath)) {
  execSync("npm run build", { cwd: rootDir, stdio: "pipe" });
}
const cliScriptPath = distCliPath;

// Capture process.stderr.write outputs in memory for unit tests
function withInterceptedStderr(fn: () => void): string[] {
  const originalWrite = process.stderr.write;
  const lines: string[] = [];
  try {
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(chunk.toString());
      return true;
    }) as any;
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return lines;
}

test("Logger — parseLogThreshold pure parsing rules", () => {
  assert.deepEqual(parseLogThreshold("debug"), { threshold: "debug", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("info"), { threshold: "info", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("warn"), { threshold: "warn", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("error"), { threshold: "error", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("off"), { threshold: "off", warningNeeded: false });

  // Case-insensitivity & whitespace trimming
  assert.deepEqual(parseLogThreshold("  DEBUG  "), { threshold: "debug", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("InFo"), { threshold: "info", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("WARN"), { threshold: "warn", warningNeeded: false });

  // Empty string / whitespace treated as unset (default info, no warning)
  assert.deepEqual(parseLogThreshold(""), { threshold: "info", warningNeeded: false });
  assert.deepEqual(parseLogThreshold("   "), { threshold: "info", warningNeeded: false });
  assert.deepEqual(parseLogThreshold(undefined), { threshold: "info", warningNeeded: false });

  // Invalid values fallback to info with warningNeeded: true
  assert.deepEqual(parseLogThreshold("verbose"), { threshold: "info", warningNeeded: true });
  assert.deepEqual(parseLogThreshold("123"), { threshold: "info", warningNeeded: true });
});

test("Logger — internal state API getLogLevel and setLogLevel", () => {
  const initial = getLogLevel();
  try {
    setLogLevel("warn");
    assert.equal(getLogLevel(), "warn");
    setLogLevel("off");
    assert.equal(getLogLevel(), "off");
    setLogLevel("debug");
    assert.equal(getLogLevel(), "debug");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — level filtering matrix exact", () => {
  const initial = getLogLevel();
  try {
    // 1. Off threshold suppresses all levels
    setLogLevel("off");
    let lines = withInterceptedStderr(() => {
      log("debug", "dbg_event");
      log("info", "inf_event");
      log("warn", "wrn_event");
      log("error", "err_event");
    });
    assert.equal(lines.length, 0, "off threshold must suppress all events");

    // 2. Error threshold emits error only
    setLogLevel("error");
    lines = withInterceptedStderr(() => {
      log("debug", "dbg_event");
      log("info", "inf_event");
      log("warn", "wrn_event");
      log("error", "err_event");
    });
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0]!).event === "err_event");

    // 3. Warn threshold emits warn and error
    setLogLevel("warn");
    lines = withInterceptedStderr(() => {
      log("debug", "dbg_event");
      log("info", "inf_event");
      log("warn", "wrn_event");
      log("error", "err_event");
    });
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).event, "wrn_event");
    assert.equal(JSON.parse(lines[1]!).event, "err_event");

    // 4. Info threshold emits info, warn, error; suppresses debug
    setLogLevel("info");
    lines = withInterceptedStderr(() => {
      log("debug", "dbg_event");
      log("info", "inf_event");
      log("warn", "wrn_event");
      log("error", "err_event");
    });
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]!).event, "inf_event");
    assert.equal(JSON.parse(lines[1]!).event, "wrn_event");
    assert.equal(JSON.parse(lines[2]!).event, "err_event");

    // 5. Debug threshold emits all
    setLogLevel("debug");
    lines = withInterceptedStderr(() => {
      log("debug", "dbg_event");
      log("info", "inf_event");
      log("warn", "wrn_event");
      log("error", "err_event");
    });
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[0]!).event, "dbg_event");
    assert.equal(JSON.parse(lines[1]!).event, "inf_event");
    assert.equal(JSON.parse(lines[2]!).event, "wrn_event");
    assert.equal(JSON.parse(lines[3]!).event, "err_event");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — filter-before-serialization skips object traversal and formatting", () => {
  const initial = getLogLevel();
  try {
    setLogLevel("error");

    let getterCalled = false;
    const lazyObject = {
      get value() {
        getterCalled = true;
        return "evaluated";
      },
    };

    const lines = withInterceptedStderr(() => {
      log("info", "suppressed_event", lazyObject as any);
    });

    assert.equal(lines.length, 0);
    assert.equal(getterCalled, false, "Suppressed log must not evaluate object getters or properties");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — reserved field integrity prevents caller spoofing", () => {
  const initial = getLogLevel();
  try {
    setLogLevel("info");
    const lines = withInterceptedStderr(() => {
      log("info", "genuine_event", {
        timestamp: "1999-01-01T00:00:00.000Z",
        level: "error",
        event: "spoofed_event",
        customKey: "customValue",
      });
    });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.notEqual(parsed.timestamp, "1999-01-01T00:00:00.000Z");
    assert.equal(parsed.level, "info", "Authoritative level must not be overwritten");
    assert.equal(parsed.event, "genuine_event", "Authoritative event must not be overwritten");
    assert.equal(parsed.customKey, "customValue");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — BigInt serialization safety", () => {
  const initial = getLogLevel();
  try {
    setLogLevel("info");
    const lines = withInterceptedStderr(() => {
      log("info", "bigint_test", {
        largeNum: 9007199254740993n,
      });
    });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.largeNum, "9007199254740993");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — circular reference serialization safety", () => {
  const initial = getLogLevel();
  try {
    setLogLevel("info");
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const lines = withInterceptedStderr(() => {
      log("info", "circular_test", { data: circular });
    });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.data.self, "[Circular]");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — structured fallback when data serialization fails", () => {
  const initial = getLogLevel();
  try {
    setLogLevel("info");
    const unparseable = {
      toJSON() {
        throw new Error("Exploding serializer");
      },
    };

    const lines = withInterceptedStderr(() => {
      log("info", "exploding_event", { bad: unparseable });
    });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.level, "error");
    assert.equal(parsed.event, "logger_serialization_failed");
    assert.ok(typeof parsed.timestamp === "string");
  } finally {
    setLogLevel(initial);
  }
});

test("Logger — error stack is omitted at info and included at debug threshold", () => {
  const initial = getLogLevel();
  try {
    const testErr = new Error("Sample failure");

    // 1. At threshold info: error stack is omitted
    setLogLevel("info");
    let lines = withInterceptedStderr(() => {
      log("error", "tool_call_failed", { error: testErr });
    });
    assert.equal(lines.length, 1);
    let parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.error.name, "Error");
    assert.equal(parsed.error.message, "Sample failure");
    assert.equal(parsed.error.stack, undefined, "Stack must be omitted when threshold is info");

    // 2. At threshold debug: error stack is present
    setLogLevel("debug");
    lines = withInterceptedStderr(() => {
      log("error", "tool_call_failed", { error: testErr });
    });
    assert.equal(lines.length, 1);
    parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.error.name, "Error");
    assert.equal(parsed.error.message, "Sample failure");
    assert.ok(typeof parsed.error.stack === "string", "Stack must be present when threshold is debug");
  } finally {
    setLogLevel(initial);
  }
});

test("Subprocess — MCP_LOG_LEVEL=off suppresses early import worker warnings", () => {
  const checkScript = `
    import { createServer } from "./dist/index.js";
    const s = createServer();
    await s.close();
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      MCP_LOG_LEVEL: "off",
      MCP_WORKER_COUNT: "FORBIDDEN_ENV_SENTINEL",
    },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "", "MCP_LOG_LEVEL=off must suppress early worker warning entirely");
  assert.ok(!result.stderr.includes("FORBIDDEN_ENV_SENTINEL"));
});

test("Subprocess — MCP_LOG_LEVEL=warn emits early warning with raw sentinel omitted", () => {
  const checkScript = `
    import { createServer } from "./dist/index.js";
    const s = createServer();
    await s.close();
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      MCP_LOG_LEVEL: "warn",
      MCP_WORKER_COUNT: "FORBIDDEN_ENV_SENTINEL",
    },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes("invalid_worker_count_override"));
  assert.ok(
    !result.stderr.includes("FORBIDDEN_ENV_SENTINEL"),
    "Raw invalid env string must NOT be logged in operational warning"
  );
});

test("Subprocess — invalid MCP_LOG_LEVEL falls back to info without crashing or raw echo", () => {
  const checkScript = `
    import { createServer } from "./dist/index.js";
    const s = createServer();
    await s.close();
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      MCP_LOG_LEVEL: "FORBIDDEN_LOG_LEVEL_SENTINEL",
    },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
  assert.ok(result.stderr.includes("invalid_log_level_override"));
  assert.ok(
    !result.stderr.includes("FORBIDDEN_LOG_LEVEL_SENTINEL"),
    "Raw invalid log level must NOT be logged in fallback warning"
  );
});

test("Subprocess — CLI --log-level overrides MCP_LOG_LEVEL after CLI parsing", () => {
  // Pass env MCP_LOG_LEVEL=warn and CLI --log-level=error
  const result = spawnSync(
    process.execPath,
    [cliScriptPath, "--log-level=error", "--list-tools"],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        MCP_LOG_LEVEL: "warn",
      },
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("Profile: safe"));
});

test("Subprocess — CLI validation error with --log-level=off remains visible on stderr", () => {
  const result = spawnSync(
    process.execPath,
    [cliScriptPath, "--log-level=off", "--invalid-unknown-option"],
    {
      cwd: rootDir,
      encoding: "utf-8",
    }
  );

  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("[Error] Unexpected positional argument") ||
      result.stderr.includes("[Error]"),
    "CLI usage error must remain visible on stderr even under --log-level=off"
  );
});

test("Subprocess — HTTP lifecycle logs emit structured JSON Lines and no access logs", async () => {
  const testPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error("No port")));
      }
    });
    srv.on("error", reject);
  });

  const child = spawn(process.execPath, [cliScriptPath, "--transport=http", `--port=${testPort}`], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrLines: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for HTTP listening")), 10000);
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) {
            stderrLines.push(trimmed);
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.event === "http_listening") {
                clearTimeout(timeout);
                resolve();
              }
            } catch {
              // Ignore non-JSON
            }
          }
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`Exited early: ${code}`)));
    });

    // Verify structured http_listening event shape
    const listeningLine = stderrLines.find((l) => {
      try {
        return JSON.parse(l).event === "http_listening";
      } catch {
        return false;
      }
    });
    assert.ok(listeningLine, "http_listening JSON Line must be emitted");
    const parsedListening = JSON.parse(listeningLine);
    assert.equal(parsedListening.level, "info");
    assert.equal(parsedListening.host, "127.0.0.1");
    assert.equal(parsedListening.port, testPort);
    assert.equal(parsedListening.profile, "safe");

    // Ensure no old [MCP HTTP] string
    assert.ok(!stderrLines.some((l) => l.includes("[MCP HTTP] Listening on")));

    // Probe GET /healthz multiple times
    const beforeCount = stderrLines.length;
    await fetch(`http://127.0.0.1:${testPort}/healthz`);
    await fetch(`http://127.0.0.1:${testPort}/healthz`);
    await new Promise((r) => setTimeout(r, 200));

    // Health requests must not emit per-request access logs
    const afterCount = stderrLines.length;
    assert.equal(afterCount, beforeCount, "Health probes must emit zero per-request operational logs");
  } finally {
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
    });
  }
});

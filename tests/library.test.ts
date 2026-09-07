import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as publicApi from "../src/index.js";
import { createServer, resolveWorkspaceConfig } from "../src/index.js";
import type {
  CreateServerOptions,
  ToolProfile,
  WorkspaceConfig,
  WorkspaceRoot,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// Ensure build artifacts exist if running test suite prior to build step (e.g. CI workflow)
const distIndexPath = path.resolve(rootDir, "dist/index.js");
const distCliPath = path.resolve(rootDir, "dist/cli.js");
if (!fs.existsSync(distIndexPath) || !fs.existsSync(distCliPath)) {
  execSync("npm run build", { cwd: rootDir, stdio: "pipe" });
}

test("Package Metadata — main, types, absence of exports, and bin mapping", () => {
  const packageJsonPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

  assert.equal(pkg.main, "./dist/index.js", "package.json main must point to ./dist/index.js");
  assert.equal(pkg.types, "./dist/index.d.ts", "package.json types must point to ./dist/index.d.ts");
  assert.equal(pkg.exports, undefined, "package.json must NOT declare an exports map in M1");
  assert.equal(
    pkg.bin?.["high-performance-mcp-server"],
    "bin/cli.js",
    "package.json bin must point to bin/cli.js"
  );
  assert.equal(pkg.version, "0.5.0", "Package version must remain 0.5.0");

  const binCliContent = fs.readFileSync(path.join(rootDir, "bin/cli.js"), "utf-8");
  assert.ok(
    binCliContent.includes('import "../dist/cli.js";'),
    "bin/cli.js must import ../dist/cli.js"
  );
});

test("Root Public API — surface inventory and forbidden internal omissions", () => {
  // 1. Function exports
  assert.equal(typeof publicApi.createServer, "function", "createServer must be exported");
  assert.equal(
    typeof publicApi.resolveWorkspaceConfig,
    "function",
    "resolveWorkspaceConfig must be exported"
  );

  // 2. Prohibited exports must NOT be present on public root
  const forbiddenNames = [
    "closeWorkerPool",
    "createHttpTransportServer",
    "startHttpTransport",
    "startStdioTransport",
    "createWorkspaceOperatorPolicy",
    "createNetworkOperatorPolicy",
    "createNetworkCachePolicy",
    "DEFAULT_WORKSPACE_OPERATOR_POLICY",
    "DEFAULT_NETWORK_OPERATOR_POLICY",
    "DEFAULT_NETWORK_CACHE_POLICY",
    "HttpConditionalCache",
    "WorkerPool",
    "CacheStore",
    "toolMetricsStore",
  ];

  for (const forbidden of forbiddenNames) {
    assert.equal(
      (publicApi as Record<string, unknown>)[forbidden],
      undefined,
      `Internal symbol "${forbidden}" must not be exported from public root`
    );
  }

  // 3. Verify public export count is exact (only createServer and resolveWorkspaceConfig)
  const exportedKeys = Object.keys(publicApi);
  assert.deepEqual(
    exportedKeys.sort(),
    ["createServer", "resolveWorkspaceConfig"],
    "Only createServer and resolveWorkspaceConfig must be exported functions"
  );
});

test("Root Import Process Neutrality — clean environment produces zero stdout/stderr", () => {
  const targetUrl = pathToFileURL(path.resolve(rootDir, "dist/index.js")).href;
  const checkScript = `
    import * as lib from "${targetUrl}";
    if (typeof lib.createServer !== "function") process.exit(2);
  `;

  // Filter out any user MCP env vars to ensure clean test
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("MCP_") && k !== "PORT") {
      cleanEnv[k] = v;
    }
  }

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: rootDir,
    env: cleanEnv,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, `Process must exit with 0. Stderr: ${result.stderr}`);
  assert.equal(result.stdout, "", "Import in clean environment must produce zero stdout");
  assert.equal(result.stderr, "", "Import in clean environment must produce zero stderr");
});

test("Root Import Process Neutrality — malformed env does not throw or exit", () => {
  const targetUrl = pathToFileURL(path.resolve(rootDir, "dist/index.js")).href;
  const checkScript = `
    import * as lib from "${targetUrl}";
    if (typeof lib.createServer !== "function") process.exit(2);
  `;

  const dirtyEnv: Record<string, string> = {
    ...process.env,
    MCP_WORKER_COUNT: "invalid_count",
    MCP_CACHE_MAX_ENTRIES: "not_a_number",
    MCP_CACHE_TTL_MS: "-500",
  };

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: rootDir,
    env: dirtyEnv,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, `Process must succeed despite dirty env. Stderr: ${result.stderr}`);
  assert.equal(result.stdout, "", "Malformed env import must produce zero stdout");
  // Stderr may contain sanitized JSON warning lines from logger
  assert.ok(
    result.stderr.includes("invalid_worker_count_override") ||
      result.stderr.includes("invalid_cache_max_entries_override") ||
      result.stderr.includes("invalid_cache_ttl_override"),
    "Stderr must contain expected sanitized warnings"
  );
});

test("Factory Safe Default — createServer() defaults to safe profile with echo and ping", async () => {
  const server = createServer();
  assert.ok(server, "createServer() must return a server instance");

  // Verify internal instructions and server info
  const internalInfo = (server.server as any)._serverInfo;
  assert.equal(internalInfo?.name, "high-performance-mcp-server");
  assert.equal(internalInfo?.version, "0.5.0");

  // Verify registered tools exact
  const registeredTools = Object.keys((server as any)._registeredTools || {});
  assert.deepEqual(registeredTools.sort(), ["echo", "ping"]);

  // Clean up
  await server.close();
});

test("Workspace Factory — resolveWorkspaceConfig and workspace profile initialization", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lib-test-"));
  try {
    const subDir = path.join(tempDir, "workspace-a");
    fs.mkdirSync(subDir, { recursive: true });

    // 1. resolveWorkspaceConfig
    const config = await resolveWorkspaceConfig([subDir]);
    assert.ok(Array.isArray(config.roots), "roots must be an array");
    assert.equal(config.roots.length, 1);
    assert.equal(config.roots[0].id, "root-1");
    assert.equal(config.roots[0].name, "workspace-a");
    assert.ok(path.isAbsolute(config.roots[0].path), "Local path must be absolute");
    assert.ok(path.isAbsolute(config.roots[0].realPath), "realPath must be absolute");

    // 2. createServer with workspaceConfig
    const server = createServer({
      profile: "workspace",
      workspaceConfig: config,
    });
    assert.ok(server);

    const registeredTools = Object.keys((server as any)._registeredTools || {});
    assert.ok(registeredTools.includes("list_directory"));
    assert.ok(registeredTools.includes("read_text_file"));
    assert.ok(registeredTools.includes("search_files"));
    assert.ok(registeredTools.includes("search_text"));
    assert.ok(!registeredTools.includes("write_text_file"), "Read-only workspace profile must not include write tools");

    await server.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Multi-Instance Safety — two createServer instances can coexist and close independently", async () => {
  const server1 = createServer({ profile: "safe" });
  const server2 = createServer({ profile: "diagnostics" });

  assert.notEqual(server1, server2, "Instances must be distinct objects");

  const tools1 = Object.keys((server1 as any)._registeredTools || {});
  const tools2 = Object.keys((server2 as any)._registeredTools || {});

  assert.deepEqual(tools1.sort(), ["echo", "ping"]);
  assert.ok(tools2.includes("system_stats"));

  // Closing server1 must not throw and must not close server2
  await server1.close();

  // server2 can still be closed independently
  await server2.close();
});

test("CLI Regression — dist/cli.js executes --version, --help, --list-tools, and invalid flags", () => {
  const cliPath = path.resolve(rootDir, "dist/cli.js");

  // 1. --version
  const versionRes = spawnSync(process.execPath, [cliPath, "--version"], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  assert.equal(versionRes.status, 0);
  assert.equal(versionRes.stdout.trim(), "0.5.0");

  // 2. --help
  const helpRes = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  assert.equal(helpRes.status, 0);
  assert.ok(helpRes.stdout.includes("Usage:"));
  assert.ok(helpRes.stdout.includes("--profile"));

  // 3. --list-tools
  const listToolsRes = spawnSync(process.execPath, [cliPath, "--list-tools", "--profile=safe"], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  assert.equal(listToolsRes.status, 0);
  assert.ok(listToolsRes.stdout.includes("Profile: safe"));
  assert.ok(listToolsRes.stdout.includes("echo"));
  assert.ok(listToolsRes.stdout.includes("ping"));

  // 4. Invalid flag exits with code 1
  const invalidRes = spawnSync(process.execPath, [cliPath, "--invalid-flag"], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  assert.equal(invalidRes.status, 1);
  assert.ok(invalidRes.stderr.includes("Unknown CLI option"));
});

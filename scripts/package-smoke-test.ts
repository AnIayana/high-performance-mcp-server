import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function runPackageSmokeTest(): Promise<void> {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const expectedVersion = packageJson.version;
  const binName = typeof packageJson.bin === "object" ? Object.keys(packageJson.bin)[0] : packageJson.name;

  console.log(`[Smoke Test] Validating package distribution for ${packageJson.name}@${expectedVersion}...`);

  // 1. Validate package contents via npm pack --dry-run --json
  const dryRunOutput = execSync("npm pack --dry-run --json", {
    cwd: rootDir,
    encoding: "utf-8",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let packData: any;
  let searchIdx = 0;
  while (searchIdx < dryRunOutput.length) {
    const startBracket = dryRunOutput.indexOf("[", searchIdx);
    if (startBracket === -1) break;
    const endBracket = dryRunOutput.lastIndexOf("]");
    if (endBracket > startBracket) {
      try {
        const candidate = dryRunOutput.slice(startBracket, endBracket + 1);
        packData = JSON.parse(candidate);
        break;
      } catch {
        searchIdx = startBracket + 1;
      }
    } else {
      break;
    }
  }

  if (!packData || !Array.isArray(packData) || packData.length === 0) {
    throw new Error(`Could not parse JSON payload from npm pack output:\n${dryRunOutput}`);
  }

  const filesList: string[] = (packData[0]?.files ?? []).map((f: { path: string }) => f.path);

  console.log("[Smoke Test] Package files to be published:");
  for (const f of filesList) {
    console.log(`  - ${f}`);
  }

  // Verify essential files are included
  assert.ok(filesList.includes("bin/cli.js"), "Payload must contain bin/cli.js");
  assert.ok(filesList.includes("dist/index.js"), "Payload must contain dist/index.js");
  assert.ok(filesList.includes("dist/cli.js"), "Payload must contain dist/cli.js");
  assert.ok(
    filesList.includes("dist/workers/compute.worker.js"),
    "Payload must contain dist/workers/compute.worker.js"
  );
  assert.ok(filesList.includes("package.json"), "Payload must contain package.json");
  assert.ok(filesList.includes("README.md"), "Payload must contain README.md");
  assert.ok(filesList.includes("LICENSE"), "Payload must contain LICENSE");

  // Verify prohibited files/folders are NOT included
  for (const f of filesList) {
    assert.ok(!f.startsWith("src/"), `src/ file ${f} must not be in tarball payload`);
    assert.ok(!f.startsWith("tests/"), `tests/ file ${f} must not be in tarball payload`);
    assert.ok(!f.startsWith("scripts/"), `scripts/ file ${f} must not be in tarball payload`);
    assert.ok(!f.startsWith(".github/"), `.github/ file ${f} must not be in tarball payload`);
  }

  // 2. Build tarball
  console.log("[Smoke Test] Creating tarball via npm pack...");
  const packOutput = execSync("npm pack", {
    cwd: rootDir,
    encoding: "utf-8",
  }).trim();

  const packLines = packOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const packFilename = packLines[packLines.length - 1];
  const tarballPath = path.resolve(rootDir, packFilename);
  assert.ok(fs.existsSync(tarballPath), `Tarball must exist at ${tarballPath}`);

  // 3. Create isolated temporary directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-smoke-test-"));
  console.log(`[Smoke Test] Isolated testing in temporary directory: ${tempDir}`);

  try {
    // 4. Initialize minimal package.json in temp directory
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "mcp-smoke-consumer",
          version: "1.0.0",
          private: true,
          type: "module",
        },
        null,
        2
      )
    );

    // 5. Install the packed tarball
    console.log(`[Smoke Test] Installing tarball into isolated consumer...`);
    execSync(`npm install "${tarballPath}" --silent`, {
      cwd: tempDir,
      stdio: "pipe",
    });

    // 6. Find installed CLI binary
    const isWindows = process.platform === "win32";
    const binFileName = isWindows ? `${binName}.cmd` : binName;
    const installedBinPath = path.join(tempDir, "node_modules", ".bin", binFileName);

    assert.ok(
      fs.existsSync(installedBinPath),
      `Installed binary must exist at ${installedBinPath}`
    );

    // 7. Test installed binary with --version
    console.log(`[Smoke Test] Running installed binary --version...`);
    const versionOutput = execSync(`"${installedBinPath}" --version`, {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    assert.equal(
      versionOutput,
      expectedVersion,
      `Installed binary version (${versionOutput}) must match package.json (${expectedVersion})`
    );
    console.log(`[Smoke Test] Installed binary version validated: ${versionOutput}`);

    // 8. Test installed binary with --list-tools
    console.log(`[Smoke Test] Running installed binary --list-tools...`);
    const listToolsOutput = execSync(`"${installedBinPath}" --list-tools`, {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    const expectedDefault = `Profile: safe\n\necho\nping`;
    assert.equal(
      listToolsOutput.replace(/\r\n/g, "\n"),
      expectedDefault,
      `Installed binary --list-tools must output default safe profile tools`
    );
    console.log(`[Smoke Test] Installed binary default --list-tools validated successfully.`);

    // 9. Inspect installed package.json metadata (mcpName invariant)
    const installedPackageJsonPath = path.join(
      tempDir,
      "node_modules",
      packageJson.name,
      "package.json"
    );
    assert.ok(fs.existsSync(installedPackageJsonPath), "Installed package.json must exist");
    const installedPackageJson = JSON.parse(fs.readFileSync(installedPackageJsonPath, "utf-8"));
    assert.equal(
      installedPackageJson.mcpName,
      "io.github.AnIayana/high-performance-mcp-server",
      "Installed package.json must contain verified mcpName"
    );
    assert.equal(
      installedPackageJson.name,
      "high-performance-mcp-server",
      "Installed package.json name must match"
    );
    assert.equal(
      installedPackageJson.version,
      expectedVersion,
      "Installed package.json version must match"
    );
    console.log(`[Smoke Test] Installed package mcpName metadata validated: ${installedPackageJson.mcpName}`);

    // 10. Test programmatic root library usage (JavaScript ESM)
    console.log(`[Smoke Test] Testing programmatic library imports from installed package (JavaScript ESM)...`);
    const testConsumerScript = `
import * as pkg from "${packageJson.name}";
import { createServer, resolveWorkspaceConfig } from "${packageJson.name}";
import assert from "node:assert/strict";

// Verify public functions
assert.equal(typeof pkg.createServer, "function", "createServer must be exported");
assert.equal(typeof pkg.resolveWorkspaceConfig, "function", "resolveWorkspaceConfig must be exported");
assert.equal(typeof createServer, "function", "named createServer must be exported");
assert.equal(typeof resolveWorkspaceConfig, "function", "named resolveWorkspaceConfig must be exported");

// Verify internal functions are NOT exported
assert.equal(pkg.closeWorkerPool, undefined, "closeWorkerPool must not be exported");
assert.equal(pkg.createWorkspaceOperatorPolicy, undefined, "createWorkspaceOperatorPolicy must not be exported");
assert.equal(pkg.createNetworkOperatorPolicy, undefined, "createNetworkOperatorPolicy must not be exported");
assert.equal(pkg.createNetworkCachePolicy, undefined, "createNetworkCachePolicy must not be exported");
assert.equal(pkg.createHttpTransportServer, undefined, "createHttpTransportServer must not be exported");
assert.equal(pkg.startHttpTransport, undefined, "startHttpTransport must not be exported");
assert.equal(pkg.startStdioTransport, undefined, "startStdioTransport must not be exported");

// Verify factory and lifecycle
const server = createServer();
assert.ok(server, "createServer() must return server instance");
await server.close();

// Verify deep import without exports map works
const deepModule = await import("${packageJson.name}/dist/index.js");
assert.equal(typeof deepModule.createServer, "function", "Deep import dist/index.js must resolve");

console.log("[Programmatic Smoke] All programmatic assertions passed.");
`;

    fs.writeFileSync(path.join(tempDir, "consumer-test.mjs"), testConsumerScript);
    const progOut = execSync(`node consumer-test.mjs`, {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    assert.ok(
      progOut.includes("[Programmatic Smoke] All programmatic assertions passed."),
      "Programmatic smoke test script must pass cleanly"
    );
    console.log(`[Smoke Test] Programmatic JS library usage validated successfully.`);

    // 11. Test TypeScript NodeNext consumer typechecking (Section 35)
    console.log(`[Smoke Test] Testing TypeScript NodeNext consumer with installed package...`);
    const tsConsumerScript = `
import {
  createServer,
  resolveWorkspaceConfig,
  type CreateServerOptions,
  type ToolProfile,
  type WorkspaceConfig,
  type WorkspaceRoot,
} from "${packageJson.name}";
import type { McpServer } from "@modelcontextprotocol/server";

const profile: ToolProfile = "safe";
const opts: CreateServerOptions = { profile };
const server: McpServer = createServer(opts);
await server.close();

const config: WorkspaceConfig = await resolveWorkspaceConfig(["."]);
const roots: readonly WorkspaceRoot[] = config.roots;
if (roots.length > 0) {
  const r: WorkspaceRoot = roots[0];
  void r.id;
  void r.name;
  void r.path;
  void r.realPath;
}
`;
    fs.writeFileSync(path.join(tempDir, "consumer-test.ts"), tsConsumerScript);
    const tsConfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["consumer-test.ts"],
    };
    fs.writeFileSync(path.join(tempDir, "tsconfig.json"), JSON.stringify(tsConfig, null, 2));

    const tscBin = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
    try {
      execSync(`node "${tscBin}" --project tsconfig.json`, {
        cwd: tempDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      console.error("[Smoke Test] TSC stdout:", e.stdout);
      console.error("[Smoke Test] TSC stderr:", e.stderr);
      throw err;
    }
    console.log(`[Smoke Test] TypeScript NodeNext compilation validated successfully.`);

    // 12. Test installed binary in HTTP mode with /healthz probe
    console.log(`[Smoke Test] Testing installed binary with --transport=http and /healthz probe...`);
    const { spawn } = await import("node:child_process");
    const net = await import("node:net");

    const testPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() => reject(new Error("Could not acquire ephemeral port")));
        }
      });
      srv.on("error", reject);
    });

    const cliScriptPath = path.join(tempDir, "node_modules", packageJson.name, "dist", "cli.js");
    const httpChild = spawn(
      process.execPath,
      [cliScriptPath, "--transport=http", `--port=${testPort}`],
      {
        cwd: tempDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for HTTP server to start"));
        }, 10000);

        httpChild.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          if (text.includes("[MCP HTTP] Listening on")) {
            clearTimeout(timeout);
            resolve();
          }
        });

        httpChild.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        httpChild.on("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Server child exited prematurely with code ${code}`));
        });
      });

      // Probe GET /healthz
      const healthRes = await fetch(`http://127.0.0.1:${testPort}/healthz`);
      assert.equal(healthRes.status, 200, "Packed CLI /healthz must return 200");
      assert.equal(
        healthRes.headers.get("content-type"),
        "application/json; charset=utf-8",
        "Packed CLI /healthz Content-Type must match"
      );
      assert.equal(
        healthRes.headers.get("cache-control"),
        "no-store",
        "Packed CLI /healthz Cache-Control must match"
      );
      const healthBody = await healthRes.text();
      assert.equal(healthBody, '{"status":"ok"}', "Packed CLI /healthz body must match");

      // Probe /mcp route exists and is serviced by MCP handler
      const mcpRes = await fetch(`http://127.0.0.1:${testPort}/mcp`);
      assert.notEqual(mcpRes.status, 404, "Packed CLI /mcp must be handled by MCP handler");

      // Probe /readyz returns 404
      const readyRes = await fetch(`http://127.0.0.1:${testPort}/readyz`);
      assert.equal(readyRes.status, 404, "Packed CLI /readyz must return 404");
    } finally {
      await new Promise<void>((resolve) => {
        httpChild.on("exit", () => resolve());
        httpChild.kill("SIGTERM");
        setTimeout(() => {
          try {
            httpChild.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 3000);
      });
    }
    console.log(`[Smoke Test] Installed binary HTTP /healthz validated successfully.`);
  } finally {
    // 11. Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup error
    }
    try {
      if (fs.existsSync(tarballPath)) {
        fs.unlinkSync(tarballPath);
      }
    } catch {
      // ignore tarball cleanup error
    }
  }

  console.log(`[Smoke Test] All package distribution smoke tests passed successfully!`);
}

runPackageSmokeTest().catch((error) => {
  console.error(`[Smoke Test Failed] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});

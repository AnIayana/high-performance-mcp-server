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
      "io.github.eminyilmz/high-performance-mcp-server",
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
  } finally {
    // 10. Cleanup
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

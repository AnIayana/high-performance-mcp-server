import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const ALLOWED_PACKAGE_FILES: ReadonlySet<string> = new Set([
  "LICENSE",
  "README.md",
  "bin/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/workers/compute.worker.d.ts",
  "dist/workers/compute.worker.js",
  "dist/workers/compute.worker.js.map",
  "package.json",
]);

const FORBIDDEN_HOST_STRINGS: readonly string[] = [
  "Alagros",
  "antigravity-ide",
  "scratch\\high-performance-mcp-server",
  "scratch/high-performance-mcp-server",
];

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "PEM Private Key", regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/ },
  { name: "GitHub Personal Access Token (classic)", regex: /\bghp_[A-Za-z0-9_]{36,}\b/ },
  { name: "GitHub Fine-Grained Personal Access Token", regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/ },
  { name: "NPM Access Token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

async function runPackageSecurityCheck(): Promise<void> {
  console.log("[Security Check] Scanning npm package distribution payload...");

  // 1. Get package payload file list from npm pack --dry-run --json
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

  // 2. Validate all files against allowed whitelist
  for (const file of filesList) {
    assert.ok(
      ALLOWED_PACKAGE_FILES.has(file),
      `Unexpected file in package payload: "${file}". Only distribution files are allowed.`
    );
  }

  // 3. Scan runtime files for host machine leakage and secret patterns
  const filesToInspect = filesList.filter((f) => f.startsWith("dist/") || f.startsWith("bin/") || f === "package.json");

  for (const relativeFile of filesToInspect) {
    const filePath = path.join(rootDir, relativeFile);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");

    // Check host machine paths
    for (const forbidden of FORBIDDEN_HOST_STRINGS) {
      if (content.includes(forbidden)) {
        throw new Error(
          `Privacy Violation: Development host string "${forbidden}" found in packaged file: ${relativeFile}`
        );
      }
    }

    // Check secret patterns
    for (const secret of SECRET_PATTERNS) {
      if (secret.regex.test(content)) {
        throw new Error(
          `Security Violation: Secret pattern detected in packaged file: ${relativeFile} (Pattern: ${secret.name})`
        );
      }
    }
  }

  console.log(`[Security Check] Inspected ${filesToInspect.length} runtime distribution files.`);
  console.log("[Security Check] Package payload security and privacy scan passed successfully!");
}

runPackageSecurityCheck().catch((err) => {
  console.error(`[Security Check Failed] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

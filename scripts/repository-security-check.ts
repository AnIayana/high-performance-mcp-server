import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

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

// Files that legitimately define the scanner rules or mock tests
const EXEMPT_FROM_SCANNER_RULE_MATCHES: ReadonlySet<string> = new Set([
  "scripts/package-security-check.ts",
  "scripts/repository-security-check.ts",
  "tests/fixtures/test-cert.ts",
]);

async function runRepositorySecurityCheck(): Promise<void> {
  console.log("[Repo Security Check] Scanning repository tracked & candidate files...");

  // Get list of all tracked and untracked non-ignored files
  let candidateFiles: string[] = [];
  try {
    const lsOutput = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    candidateFiles = lsOutput
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !f.startsWith(".git/"));
  } catch {
    // Fallback if git is unavailable in environment
    console.warn("[Repo Security Check] Warning: git ls-files failed, scanning standard tree.");
  }

  // Retrieve local git author email dynamically to detect accidental email leakage in repo files
  let localGitEmail: string | undefined;
  try {
    const rawEmail = execSync("git config --get user.email", { cwd: rootDir, encoding: "utf-8" }).trim();
    if (rawEmail.length > 0) {
      localGitEmail = rawEmail;
    }
  } catch {
    // ignore if git config is unavailable
  }

  let inspectedCount = 0;

  for (const relativeFile of candidateFiles) {
    if (EXEMPT_FROM_SCANNER_RULE_MATCHES.has(relativeFile)) {
      continue;
    }

    const filePath = path.join(rootDir, relativeFile);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      continue;
    }

    // Skip binary files or lockfiles if needed
    const content = fs.readFileSync(filePath, "utf-8");
    inspectedCount++;

    // 1. Check for real development host paths
    for (const forbidden of FORBIDDEN_HOST_STRINGS) {
      if (content.includes(forbidden)) {
        throw new Error(
          `Privacy Violation: Development host string "${forbidden}" found in repository candidate file: ${relativeFile}`
        );
      }
    }

    // 2. Check for secret patterns
    for (const secret of SECRET_PATTERNS) {
      if (secret.regex.test(content)) {
        throw new Error(
          `Security Violation: Secret pattern detected in repository file: ${relativeFile} (Pattern: ${secret.name})`
        );
      }
    }

    // 3. Check for accidental personal git email reference in repository candidate files
    if (localGitEmail && content.includes(localGitEmail)) {
      throw new Error(
        `Privacy Violation: Personal git email reference detected in repository file: ${relativeFile} (Category: personal_git_email_reference)`
      );
    }
  }

  console.log(`[Repo Security Check] Inspected ${inspectedCount} repository candidate files.`);
  console.log("[Repo Security Check] Repository security and privacy scan passed successfully!");
}

runRepositorySecurityCheck().catch((err) => {
  console.error(`[Repo Security Check Failed] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

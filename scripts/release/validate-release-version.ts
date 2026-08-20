import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXPECTED_PACKAGE_NAME = "high-performance-mcp-server";
export const EXPECTED_MCP_NAME = "io.github.eminyilmz/high-performance-mcp-server";
export const EXPECTED_REPO_URL = "https://github.com/eminyilmz/high-performance-mcp-server";

// Strict SemVer format: X.Y.Z without leading v, without leading zeros, without suffixes
const STRICT_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ValidationResult {
  readonly valid: boolean;
  readonly version: string;
  readonly expectedTag: string;
  readonly errors: readonly string[];
}

/**
 * Validates whether a version string satisfies strict SemVer format (X.Y.Z).
 */
export function validateSemVerFormat(rawVersion: string): { valid: boolean; normalized: string; error?: string } {
  if (typeof rawVersion !== "string" || rawVersion.trim().length === 0) {
    return { valid: false, normalized: "", error: "Version parameter must be a non-empty string." };
  }

  const trimmed = rawVersion.trim();

  if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
    return {
      valid: false,
      normalized: "",
      error: `Invalid version "${trimmed}": Version input must not have a leading 'v'. Expected format: X.Y.Z (e.g. "0.2.0").`,
    };
  }

  if (!STRICT_SEMVER_REGEX.test(trimmed)) {
    return {
      valid: false,
      normalized: "",
      error: `Invalid SemVer format "${trimmed}". Must strictly match X.Y.Z with non-negative integers and no leading zeros.`,
    };
  }

  return { valid: true, normalized: trimmed };
}

/**
 * Validates version metadata invariants between package.json and server.json.
 */
export function validateReleaseMetadataInvariants(
  pkgJson: Record<string, any>,
  srvJson: Record<string, any>,
  expectedVersion: string
): string[] {
  const errors: string[] = [];

  if (pkgJson.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(`package.json name mismatch: expected "${EXPECTED_PACKAGE_NAME}", received "${pkgJson.name}"`);
  }

  if (pkgJson.version !== expectedVersion) {
    errors.push(`package.json version mismatch: expected "${expectedVersion}", received "${pkgJson.version}"`);
  }

  if (pkgJson.mcpName !== EXPECTED_MCP_NAME) {
    errors.push(`package.json mcpName mismatch: expected "${EXPECTED_MCP_NAME}", received "${pkgJson.mcpName}"`);
  }

  if (srvJson.name !== EXPECTED_MCP_NAME) {
    errors.push(`server.json name mismatch: expected "${EXPECTED_MCP_NAME}", received "${srvJson.name}"`);
  }

  if (srvJson.version !== expectedVersion) {
    errors.push(`server.json version mismatch: expected "${expectedVersion}", received "${srvJson.version}"`);
  }

  if (srvJson.repository?.url !== EXPECTED_REPO_URL) {
    errors.push(`server.json repository.url mismatch: expected "${EXPECTED_REPO_URL}", received "${srvJson.repository?.url}"`);
  }

  const primaryPackage = srvJson.packages?.[0];
  if (!primaryPackage) {
    errors.push("server.json packages array is missing or empty.");
  } else {
    if (primaryPackage.identifier !== EXPECTED_PACKAGE_NAME) {
      errors.push(`server.json packages[0].identifier mismatch: expected "${EXPECTED_PACKAGE_NAME}", received "${primaryPackage.identifier}"`);
    }
    if (primaryPackage.version !== expectedVersion) {
      errors.push(`server.json packages[0].version mismatch: expected "${expectedVersion}", received "${primaryPackage.version}"`);
    }
    if (primaryPackage.transport?.type !== "stdio") {
      errors.push(`server.json packages[0].transport.type mismatch: expected "stdio", received "${primaryPackage.transport?.type}"`);
    }
  }

  return errors;
}

/**
 * Pure helper to validate that a tag commit matches the checked-out HEAD commit.
 */
export function validateTagCommitEquality(
  headCommit: string,
  tagCommit: string,
  expectedTag: string
): { valid: boolean; error?: string } {
  if (!headCommit || !tagCommit || headCommit !== tagCommit) {
    return {
      valid: false,
      error: `Git tag "${expectedTag}" points to commit ${tagCommit || "(none)"}, but workflow checked out ${headCommit || "(none)"}. Tag must match HEAD commit exactly.`,
    };
  }
  return { valid: true };
}

/**
 * Verifies that the release tag exists and resolves to the current Git HEAD commit.
 */
export function verifyGitTagForRelease(
  expectedTag: string,
  cwd: string = process.cwd()
): { valid: boolean; headCommit: string; tagCommit: string; error?: string } {
  try {
    const headCommit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    const tagCommit = execSync(`git rev-list -n 1 ${expectedTag}`, { cwd, encoding: "utf-8" }).trim();

    const equality = validateTagCommitEquality(headCommit, tagCommit, expectedTag);
    if (!equality.valid) {
      return {
        valid: false,
        headCommit,
        tagCommit,
        error: equality.error,
      };
    }

    return { valid: true, headCommit, tagCommit };
  } catch (err: any) {
    return {
      valid: false,
      headCommit: "",
      tagCommit: "",
      error: `Failed to resolve git tag "${expectedTag}": ${err.message || String(err)}`,
    };
  }
}

/**
 * CLI Runner for workflow invocation
 */
export function runReleaseValidation(options: {
  version: string;
  rootDir?: string;
  requireTag?: boolean;
}): ValidationResult {
  const rootDir = options.rootDir || process.cwd();
  const errors: string[] = [];

  const semverCheck = validateSemVerFormat(options.version);
  if (!semverCheck.valid) {
    return {
      valid: false,
      version: options.version,
      expectedTag: `v${options.version}`,
      errors: [semverCheck.error || "Invalid SemVer version format."],
    };
  }

  const version = semverCheck.normalized;
  const expectedTag = `v${version}`;

  // Read files
  const pkgPath = path.join(rootDir, "package.json");
  const srvPath = path.join(rootDir, "server.json");

  if (!fs.existsSync(pkgPath)) {
    errors.push(`package.json not found at ${pkgPath}`);
  }
  if (!fs.existsSync(srvPath)) {
    errors.push(`server.json not found at ${srvPath}`);
  }

  if (errors.length === 0) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const srv = JSON.parse(fs.readFileSync(srvPath, "utf-8"));
      const invariantErrors = validateReleaseMetadataInvariants(pkg, srv, version);
      errors.push(...invariantErrors);
    } catch (e: any) {
      errors.push(`Failed to parse metadata files: ${e.message}`);
    }
  }

  if (options.requireTag) {
    const tagCheck = verifyGitTagForRelease(expectedTag, rootDir);
    if (!tagCheck.valid) {
      errors.push(tagCheck.error || `Git tag check failed for ${expectedTag}`);
    }
  }

  return {
    valid: errors.length === 0,
    version,
    expectedTag,
    errors,
  };
}

// Direct execution via CLI
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const args = process.argv.slice(2);
  let rawVersion = "";
  let requireTag = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      rawVersion = args[i + 1];
      i++;
    } else if (args[i] === "--no-tag" || args[i] === "--dry-run") {
      requireTag = false;
    }
  }

  if (!rawVersion) {
    console.error("Usage: tsx scripts/release/validate-release-version.ts --version <X.Y.Z> [--no-tag]");
    process.exit(1);
  }

  const result = runReleaseValidation({ version: rawVersion, requireTag });
  if (!result.valid) {
    console.error("❌ Release Version Validation FAILED:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`✅ Release validation passed for version ${result.version} (Tag: ${result.expectedTag})`);
}

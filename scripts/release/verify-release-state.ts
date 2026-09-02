import process from "node:process";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DecideReleaseOptions {
  readonly dryRun: boolean;
  readonly npmPublished: boolean;
  readonly mcpRegistryPublished: boolean;
  readonly githubReleasePublished: boolean;
}

export type ReleaseActionStatus =
  | "dry_run_validation"
  | "already_completed"
  | "full_release"
  | "resume_from_registry"
  | "resume_from_release";

export interface ReleasePlan {
  readonly status: ReleaseActionStatus;
  readonly shouldPublishNpm: boolean;
  readonly shouldPublishMcpRegistry: boolean;
  readonly shouldCreateGitHubRelease: boolean;
  readonly message: string;
}

/**
 * Pure decision function to determine which release steps are needed.
 * In dryRun mode, returns "dry_run_validation" regardless of remote publication status.
 * In real mode, calculates idempotent resumption plan.
 */
export function decideReleaseAction(options: DecideReleaseOptions): ReleasePlan {
  const { dryRun, npmPublished, mcpRegistryPublished, githubReleasePublished } = options;

  if (dryRun) {
    return {
      status: "dry_run_validation",
      shouldPublishNpm: false,
      shouldPublishMcpRegistry: false,
      shouldCreateGitHubRelease: false,
      message: "Dry-run mode: executing full quality gate and validation without publishing.",
    };
  }

  if (npmPublished && mcpRegistryPublished && githubReleasePublished) {
    return {
      status: "already_completed",
      shouldPublishNpm: false,
      shouldPublishMcpRegistry: false,
      shouldCreateGitHubRelease: false,
      message: "Release is already completely published on npm, MCP Registry, and GitHub Releases.",
    };
  }

  if (npmPublished && mcpRegistryPublished && !githubReleasePublished) {
    return {
      status: "resume_from_release",
      shouldPublishNpm: false,
      shouldPublishMcpRegistry: false,
      shouldCreateGitHubRelease: true,
      message: "npm and MCP Registry are already published; resuming by creating GitHub Release.",
    };
  }

  if (npmPublished && !mcpRegistryPublished) {
    return {
      status: "resume_from_registry",
      shouldPublishNpm: false,
      shouldPublishMcpRegistry: true,
      shouldCreateGitHubRelease: true,
      message: "npm package is already published; resuming by publishing to MCP Registry and GitHub Releases.",
    };
  }

  return {
    status: "full_release",
    shouldPublishNpm: true,
    shouldPublishMcpRegistry: true,
    shouldCreateGitHubRelease: true,
    message: "Clean release: publishing to npm, MCP Registry, and GitHub Releases in sequence.",
  };
}

/**
 * Compatibility helper for existing callers.
 */
export function determineReleasePlan(state: {
  npmExists: boolean;
  mcpRegistryExists: boolean;
  githubReleaseExists: boolean;
  dryRun?: boolean;
}): ReleasePlan {
  return decideReleaseAction({
    dryRun: Boolean(state.dryRun),
    npmPublished: state.npmExists,
    mcpRegistryPublished: state.mcpRegistryExists,
    githubReleasePublished: state.githubReleaseExists,
  });
}

/**
 * Live remote checker querying npm, MCP Registry API, and GitHub CLI
 */
export async function checkLiveReleaseState(options: {
  packageName: string;
  mcpName: string;
  version: string;
  repo: string;
}): Promise<{ npmExists: boolean; mcpRegistryExists: boolean; githubReleaseExists: boolean }> {
  const { packageName, mcpName, version, repo } = options;

  // 1. Check npm
  let npmExists = false;
  try {
    const npmOut = execSync(`npm view ${packageName}@${version} version --json`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (npmOut && npmOut.includes(version)) {
      npmExists = true;
    }
  } catch {
    npmExists = false;
  }

  // 2. Check MCP Registry
  let mcpRegistryExists = false;
  try {
    const res = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(mcpName)}`);
    if (res.ok) {
      const data = (await res.json()) as any;
      const found = data.servers?.some((s: any) => s.server?.name === mcpName && s.server?.version === version);
      if (found) {
        mcpRegistryExists = true;
      }
    }
  } catch {
    mcpRegistryExists = false;
  }

  // 3. Check GitHub Release
  let githubReleaseExists = false;
  try {
    const ghOut = execSync(`gh release view v${version} --repo ${repo} --json tagName`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (ghOut && ghOut.includes(`v${version}`)) {
      githubReleaseExists = true;
    }
  } catch {
    githubReleaseExists = false;
  }

  return { npmExists, mcpRegistryExists, githubReleaseExists };
}

// CLI Runner
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const args = process.argv.slice(2);
  let version = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  if (!version) {
    console.error("Usage: tsx scripts/release/verify-release-state.ts --version <X.Y.Z> [--dry-run]");
    process.exit(1);
  }

  checkLiveReleaseState({
    packageName: "high-performance-mcp-server",
    mcpName: "io.github.AnIayana/high-performance-mcp-server",
    version,
    repo: "AnIayana/high-performance-mcp-server",
  }).then((state) => {
    const plan = decideReleaseAction({
      dryRun,
      npmPublished: state.npmExists,
      mcpRegistryPublished: state.mcpRegistryExists,
      githubReleasePublished: state.githubReleaseExists,
    });
    console.log(JSON.stringify({ state, plan }, null, 2));
  });
}

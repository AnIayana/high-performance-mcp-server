import process from "node:process";
import { getHelpText, getPackageVersion, parseCliArgs } from "./config/cli.js";
import { resolveWorkspaceConfig, type WorkspaceConfig } from "./config/workspace.js";
import { getToolsForProfile } from "./tools/index.js";
import { startHttpTransport } from "./transports/http.js";
import { startStdioTransport } from "./transports/stdio.js";

/**
 * CLI Entry point for High-Performance MCP Server.
 */
async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2), process.env);

  if (config.error) {
    process.stderr.write(`[Error] ${config.error}\n\n`);
    process.stderr.write(getHelpText());
    process.exit(1);
  }

  if (config.action === "help") {
    process.stdout.write(getHelpText());
    process.exit(0);
  }

  if (config.action === "version") {
    process.stdout.write(`${getPackageVersion()}\n`);
    process.exit(0);
  }

  if (config.action === "list-tools") {
    const tools = getToolsForProfile(config.profile);
    process.stdout.write(`Profile: ${config.profile}\n\n`);
    for (const tool of tools) {
      process.stdout.write(`${tool.meta.name}\n`);
    }
    process.exit(0);
  }

  // Resolve workspace roots if configured or if workspace/all profile is used
  let workspaceConfig: WorkspaceConfig | undefined;
  if (config.roots.length > 0) {
    try {
      workspaceConfig = await resolveWorkspaceConfig(config.roots);
    } catch (err) {
      process.stderr.write(
        `[Workspace Error] ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  }

  // Start selected transport
  if (config.transport === "http") {
    await startHttpTransport(
      config.port,
      config.profile,
      workspaceConfig,
      config.networkPolicy,
      config.networkCachePolicy
    );
  } else {
    await startStdioTransport(
      config.profile,
      workspaceConfig,
      config.networkPolicy,
      config.networkCachePolicy
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `[Fatal Server Error] ${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});

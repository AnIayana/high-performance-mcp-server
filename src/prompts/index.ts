import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "../core/server-context.js";
import registerExploreWorkspacePrompt from "./explore-workspace.js";
import registerFindAndExplainPrompt from "./find-and-explain.js";
import registerReviewFilePrompt from "./review-file.js";
import registerTraceSymbolPrompt from "./trace-symbol.js";

/**
 * Registers modular MCP prompts onto the McpServer instance.
 * Prompts are profile-aware and are only registered when the active profile
 * is "workspace", "workspace_write", or "all".
 */
export function registerPrompts(server: McpServer, context?: ServerContext): void {
  const profile = context?.profile ?? "safe";

  // Only expose workspace prompts for profiles with workspace read capability
  if (profile !== "workspace" && profile !== "workspace_write" && profile !== "all") {
    return;
  }

  registerExploreWorkspacePrompt(server, context);
  registerFindAndExplainPrompt(server, context);
  registerReviewFilePrompt(server, context);
  registerTraceSymbolPrompt(server, context);
}

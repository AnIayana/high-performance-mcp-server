import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import {
  assertPromptTextLength,
  formatUserDataBlock,
  type PromptMetadata,
  validatePromptRootId,
} from "./types.js";

export const promptMeta: PromptMetadata = {
  name: "explore_workspace",
  title: "Explore Workspace",
  description: "Guides the model through a focused exploration of an allowed workspace root",
};

export function buildExploreWorkspacePrompt(
  args: { rootId: string; goal?: string },
  context?: ServerContext
): string {
  validatePromptRootId(context, args.rootId);

  const goalSection = formatUserDataBlock("goal_data", args.goal);

  const promptText = `You are conducting a structured, read-only exploration of workspace root "${args.rootId}".

Recommended Exploration Strategy:
1. Discover directory structure or file targets using search_files with the validated root ID.
2. Search for relevant identifiers or keywords using search_text.
3. Inspect file metadata with file_info or read contents with read_text_file (or workspace://file resource) only for pertinent files.
4. Synthesize your findings clearly using root-relative paths.

Safety and Operating Rules:
- The workspace is strictly read-only. Do not attempt file creation, modification, or deletion.
- All file paths must remain relative to "${args.rootId}". Never guess or assume host machine paths.
- Only claim files were inspected if their content was returned by MCP tool or resource results.${goalSection}`;

  return assertPromptTextLength(promptText);
}

export default function registerExploreWorkspacePrompt(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerPrompt(
    promptMeta.name,
    {
      title: promptMeta.title,
      description: promptMeta.description,
      argsSchema: z.object({
        rootId: z.string().max(128).describe("The ID of the allowed workspace root (e.g. root-1)"),
        goal: z
          .string()
          .max(2000)
          .optional()
          .describe("Optional specific exploration objective or question"),
      }),
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildExploreWorkspacePrompt(args, context),
          },
        },
      ],
    })
  );
}

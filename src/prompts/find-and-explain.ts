import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import {
  assertPromptTextLength,
  createWorkspaceRootIdPromptSchema,
  formatUserDataBlock,
  type PromptMetadata,
  validatePromptRootId,
} from "./types.js";

export const promptMeta: PromptMetadata = {
  name: "find_and_explain",
  title: "Find and Explain",
  description:
    "Locates relevant files or code symbols using workspace search and explains their implementation",
};

export function buildFindAndExplainPrompt(
  args: { rootId: string; query: string },
  context?: ServerContext
): string {
  validatePromptRootId(context, args.rootId);

  const querySection = formatUserDataBlock("query_data", args.query);

  const promptText = `You are asked to locate, inspect, and explain code or configuration matching the search query provided in the data section below within workspace root "${args.rootId}".

Investigation Workflow:
1. Perform a literal text search using search_text with the validated root ID and the query specified in the <query_data> block below.
2. If filename matches are also relevant, run search_files with the validated root ID and the query specified in the <query_data> block below.
3. Inspect matching files with read_text_file to understand the implementation.
4. Explain how the matched feature or symbol is implemented, citing exact root-relative file paths and line numbers.

Important Constraints:
- Search operations use exact literal matching (regex is not supported).
- If results are truncated, narrow your search path or query instead of repeating identical broad searches.
- Do not make statements about file contents without reading the file via tool or resource results.${querySection}`;

  return assertPromptTextLength(promptText);
}

export default function registerFindAndExplainPrompt(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerPrompt(
    promptMeta.name,
    {
      title: promptMeta.title,
      description: promptMeta.description,
      argsSchema: z.object({
        rootId: createWorkspaceRootIdPromptSchema(context),
        query: z
          .string()
          .min(1)
          .max(256)
          .describe("The literal term, function name, or configuration key to locate and explain"),
      }),
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildFindAndExplainPrompt(args, context),
          },
        },
      ],
    })
  );
}

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
  name: "trace_symbol",
  title: "Trace Symbol",
  description:
    "Traces occurrences, definitions, and usages of a specific symbol or identifier across the workspace",
};

export function buildTraceSymbolPrompt(
  args: { rootId: string; symbol: string },
  context?: ServerContext
): string {
  validatePromptRootId(context, args.rootId);

  const symbolSection = formatUserDataBlock("symbol_data", args.symbol);

  const promptText = `You are tracking the definition, usage, and call sites of the symbol specified in the data section below across workspace root "${args.rootId}".

Trace Procedure:
1. Run search_text using the validated root ID and the symbol specified in the <symbol_data> block below.
2. If the symbol may correspond to a file or module name, also run search_files using the symbol specified in the <symbol_data> block below.
3. Inspect relevant match locations with read_text_file to identify the primary declaration and key call/usage sites.
4. Map out and summarize:
   - Defining location(s) with file path and line number
   - Consuming modules and usage contexts
   - Key dependencies and relationships

Important Considerations:
- Search uses literal string matching (not regex).
- If the symbol produces many matches, refine searches to specific directories or file extensions.
- Refer strictly to root-relative paths when presenting your trace findings.${symbolSection}`;

  return assertPromptTextLength(promptText);
}

export default function registerTraceSymbolPrompt(
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
        symbol: z
          .string()
          .min(1)
          .max(256)
          .describe("The function, class, variable, or configuration identifier to trace"),
      }),
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildTraceSymbolPrompt(args, context),
          },
        },
      ],
    })
  );
}

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
  name: "review_file",
  title: "Review File",
  description:
    "Performs a structured, read-only review of a specified text file within the workspace",
};

export function buildReviewFilePrompt(
  args: { rootId: string; path: string; focus?: string },
  context?: ServerContext
): string {
  validatePromptRootId(context, args.rootId);

  const pathSection = formatUserDataBlock("path_data", args.path);
  const focusSection = formatUserDataBlock("focus_data", args.focus);

  const promptText = `You are conducting a thorough review of the target file specified in the data section below within workspace root "${args.rootId}".

Review Procedure:
1. Inspect metadata using file_info with the validated root ID and the path specified in the <path_data> block below.
2. Read the file contents via read_text_file or the canonical workspace:///<rootId>/<path> resource for the path specified in the <path_data> block below.
3. If external references or callers need verification, search the codebase with search_text.
4. Provide structured observations organized by importance, highlighting clarity, maintainability, correctness, and potential edge cases.

Review Rules:
- If read_text_file reports truncated: true, acknowledge that only partial contents were reviewed.
- Keep observations grounded in actual file contents and root-relative references.
- All operations are read-only; suggest improvements clearly in text without executing mutations.${pathSection}${focusSection}`;

  return assertPromptTextLength(promptText);
}

export default function registerReviewFilePrompt(
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
        path: z.string().max(1024).describe("The root-relative path of the file to review"),
        focus: z
          .string()
          .max(1000)
          .optional()
          .describe("Optional review focus (e.g. security, performance, type safety, documentation)"),
      }),
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildReviewFilePrompt(args, context),
          },
        },
      ],
    })
  );
}

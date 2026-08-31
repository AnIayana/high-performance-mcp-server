import crypto from "node:crypto";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const MAX_DISPLAY_VALUE_LENGTH = 4096;

export const workspaceWriteConfirmationSchema = z.strictObject({
  confirm: z.boolean().describe("Approve this workspace mutation"),
});

export interface WorkspaceWriteConfirmationInput {
  operation: "create" | "overwrite" | "edit";
  rootId?: string;
  path: string;
  approvalKeyMaterial: unknown;
}

function quoteBounded(value: string): string {
  // Never truncate a target: a hidden suffix could mislead the reviewer.
  if (value.length > MAX_DISPLAY_VALUE_LENGTH) {
    throw new Error("Workspace confirmation target is too long to display safely.");
  }
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069<>&`]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function createConfirmationKey(input: WorkspaceWriteConfirmationInput): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      rootId: input.rootId,
      path: input.path,
      arguments: input.approvalKeyMaterial,
    }))
    .digest("hex")
    .slice(0, 24);
  return `workspace-write-${digest}`;
}

/**
 * Builds a bounded, control-character-safe operator prompt containing logical
 * workspace identifiers only. Callers must pass the validated logical target,
 * never its absolute host path. Content and hashes are deliberately excluded.
 */
export function createWorkspaceWriteConfirmationMessage(
  input: Pick<WorkspaceWriteConfirmationInput, "operation" | "rootId" | "path">
): string {
  const root = input.rootId?.trim() || "default configured root";
  return [
    `Approve workspace ${input.operation} operation?`,
    `rootId=${quoteBounded(root)}`,
    `path=${quoteBounded(input.path)}`,
    "No file changes occur unless this request is approved.",
  ].join(" ");
}

function confirmationError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Returns undefined when approval is present, otherwise a protocol-native
 * input_required result or a sanitized tool-level refusal.
 * The request key binds a compliant client's response to these arguments and
 * the resolved logical target; it is NOT an authentication token. Elicitation
 * responses are client-controlled and cannot prove a human approved them.
 */
export function requireWorkspaceWriteConfirmation(
  input: WorkspaceWriteConfirmationInput,
  inputResponses?: Record<string, unknown>
): InputRequiredResult | CallToolResult | undefined {
  const key = createConfirmationKey(input);
  const response = inputResponse(inputResponses, key);

  if (response.kind === "missing") {
    return inputRequired({
      inputRequests: {
        [key]: inputRequired.elicit({
          message: createWorkspaceWriteConfirmationMessage(input),
          // Form elicitation supports a restricted JSON Schema subset; keep
          // strict response validation in the separate Zod schema below.
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Approve this workspace mutation" } },
            required: ["confirm"],
          },
        }),
      },
    });
  }

  if (response.kind !== "elicit") {
    return confirmationError("Workspace write confirmation response was invalid; no file changes were made.");
  }

  if (response.action === "decline") {
    return confirmationError("Workspace write confirmation was declined; no file changes were made.");
  }

  if (response.action === "cancel") {
    return confirmationError("Workspace write confirmation was cancelled; no file changes were made.");
  }

  const accepted = acceptedContent(
    inputResponses,
    key,
    workspaceWriteConfirmationSchema
  );
  if (accepted?.confirm !== true) {
    return confirmationError("Workspace write confirmation was not granted; no file changes were made.");
  }

  return undefined;
}

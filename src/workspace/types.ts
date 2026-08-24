/**
 * Workspace Subsystem Types & Error Model.
 */

export type WorkspaceErrorCode =
  | "invalid_path"
  | "invalid_input"
  | "access_denied"
  | "not_found"
  | "missing_parent"
  | "already_exists"
  | "content_conflict"
  | "occurrence_mismatch"
  | "write_too_large"
  | "invalid_text_encoding"
  | "unsupported_file_type"
  | "invalid_hash"
  | "missing_expected_hash"
  | "write_not_enabled"
  | "workspace_error";

/**
 * Sanitized client-safe workspace security and operational error class.
 * Never leaks absolute server paths, temp filenames, or user directory structures.
 */
export class WorkspaceSecurityError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly internalDetail?: string;

  constructor(code: WorkspaceErrorCode, clientMessage: string, internalDetail?: string) {
    super(clientMessage);
    this.name = "WorkspaceSecurityError";
    this.code = code;
    this.internalDetail = internalDetail;
    Object.setPrototypeOf(this, WorkspaceSecurityError.prototype);
  }
}

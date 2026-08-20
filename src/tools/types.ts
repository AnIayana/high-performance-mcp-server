import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "../core/server-context.js";

/**
 * Valid tool classification categories for security profile filtering.
 */
export type ToolCategory = "safe" | "workspace" | "diagnostics" | "benchmark" | "admin";

export interface ToolMetadata {
  name: string;
  category: ToolCategory;
  description: string;
}

/**
 * Standard tool registration function signature accepting server and runtime context.
 */
export type ToolRegistrar = (server: McpServer, context?: ServerContext) => void;

export interface RegisteredToolDefinition {
  metadata: ToolMetadata;
  register: ToolRegistrar;
}

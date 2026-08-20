# Contributing to High-Performance MCP Server

Thank you for your interest in contributing to the **High-Performance Model Context Protocol (MCP) Server** project! We welcome contributions that help enhance performance, reliability, and security while maintaining a clean, modular architecture.

---

## 1. Prerequisites & Setup

- **Node.js**: `>= 22.0.0`
- **Package Manager**: `npm` (`npm ci` recommended)

### Clone & Install

```bash
git clone <repository-url>
cd high-performance-mcp-server
npm ci
```

---

## 2. Development Workflow & Commands

| Command | Purpose |
| :--- | :--- |
| `npm run generate` | Generates tool registry and build metadata |
| `npm run typecheck` | Validates TypeScript compilation (`tsc --noEmit`) |
| `npm test` | Runs all unit, security, search, instruction, and protocol test suites |
| `npm run build` | Builds bundled ESM executables with `tsup` |
| `npm run pack:check` | Verifies npm package payload (`npm pack --dry-run`) |
| `npm run security:package` | Scans package payload for whitelist conformance, secrets, and path privacy |
| `npm run smoke:package` | Performs end-to-end tarball install and execution test |

All quality gates (`typecheck`, `test`, `build`, `security:package`, `smoke:package`) must pass before submitting a pull request.

---

## 3. Tool Contribution Conventions

When creating or modifying an MCP tool in `src/tools/`:

1. **File Location**: Place tool implementation in `src/tools/<tool-name>.ts`.
2. **Metadata Export**: Every tool must export `toolMeta: ToolMetadata`:
   ```typescript
   import type { ToolMetadata } from "./types.js";

   export const toolMeta: ToolMetadata = {
     name: "my_tool",
     category: "workspace", // "safe" | "workspace" | "diagnostics" | "benchmark" | "admin"
     description: "Clear and concise explanation of what the tool does",
   };
   ```
3. **Default Registration Function**: Export default function accepting `McpServer`:
   ```typescript
   export default function registerMyTool(server: McpServer, context?: ServerContext): void {
     server.registerTool(toolMeta.name, { ... }, handler);
   }
   ```
4. **Never Edit Generated Files Manually**:
   - `src/tools/generated-registry.ts` and `src/generated/build-meta.ts` are automatically generated during build and pre-commit steps.
5. **Tool Categorization**:
   - `safe`: Lightweight, read-only utilities with zero access to host internals (e.g. echo, ping).
   - `workspace`: Read-only filesystem operations, search, and file inspection within allowlisted roots.
   - `diagnostics`: System inspection, performance metrics, and telemetry.
   - `benchmark`: CPU-intensive workloads or load tests.
   - `admin`: Mutating operations (e.g. resetting cache, purging metrics).

---

## 4. Workspace & Search Rules

When contributing to filesystem or workspace search capabilities:
1. **Iterative Traversal Only**: Never use unbounded call-stack recursion for filesystem walking. Use queue-based iterative traversal.
2. **Cancellation Support**: Always accept and verify `AbortSignal` throughout search and file reading loops.
3. **Hard Resource Limits**: Always enforce upper bounds for `maxResults`, `maxFiles`, `timeoutMs`, and `maxDepth`.
4. **Absolute Host Path Privacy**: Never serialize or expose absolute server filesystem paths (`C:\...`, `/home/...`). Only return logical root IDs and root-relative paths.
5. **No Symlink Directory Traversal**: Recursive directory traversal must skip directory symlinks/junctions to prevent recursion cycles and boundary escapes.
6. **Binary & Size Protection**: File reading services must check for binary content (NUL bytes) and reject/skip files exceeding 1 MiB.

---

## 5. Prompt Contribution Rules

When creating or modifying modular MCP prompts in `src/prompts/`:
1. **Use `server.registerPrompt()`**: Use official modern MCP v2 registration APIs with explicit Zod `argsSchema`.
2. **Template-Only Generation**: Prompts must only generate structured user/model message templates; prompts must **never execute direct I/O** or invoke filesystem services directly.
3. **No Raw Interpolation**: Never raw-interpolate user-controlled prompt arguments into instruction prose. Reference data blocks indirectly (e.g. "for the path specified in <path_data>").
4. **Use Shared Escaping**: Use `formatUserDataBlock()` to deterministically escape XML characters and label blocks as literal user task data, not server instructions.
5. **No Absolute Host Path Leaks**: Never include internal absolute host paths in generated prompt messages.
6. **Adversarial Tests Required**: New prompts must include unit tests verifying delimiter escaping and injection boundaries.

---

## 6. CLI & Configuration Rules

When modifying CLI parsing or configuration handling:
1. **Fail-Fast on Malformed Values**: Reject invalid options, malformed ports, or unsupported values with clear, descriptive error messages.
2. **No Silent Downgrades**: Unknown flags or syntax typos (e.g. `--profle=workspace`) must raise a configuration error rather than falling back silently.
3. **Positional Arguments**: Reject unexpected positional arguments with usage guidance.
4. **Duplicate Option Protection**: Reject duplicate singleton flags (`--profile`, `--transport`, `--port`).

---

## 7. Stdio Safety & Logging Rules

The MCP stdio transport communicates over standard input (`process.stdin`) and standard output (`process.stdout`).
- **Never call `console.log()`** or write raw data to `stdout` in server runtime paths.
- Use the structured logger in `src/core/logger.ts` or `console.error()`, which routes safely to `stderr`.

---

## 8. Cross-Platform Compatibility

- Use Node.js built-in `node:path` and `node:url` APIs for path resolution.
- Never hardcode OS-specific path separators (`\` or `/`) or machine-specific absolute paths.
- Ensure scripts and tests run cleanly on Linux, macOS, and Windows environments.

---

## 9. Testing Requirements

- Any bug fix or new capability must be accompanied by unit tests using Node.js built-in test runner (`node:test` and `node:assert/strict`).
- Avoid adding heavy third-party test dependencies.
- Ensure all test suites pass cleanly with `npm test`.

---

## 10. Pull Request Process

1. Create a descriptive feature branch from `main`.
2. Ensure `npm run typecheck`, `npm test`, `npm run security:package`, and `npm run smoke:package` pass.
3. Fill out the pull request template completely.
4. Maintain a clean commit history.

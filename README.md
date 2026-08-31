# High-Performance MCP Server

A high-performance, modular Model Context Protocol (MCP) server built with TypeScript and the modern MCP v2 SDK (`@modelcontextprotocol/server`). Features safe-by-default security profiles, profile-aware server instructions, modular MCP prompts, allowlisted workspace inspection with opt-in guarded text mutation, SSRF-hardened network access, Streamable HTTP, Stdio transport, reusable worker thread pooling, production LRU caching with single-flight stampede protection, and structured telemetry.

---

## Project Status: Public Preview (v0.3.0)

> [!NOTE]
> **Status**: `0.3.0` Public Preview.
> This package provides safe-by-default MCP tools, read-only workspace inspection, opt-in guarded workspace mutation and network access, and high-performance worker execution. Requires **Node.js >= 22.0.0**.

---

## Features

- **Modern MCP v2 Architecture**: Built natively on `@modelcontextprotocol/server` with standard JSON Schema draft 2020-12 validation and full 2026-07-28 protocol support.
- **Dual Transport Support**: Run seamlessly over standard input/output (`stdio`) or modern Streamable HTTP (`node:http` + `/mcp`).
- **Profile-Aware Server Instructions**: Dynamic server instructions that guide connected LLMs on recommended workflows, tool sequencing, and safety boundaries based on the active profile.
- **Modular MCP Prompts**: Reusable task prompts (`explore_workspace`, `find_and_explain`, `review_file`, `trace_symbol`) exposed exclusively in `workspace`, `workspace_write`, and `all` profiles.
- **MCP-Native Workspace Completions**: Autocompletes logical `rootId` values for every workspace prompt and the workspace resource template without enumerating files or exposing host paths.
- **Safe-by-Default Tool Profiles**: Default `safe` profile exposes zero filesystem, network, or hardware inspection. Filesystem mutation and outbound network access require explicit `workspace_write`/`network` (or `all`) opt-in.
- **Workspace Security & Host Path Privacy**: Secure allowlisted directory access with path traversal and symlink escape prevention, logical root mapping (`root-1`, `root-2`), bounded text operations, and binary file protection without exposing host absolute paths to clients or models. The `workspace` profile remains read-only; guarded mutation is isolated to `workspace_write` and `all`.
- **Workspace Search v1**: Fast, bounded literal file and text search (`search_files`, `search_text`) with ignored directory defaults, bounded concurrency, coordinate mapping, and client cancellation.
- **Worker Thread Pool**: Offload CPU-heavy tasks from the Node.js event loop with automatic lifecycle recovery and zero-drift invariants.
- **Production LRU Cache**: Memory-bounded cache with TTL support and single-flight request coalescing to eliminate cache stampedes.
- **Internal Structured Logging**: Stdio-safe JSON logging exclusively on `stderr`.

---

## Quick Start

### MCP Client Configuration (Claude Desktop, Cursor, etc.)

Add to your MCP configuration (e.g. `claude_desktop_config.json`):

#### Default Safe Profile (Stdio)
```json
{
  "mcpServers": {
    "high-performance-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "high-performance-mcp-server"
      ]
    }
  }
}
```

#### Read-Only Workspace Profile
```json
{
  "mcpServers": {
    "workspace-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "high-performance-mcp-server",
        "--profile=workspace",
        "--root=/path/to/project"
      ]
    }
  }
}
```

### Local Development / Source Execution

```bash
# Clone and build
git clone https://github.com/eminyilmz/high-performance-mcp-server.git
cd high-performance-mcp-server
npm install
npm run build

# Run default safe profile
node dist/index.js

# Run workspace profile with allowlisted root
node dist/index.js --profile=workspace --root=.
```

---

## Safe-by-Default Profiles

To protect host machines and prevent unintended resource consumption or metadata leakage, tools, resources, instructions, and prompts are categorized into security profiles:

| Profile | Included Categories | Exposed Tools | Prompts | Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **`safe`** *(Default)* | `safe` | `echo`, `ping` | *(none)* | Zero host inspection, zero filesystem access, zero mutation. Safe for public exposure. |
| **`workspace`** | `safe`, `workspace` | `echo`, `ping`, `workspace_roots`, `list_directory`, `file_info`, `read_text_file`, `search_files`, `search_text` | `explore_workspace`, `find_and_explain`, `review_file`, `trace_symbol` | Read-only file and directory inspection strictly limited to allowlisted `--root` directories. |
| **`workspace_write`** | `safe`, `workspace`, `workspace_write` | `echo`, `ping`, `workspace_roots`, `list_directory`, `file_info`, `read_text_file`, `search_files`, `search_text`, `write_text_file`, `edit_text_file` | `explore_workspace`, `find_and_explain`, `review_file`, `trace_symbol` | Guarded workspace text file creation, overwriting, and transactional editing with optimistic concurrency. |
| **`network`** | `safe`, `network` | `echo`, `ping`, `fetch_url` | *(none)* | SSRF-hardened, read-only HTTP/HTTPS web fetching for public resources. |
| **`diagnostics`** | `safe`, `diagnostics` | `echo`, `ping`, `cache_stats`, `server_metrics`, `system_stats`, `worker_pool_stats` | *(none)* | Process and system observability for monitoring health and event-loop lag. |
| **`benchmark`** | `safe`, `benchmark` | `echo`, `ping`, `cached_prime_count`, `heavy_compute_main`, `heavy_compute_worker` | *(none)* | CPU-intensive prime calculation benchmarks and worker pool tests. |
| **`admin`** | `safe`, `diagnostics`, `admin` | `echo`, `ping`, `cache_stats`, `server_metrics`, `system_stats`, `worker_pool_stats`, `reset_cache`, `reset_metrics` | *(none)* | Observability with administrative runtime state mutation (purging cache, resetting metrics). |
| **`all`** | `safe`, `workspace`, `workspace_write`, `network`, `diagnostics`, `benchmark`, `admin` | All 20 registered tools | All 4 workspace prompts | Complete tool and prompt catalog. |

---

## Server Instructions & Prompts

### Profile-Aware Server Instructions

When an MCP client connects, the server delivers concise, profile-tailored instructions via the MCP protocol:
- **`safe`**: Instructs the model that filesystem and hardware inspection are not available.
- **`workspace`**: Outlines the recommended investigation sequence (`workspace_roots` -> `search_files` / `search_text` -> `file_info` -> `read_text_file`), reinforces read-only constraints, and emphasizes root-relative path usage.
- **`diagnostics` & `benchmark`**: Guides observational metrics interpretation and warns against unnecessary CPU-intensive compute invocations.
- **`admin`**: Notes that mutation operations affect only process-local caches and telemetry state.

### Modular MCP Prompts

When running in `workspace`, `workspace_write`, or `all` profile, the server exposes modular prompts that provide structured workflows for common engineering tasks:

| Prompt | Arguments | Purpose |
| :--- | :--- | :--- |
| **`explore_workspace`** | `rootId` *(required)*, `goal` *(optional)* | Guides the model through structured exploration of an allowlisted workspace root using search and file inspection. |
| **`find_and_explain`** | `rootId` *(required)*, `query` *(required)* | Locates relevant code or configuration using literal text search and reads defining files to produce an explanation. |
| **`review_file`** | `rootId` *(required)*, `path` *(required)*, `focus` *(optional)* | Formulates a structured, read-only review of a specified text file within the workspace. |
| **`trace_symbol`** | `rootId` *(required)*, `symbol` *(required)* | Traces declarations, references, and usage sites of a symbol across the workspace. |

> [!NOTE]
> Prompt arguments are treated as bounded task data and escaped before being inserted into reusable MCP prompt templates. Prompts do **not** execute direct filesystem I/O themselves; actual file reading and searching is performed by the model using standard MCP tools and resources under strict root allowlist controls.

### Workspace Root Completions

Workspace-capable profiles advertise MCP's `completions` capability. Clients can request `completion/complete` suggestions for the `rootId` argument on all four workspace prompts and for the `rootId` variable in `workspace:///{rootId}/{+path}`. Suggestions contain only configured logical IDs such as `root-1`; they never enumerate files or reveal root names and absolute host paths. Profiles without workspace authority do not advertise completion support.

---

## Read-Only Workspace Access

Filesystem access is **disabled by default**. To enable read-only workspace access, explicitly specify `--profile=workspace` and at least one allowlisted `--root` directory. The broader `all` profile also includes these tools but additionally enables mutation, network, diagnostics, benchmark, and admin capabilities.

```bash
# POSIX / macOS / Linux
npx high-performance-mcp-server --profile=workspace --root=/home/user/my-project

# Windows
npx high-performance-mcp-server --profile=workspace --root="C:\Projects\app"

# Multiple roots
npx high-performance-mcp-server --profile=workspace --root=./packages/core --root=./packages/cli
```

### Security Guarantees & Constraints

- **Host Path Privacy**: Configured absolute filesystem paths remain internal to the server. The `workspace_roots` tool returns logical root identifiers (`id: "root-1"`, `name: "my-project"), and workspace resource URIs use those identifiers rather than absolute host paths:
  ```json
  {
    "roots": [
      {
        "id": "root-1",
        "name": "my-project"
      }
    ]
  }
  ```
- **Strict Allowlist**: Only explicitly passed `--root` directories can be accessed. Maximum 16 unique roots allowed (and max 64 raw paths before deduplication).
- **Read-Only Profile**: The standard `workspace` profile exposes no mutation tools. Guarded text mutation is available only through the explicit `workspace_write` and `all` profiles; no MCP tools expose deletion, arbitrary rename, directory creation, permission changes, or command execution.
- **Traversal & Symlink Protection**: Target paths are canonicalized using `fs.realpath` and strictly verified to never escape root boundaries.
- **Sanitized Errors**: Error responses reference only logical root IDs, root names, and requested relative paths, ensuring internal directory structures are never leaked.
- **File Read Limits**: Default text read limit is 256 KiB; hard upper limit is 1 MiB (`MAX_TEXT_READ_BYTES`).
- **Binary File Detection**: Files containing NUL bytes (`\0`) are rejected by `read_text_file` to prevent context pollution.
- **MCP Resources**: Exposes the canonical `workspace:///{rootId}/{+path}` (`workspace_text_file`) template. Discover logical roots with `workspace_roots`; `resources/list` does not recursively enumerate files.

### Searching the Workspace

The `workspace` profile provides bounded, read-only search tools:

1. **`search_files`**:
   - Searches file and directory names using literal substring matching.
   - Filters by kind (`file`, `directory`, `all`), case sensitivity, and start path.
   - Skips common build/vendor directories (`.git`, `node_modules`, `.next`, `dist`, `build`, `target`, etc.) by default. Pass `includeIgnored: true` to search them.
   - Never traverses into symlink/junction directories to prevent recursion cycles and escapes.
   - Streams native MCP progress notifications (`notifications/progress`) when a client `progressToken` is provided.

2. **`search_text`**:
   - Searches UTF-8 text files using bounded literal matching with fixed concurrency (8 workers).
   - Returns 1-based line, column, and trimmed preview snippets (up to 300 characters).
   - Supports file extension filters (e.g. `extensions: [".ts", ".md"]` or `extensions: ["ts", "md"]`).
   - Automatically skips binary files (NUL bytes) and files larger than 1 MiB (`MAX_SEARCH_FILE_BYTES`).
   - Limits: Hard defaults (`maxResults: 100` [max 500], `maxFiles: 5000` [max 50000], `timeoutMs: 10000` [max 30000]).
   - Fully cancellable via client `AbortSignal`.
   - Streams native MCP progress notifications (`notifications/progress`) when requested via `progressToken`. Zero progress overhead when unrequested.

---

## Guarded Workspace Text Write & Edit (`workspace_write`)

Workspace mutation is **disabled by default**. The standard `workspace` profile remains strictly read-only. To enable guarded text write and transactional editing capabilities, explicitly select the **`workspace_write`** profile (or `all`) along with at least one allowlisted `--root`:

```bash
# Start server with workspace write capabilities
npx high-performance-mcp-server --profile=workspace_write --root=./project --workspace-max-write-bytes=2097152
```

### Mutation Tools

> [!WARNING]
> When running with `--profile=all` or `--profile=workspace_write`, connected clients and LLMs have guarded text write and edit capabilities within configured `--root` directories. The standard `--profile=workspace` remains strictly read-only.

1. **`write_text_file`**:
   - **Create Mode** (`mode: "create"`): Creates a new UTF-8 text file inside an allowlisted workspace root. Enforces atomic no-clobber semantics via `fs.link` (or equivalent no-clobber publishing); fails safely if the file already exists (`already_exists`) or if the parent directory does not exist (`missing_parent`). Providing `expectedSha256` in create mode is forbidden.
   - **Overwrite Mode** (`mode: "overwrite"`): Strictly requires `expectedSha256` (64-character lowercase hex) matching the file's current SHA-256 hash. If the file was modified concurrently, throws `content_conflict` and aborts without touching the target file.
   - **Exclusive Temp & Atomic Replacement**: Creates an exclusive temporary file (`.mcp-temp-<uuid>.tmp`) in the target directory (`O_CREAT | O_EXCL`), flushes to disk (`fsync`), re-validates the target file type and hash, and atomically replaces the destination.

   ```json
   {
     "name": "write_text_file",
     "arguments": {
       "rootId": "root-1",
       "path": "src/config.json",
       "mode": "overwrite",
       "content": "{\n  \"version\": 2\n}\n",
       "expectedSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
     }
   }
   ```

2. **`edit_text_file`**:
   - **Exact Literal Replacement**: Performs targeted, sequential in-memory text replacements without regex or special token expansion (e.g. `$$`, `$1`, `$&`, `$\``, `$'` are inserted verbatim).
   - **Non-Overlapping Occurrence Guarantees**: Evaluates `expectedOccurrences` (default: 1) using non-overlapping literal matching matching the exact replacement semantics.
   - **Transactional Execution**: Applies all edits sequentially in memory. If any edit fails its `expectedOccurrences` check or if the file hash mismatches `expectedSha256`, the operation aborts and the disk file remains 100% untouched.
   - **Strict UTF-8 & BOM Preservation**: Non-UTF-8 binary files are rejected (`invalid_text_encoding`). Existing UTF-8 BOM headers and CRLF line endings are preserved with byte-for-byte fidelity.

   ```json
   {
     "name": "edit_text_file",
     "arguments": {
       "rootId": "root-1",
       "path": "src/index.ts",
       "expectedSha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
       "edits": [
         {
           "oldText": "const PORT = 3000;",
           "newText": "const PORT = 8080;",
           "expectedOccurrences": 1
         }
       ]
     }
   }
   ```

### Operator-Configurable Write Limits

Server operators can set strict hard caps on the maximum allowed write or edit payload size in bytes:
- CLI flag: `--workspace-max-write-bytes=<bytes>` (1 to 5,242,880 bytes / 5 MiB, default: `1048576` / 1 MiB)
- Environment variable: `MCP_WORKSPACE_MAX_WRITE_BYTES=<bytes>`

### Metadata & Concurrency Considerations

- **Atomic Replacement Metadata**: Atomic replacement creates a new filesystem entry, preserving POSIX permission bits (`0755`, `0644`) where supported. Other OS-specific metadata (e.g. inode number, creation timestamp `ctime`, ACL inheritance) may not be portably preserved.
- **Residual Concurrency Boundaries**: Pre-replace revalidation minimizes TOCTOU race conditions against untrusted MCP callers. However, a hostile local OS process with equivalent filesystem privileges executing concurrent writes in the microseconds after final validation may still race path-based operations.

### Optional Client-Mediated Write Confirmation (Unreleased)

Confirmation is **off by default**. Enable it for both mutation tools with the operator-only `--workspace-write-confirmation` flag, or `MCP_WORKSPACE_WRITE_CONFIRMATION=true` (`true`/`1`/`false`/`0`). The CLI flag enables confirmation even if the environment says `false`; tool arguments cannot disable it. No tools are added and profile access stays unchanged.

```bash
high-performance-mcp-server --profile=workspace_write --root=./project --workspace-write-confirmation
```

The server validates the target, then asks the client to show a form containing a `confirm` boolean. Only an accepted response with `confirm: true` proceeds. Decline, cancel, false, and malformed accepted content leave the file unchanged. No temporary file is created while approval is pending. The normal root, size, exact-edit, and SHA-256 checks still run after approval, including when a file changes during the prompt.

The prompt identifies the operation and canonical logical `rootId`/relative path; it does not display file content, expected hashes, root names, or absolute host paths. Control and bidirectional formatting characters are escaped. Targets over 4,096 characters are refused instead of silently truncated. Response keys include the proposed arguments and resolved logical target so a changed proposal asks again.

| Connection | Confirmation enabled |
| :--- | :--- |
| MCP `2026-07-28`, stdio or HTTP | Native `input_required` form elicitation |
| Legacy MCP, stdio | SDK compatibility shim uses `elicitation/create` |
| Legacy MCP, stateless HTTP | Refused: no reverse-request channel for approval |
| Client without form elicitation | Refused without a mutation |

With confirmation disabled, existing modern and legacy calls behave as before. Use a client that actually presents the form to a human: elicitation is a **client-mediated safeguard, not authentication or a security boundary against a malicious client**. The server cannot prove that a human approved a client-supplied response. Direct service-level embedding is also outside this MCP handler gate. For protocol details, see the [official SDK input-required guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md).

---

## MCP Workspace Resources

In addition to workspace inspection tools, this server natively exposes allowlisted workspace text files as standard **MCP Resources** using the official URI Template:

```
workspace:///{rootId}/{+path}
```

### Canonical Resource URI Format

Workspace resources use a stable, portable URI scheme based on logical root IDs rather than host filesystem paths:

- `workspace:///root-1/README.md`
- `workspace:///root-1/src/index.ts`
- `workspace:///root-2/docs/architecture.md`

Host absolute paths (such as `file:///C:/...` or `/home/...`) are **never** exposed in resource URIs, titles, or error messages.

### Resource Invariants & Security Guarantees

- **Profile Gated**: Workspace resources are exposed exclusively in workspace-capable profiles (`workspace`, `workspace_write`, `all`). In non-workspace profiles (`safe`, `network`, `diagnostics`, `benchmark`, `admin`), resource endpoints return `Method not found` and zero workspace existence is advertised.
- **Strict Read-Only**: Resources are strictly read-only. Possessing a resource URI never grants mutation rights or filesystem write capabilities.
- **Root & Symlink Confinement**: Resource reads reuse the central workspace security resolver, enforcing strict containment inside configured `--root` directories and blocking symlink/junction escapes.
- **Complete-or-Error Semantics**: Resources are never silently truncated. If a file exceeds the operator byte limit, the read is rejected with `resource_too_large`.
- **Strict UTF-8 & Text Only**: All resource content is decoded strictly as UTF-8 text (`fatal: true`). Files containing NUL bytes (`0x00`) or non-UTF-8 sequences are rejected as unsupported binary files (`invalid_text_encoding`).
- **No Recursive Enumeration**: `resources/templates/list` advertises the resource template (`workspace_text_file`). The server does **not** recursively crawl repository directories for `resources/list`, preventing latency, memory spikes, and information disclosure on large repositories.
- **Operator-Configurable Resource Size Limits**:
  - CLI flag: `--workspace-max-resource-bytes=<bytes>` (1 to 5,242,880 bytes / 5 MiB, default: `1048576` / 1 MiB)
  - Environment variable: `MCP_WORKSPACE_MAX_RESOURCE_BYTES=<bytes>`

### Recommended Client Workflow

1. **Discovery**: Discover available root IDs and paths using `workspace_roots`, `list_directory`, or `search_files`.
2. **Read Resource**: Consume text files directly via standard MCP `resources/read` using `workspace:///<rootId>/<path>`.
3. **Guarded Mutation**: When mutations are needed, use `read_text_file` to obtain the authoritative `sha256` hash and perform concurrency-controlled edits via `write_text_file` or `edit_text_file` in the `workspace_write` profile.

---

## Network Access & `fetch_url`

Network access is **disabled by default**. To enable SSRF-hardened read-only web fetching, run with `--profile=network` (or `--profile=all`):

```bash
# Start server with opt-in network profile
npx high-performance-mcp-server --profile=network
```

### `fetch_url` Tool Details

The `fetch_url` tool performs a strictly bounded, read-only HTTP/HTTPS GET request to public web resources.

```json
{
  "name": "fetch_url",
  "arguments": {
    "url": "https://raw.githubusercontent.com/modelcontextprotocol/specification/main/LICENSE",
    "maxBytes": 1048576,
    "timeoutMs": 10000
  }
}
```

### Security Guarantees & Constraints

- **Multi-Layered SSRF Defense**: All resolved IP addresses are evaluated against standard IPv4/IPv6 private and special-use subnets (`net.BlockList`). Loopback (`127.0.0.0/8`, `::1`), private RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, `fe80::/10`), carrier-grade NAT (`100.64.0.0/10`), cloud metadata (`169.254.169.254`, `metadata.google.internal`), unique-local IPv6 (`fc00::/7`), multicast, and IPv4-mapped IPv6 (`::ffff:x.x.x.x`) destinations are strictly blocked.
- **Authoritative Socket Lookup (DNS Rebinding Prevention)**: Connection sockets use a dedicated, security-aware lookup hook ensuring TCP sockets connect *only* to verified public IP addresses, eliminating time-of-check to time-of-use (TOCTOU) DNS rebinding.
- **Allowed Port Allowlist**: Strictly limited to standard public web ports: `80`, `443`, `8080`, and `8443`.
- **Manual Redirect Re-validation**: Up to 5 redirects (`301`, `302`, `303`, `307`, `308`) are manually followed. Every intermediate target is re-validated against full URL, port, and IP security policies. HTTPS-to-HTTP downgrade redirects are rejected.
- **Zero IP Disclosure**: Error messages returned to clients never leak internal IP addresses, local socket details, or DNS topologies.
- **Bounded Resource Usage**: Streaming response reader buffers only up to requested `maxBytes` (default 1 MiB, hard maximum 5 MiB). If payload exceeds limit, `truncated: true` is returned and the stream is immediately destroyed.
- **Strict Textual Decoding**: Decodes exclusively textual MIME types (`text/*`, `application/json`, `application/xml`, `application/javascript`, `application/xhtml+xml`, `application/yaml`) with fatal UTF-8 decoding (`new TextDecoder("utf-8", { fatal: true })`). Binary bodies and explicit non-UTF-8 encodings are rejected.
### Operator-Configurable Egress Policy

Server operators can enforce additional deployment-level egress policies to restrict outbound network capabilities:

1. **Allowed Hostname Patterns (`--network-allow-host`, `MCP_NETWORK_ALLOW_HOSTS_JSON`)**:
   - Limits network egress exclusively to specified exact hostnames (`example.com`) or subdomain wildcards (`*.githubusercontent.com`).
   - Repeatable on CLI or specified as a JSON string array in environment variables.
   - If configured, any unlisted host is rejected with `host_not_allowed` ("Destination hostname is not allowed by server network policy.").

2. **Denied Hostname Patterns (`--network-deny-host`, `MCP_NETWORK_DENY_HOSTS_JSON`)**:
   - Explicitly blocks specified hostnames or subdomain wildcards.
   - **Deny takes strict precedence over allow**: If a destination matches both allow and deny patterns, it is rejected with `host_denied` ("Destination hostname is denied by server network policy.").

3. **HTTPS-Only Mode (`--network-https-only`, `MCP_NETWORK_HTTPS_ONLY`)**:
   - Enforces encrypted HTTPS for all outbound requests. Any `http://` initial target or redirect destination is rejected with `https_required` ("HTTPS is required by server network policy.").

4. **Operator Resource Caps**:
   - **`--network-max-response-bytes`** (`MCP_NETWORK_MAX_RESPONSE_BYTES`): Clamps the maximum response size (1 to 5,242,880 bytes).
   - **`--network-max-timeout-ms`** (`MCP_NETWORK_MAX_TIMEOUT_MS`): Clamps the maximum request timeout (1,000 to 30,000 ms).

> [!IMPORTANT]
> **Operator Restrictions Are Subtractive Only**: Operator configuration can never weaken or override built-in SSRF protections. Private IPs, loopback, link-local, carrier-grade NAT, and cloud metadata destinations remain strictly blocked even if listed in `--network-allow-host`.

### Conditional HTTP Response Cache

An optional, bounded, in-memory conditional cache can be enabled for `fetch_url` to reduce upstream bandwidth and latency for frequently accessed public HTTPS documents:

- **Flag**: `--network-cache` (`MCP_NETWORK_CACHE_ENABLED=true`)
- **Retention & Sizing Caps**:
  - `--network-cache-max-size-bytes=<n>` (`MCP_NETWORK_CACHE_MAX_SIZE_BYTES`): Logical max cache payload size (1 KiB to 64 MiB, default 16 MiB).
  - `--network-cache-max-entries=<n>` (`MCP_NETWORK_CACHE_MAX_ENTRIES`): Maximum cached entries (1 to 512, default 128).
  - `--network-cache-ttl-ms=<n>` (`MCP_NETWORK_CACHE_TTL_MS`): Retention TTL in ms (1,000 to 3,600,000 ms, default 300,000 ms / 5 minutes).
- **Mandatory Revalidation Invariant**: Cached entries are **never** served offline without revalidation. Every reuse sends conditional headers (`If-None-Match`, `If-Modified-Since`) to the origin over the full secure network transport (SSRF checks, DNS rebinding lookup, operator policy, and timeout deadline).
- **Zero Stale Fallback**: If the origin is unreachable, times out, or changes to a private IP, the error is immediately returned; stale cached content is never served.
- **Privacy-Preserving Keys**: Cache keys are opaque SHA-256 hashes of canonical HTTPS URLs. Plaintext URLs and authorization credentials are never stored.

---

## Command Line Interface (CLI)

```
Usage:
  high-performance-mcp-server [options]

Options:
  --transport=<stdio|http>       Transport protocol to run (default: stdio)
  --port=<number>                HTTP server port (default: 3000, only for http transport)
  --profile=<profile>            Security tool profile (default: safe)
  --root=<path>                  Allowlisted workspace root (repeatable, max 16)
  --workspace-max-write-bytes=<n> Operator hard cap for text write/edit size in bytes (1-5242880, default: 1048576)
  --workspace-max-resource-bytes=<n> Operator hard cap for resource read size in bytes (1-5242880, default: 1048576)
  --workspace-write-confirmation Require client-mediated confirmation before text write/edit operations
  --network-allow-host=<pattern> Allowlisted public hostname or *.domain pattern (repeatable, operator restriction)
  --network-deny-host=<pattern>  Denylisted hostname or *.domain pattern (repeatable, operator restriction)
  --network-https-only           Enforce HTTPS-only mode for all network requests (operator restriction)
  --network-max-response-bytes=<n> Operator hard cap for response size in bytes (1-5242880, default: 5242880)
  --network-max-timeout-ms=<n>   Operator hard cap for request timeout in ms (1000-30000, default: 30000)
  --network-cache                Enable conditional in-memory response cache for fetch_url (operator restriction)
  --network-cache-max-size-bytes=<n> Logical max cache payload size in bytes (1024-67108864, default: 16777216)
  --network-cache-max-entries=<n> Max cache entry count (1-512, default: 128)
  --network-cache-ttl-ms=<n>     Max cache retention TTL in ms (1000-3600000, default: 300000)
  --list-tools                   Display available tools for the active profile and exit
  --help, -h                     Show this help message and exit
  --version, -v                  Show version and exit
```

### Examples

```bash
# Start default safe server on stdio
high-performance-mcp-server

# Start with network profile, operator egress restrictions, and conditional cache
high-performance-mcp-server --profile=network \
  --network-allow-host=example.com \
  --network-allow-host="*.githubusercontent.com" \
  --network-https-only \
  --network-max-response-bytes=262144 \
  --network-max-timeout-ms=5000 \
  --network-cache \
  --network-cache-max-entries=256

# List tools available under the workspace profile
high-performance-mcp-server --profile=workspace --list-tools

# Run Streamable HTTP transport on port 8080 with workspace profile
high-performance-mcp-server --transport=http --port=8080 --profile=workspace --root=./project
```

---

## HTTP Transport Details

When started with `--transport=http`, the server launches a Streamable HTTP transport using Node.js built-in `node:http`:
- **Endpoint**: `http://127.0.0.1:<port>/mcp`
- **Security**: The server binds strictly to `127.0.0.1` and validates `Host` and `Origin` headers to protect against DNS rebinding and cross-site request forgery.
- **Warning**: Do not expose the HTTP transport directly to untrusted networks without an authenticating reverse proxy or gateway.

---

## Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `MCP_PROFILE` | `string` | `safe` | Default tool profile override (`safe`, `workspace`, `workspace_write`, `network`, `diagnostics`, `benchmark`, `admin`, `all`) |
| `PORT` | `number` | `3000` | Default HTTP port override (strict integer 1-65535) |
| `MCP_ROOTS_JSON` | `string` | *(none)* | JSON array of workspace roots (e.g. `["/home/user/project", "/home/user/docs"]`) |
| `MCP_WORKSPACE_WRITE_CONFIRMATION` | `boolean` | `false` | Require client-mediated write/edit approval (`true`/`1`/`false`/`0`) |
| `MCP_NETWORK_ALLOW_HOSTS_JSON` | `string` | *(none)* | JSON array of allowed public host patterns (e.g. `["example.com","*.githubusercontent.com"]`) |
| `MCP_NETWORK_DENY_HOSTS_JSON` | `string` | *(none)* | JSON array of denied host patterns (e.g. `["ads.example.com"]`) |
| `MCP_NETWORK_HTTPS_ONLY` | `boolean` | `false` | Enforce HTTPS-only mode for all network requests (`true`/`1`/`false`/`0`) |
| `MCP_NETWORK_MAX_RESPONSE_BYTES`| `number` | `5242880` | Operator response byte cap override (1 to 5242880) |
| `MCP_NETWORK_MAX_TIMEOUT_MS` | `number` | `30000` | Operator request timeout cap in ms override (1000 to 30000) |
| `MCP_NETWORK_CACHE_ENABLED` | `boolean` | `false` | Enable conditional in-memory response cache (`true`/`1`/`false`/`0`) |
| `MCP_NETWORK_CACHE_MAX_SIZE_BYTES`| `number` | `16777216`| Logical max cache payload size override in bytes (1024 to 67108864) |
| `MCP_NETWORK_CACHE_MAX_ENTRIES` | `number` | `128` | Max cache entries override (1 to 512) |
| `MCP_NETWORK_CACHE_TTL_MS` | `number` | `300000` | Max cache retention TTL override in ms (1000 to 3600000) |
| `MCP_WORKER_COUNT` | `number` | `4` | Number of worker threads spawned in the pool (1 to 16) |
| `MCP_CACHE_MAX_ENTRIES` | `number` | `256` | Maximum entries in the LRU compute cache (1 to 10000) |
| `MCP_CACHE_TTL_MS` | `number` | `300000` | LRU compute cache entry Time-to-Live in milliseconds (5 minutes) |

---

## Development

```bash
# Install dependencies
npm install

# Run code generator and TypeScript typecheck
npm run typecheck

# Execute unit, security, search, and modern protocol integration test suites
npm test

# Build production bundle
npm run build

# Validate npm package payload without publishing
npm run pack:check

# Run package payload security & privacy scan
npm run security:package

# Run end-to-end tarball installation smoke test
npm run smoke:package
```

---

## Architecture

```
MCP Clients (Claude Desktop, Cursor, Custom SDK Clients)
                       │
       ┌───────────────┴───────────────┐
       ▼                               ▼
  Stdio Transport             Streamable HTTP Transport
(process.stdin / stdout)         (127.0.0.1:3000/mcp)
       │                               │
       └───────────────┬───────────────┘
                       ▼
                McpServer Instance
      (Profile-Aware Server Instructions)
                       │
       ┌───────────────┴───────────────┐
       ▼                               ▼
  Tool & Prompt Profiles       Internal Telemetry
(safe, workspace, diag, ...)    (Metrics & Stderr Logger)
       │                               │
       ├──────► Read-Only Workspace, Search, Resources & Prompts (Allowlisted Roots, Host Privacy)
       │
       ├──────► In-Memory LRU Cache (Single-Flight Stampede Protection)
       │
       └──────► Reusable Worker Thread Pool (CPU Offloading)
```

---

## Security

- Default security profile (`safe`) ensures no filesystem or hardware inspection is exposed without explicit opt-in.
- Read-only workspace access strictly isolates file access to configured `--root` directories without revealing host filesystem absolute paths.
- Server instructions and prompts reinforce safe tool sequencing and explicit task boundaries with character escaping.
- Stdio transport reserves `stdout` exclusively for JSON-RPC messages; all internal debug and telemetry logs route to `stderr`.
- HTTP transport enforces strict localhost origin and host header validation.

For details, review [SECURITY.md](SECURITY.md).

---

## Contributing & Releases

Contributions and feedback are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on code style, tool development conventions, testing requirements, and the maintainer release workflow.

---

## License

This project is licensed under the [MIT License](LICENSE).

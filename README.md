# High-Performance MCP Server

A high-performance, modular Model Context Protocol (MCP) server built with TypeScript and the modern MCP v2 SDK (`@modelcontextprotocol/server`). Features safe-by-default security profiles, profile-aware server instructions, modular MCP prompts, read-only workspace access with search and host path privacy, Streamable HTTP, Stdio transport, reusable worker thread pooling, production LRU caching with single-flight stampede protection, and structured telemetry.

---

## Project Status: Public Preview (v0.1.0)

> [!NOTE]
> **Status**: `0.1.0` Public Preview.
> This package provides safe-by-default MCP tools, read-only workspace inspection, and high-performance worker execution. Requires **Node.js >= 22.0.0**.

---

## Features

- **Modern MCP v2 Architecture**: Built natively on `@modelcontextprotocol/server` with standard JSON Schema draft 2020-12 validation and full 2026-07-28 protocol support.
- **Dual Transport Support**: Run seamlessly over standard input/output (`stdio`) or modern Streamable HTTP (`node:http` + `/mcp`).
- **Profile-Aware Server Instructions**: Dynamic server instructions that guide connected LLMs on recommended workflows, tool sequencing, and safety boundaries based on the active profile.
- **Modular MCP Prompts**: Reusable task prompts (`explore_workspace`, `find_and_explain`, `review_file`, `trace_symbol`) exposed exclusively in `workspace` and `all` profiles.
- **Safe-by-Default Tool Profiles**: Default `safe` profile exposes zero filesystem or hardware inspection. Explicit opt-in for `workspace`, `diagnostics`, `benchmark`, `admin`, or `all`.
- **Read-Only Workspace & Host Path Privacy**: Secure allowlisted directory access with path traversal and symlink escape prevention, logical root mapping (`root-1`, `root-2`), 1 MiB hard limits, and binary file protection without exposing host absolute paths to clients or models.
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
| **`network`** | `safe`, `network` | `echo`, `ping`, `fetch_url` | *(none)* | SSRF-hardened, read-only HTTP/HTTPS web fetching for public resources. |
| **`diagnostics`** | `safe`, `diagnostics` | `echo`, `ping`, `cache_stats`, `server_metrics`, `system_stats`, `worker_pool_stats` | *(none)* | Process and system observability for monitoring health and event-loop lag. |
| **`benchmark`** | `safe`, `benchmark` | `echo`, `ping`, `cached_prime_count`, `heavy_compute_main`, `heavy_compute_worker` | *(none)* | CPU-intensive prime calculation benchmarks and worker pool tests. |
| **`admin`** | `safe`, `diagnostics`, `admin` | `echo`, `ping`, `cache_stats`, `server_metrics`, `system_stats`, `worker_pool_stats`, `reset_cache`, `reset_metrics` | *(none)* | Observability with administrative runtime state mutation (purging cache, resetting metrics). |
| **`all`** | `safe`, `workspace`, `network`, `diagnostics`, `benchmark`, `admin` | All 18 registered tools | All 4 workspace prompts | Complete tool and prompt catalog. |

---

## Server Instructions & Prompts

### Profile-Aware Server Instructions

When an MCP client connects, the server delivers concise, profile-tailored instructions via the MCP protocol:
- **`safe`**: Instructs the model that filesystem and hardware inspection are not available.
- **`workspace`**: Outlines the recommended investigation sequence (`workspace_roots` -> `search_files` / `search_text` -> `file_info` -> `read_text_file`), reinforces read-only constraints, and emphasizes root-relative path usage.
- **`diagnostics` & `benchmark`**: Guides observational metrics interpretation and warns against unnecessary CPU-intensive compute invocations.
- **`admin`**: Notes that mutation operations affect only process-local caches and telemetry state.

### Modular MCP Prompts

When running in `workspace` or `all` profile, the server exposes modular prompts that provide structured workflows for common engineering tasks:

| Prompt | Arguments | Purpose |
| :--- | :--- | :--- |
| **`explore_workspace`** | `rootId` *(required)*, `goal` *(optional)* | Guides the model through structured exploration of an allowlisted workspace root using search and file inspection. |
| **`find_and_explain`** | `rootId` *(required)*, `query` *(required)* | Locates relevant code or configuration using literal text search and reads defining files to produce an explanation. |
| **`review_file`** | `rootId` *(required)*, `path` *(required)*, `focus` *(optional)* | Formulates a structured, read-only review of a specified text file within the workspace. |
| **`trace_symbol`** | `rootId` *(required)*, `symbol` *(required)* | Traces declarations, references, and usage sites of a symbol across the workspace. |

> [!NOTE]
> Prompt arguments are treated as bounded task data and escaped before being inserted into reusable MCP prompt templates. Prompts do **not** execute direct filesystem I/O themselves; actual file reading and searching is performed by the model using standard MCP tools and resources under strict root allowlist controls.

---

## Read-Only Workspace Access

Filesystem access is **disabled by default**. To enable read-only workspace access, explicitly specify `--profile=workspace` (or `--profile=all`) and at least one allowlisted `--root` directory:

```bash
# POSIX / macOS / Linux
npx high-performance-mcp-server --profile=workspace --root=/home/user/my-project

# Windows
npx high-performance-mcp-server --profile=workspace --root="C:\Projects\app"

# Multiple roots
npx high-performance-mcp-server --profile=workspace --root=./packages/core --root=./packages/cli
```

### Security Guarantees & Constraints

- **Host Path Privacy**: Configured absolute filesystem paths remain internal to the server. The `workspace_roots` tool and `workspace://roots` resource return logical root identifiers (`id: "root-1"`, `name: "my-project"`) rather than absolute host paths:
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
- **Read-Only**: No filesystem mutation functions (`writeFile`, `unlink`, `rm`, `mkdir`, `rename`, etc.) exist in the server codebase.
- **Traversal & Symlink Protection**: Target paths are canonicalized using `fs.realpath` and strictly verified to never escape root boundaries.
- **Sanitized Errors**: Error responses reference only logical root IDs, root names, and requested relative paths, ensuring internal directory structures are never leaked.
- **File Read Limits**: Default text read limit is 256 KiB; hard upper limit is 1 MiB (`MAX_TEXT_READ_BYTES`).
- **Binary File Detection**: Files containing NUL bytes (`\0`) are rejected by `read_text_file` to prevent context pollution.
- **MCP Resources**: Exposes `workspace://roots` (static list of roots) and `workspace://file/{rootId}{?path}` (dynamic text reader).

### Searching the Workspace

The `workspace` profile provides bounded, read-only search tools:

1. **`search_files`**:
   - Searches file and directory names using literal substring matching.
   - Filters by kind (`file`, `directory`, `all`), case sensitivity, and start path.
   - Skips common build/vendor directories (`.git`, `node_modules`, `.next`, `dist`, `build`, `target`, etc.) by default. Pass `includeIgnored: true` to search them.
   - Never traverses into symlink/junction directories to prevent recursion cycles and escapes.

2. **`search_text`**:
   - Searches UTF-8 text files using bounded literal matching with fixed concurrency (8 workers).
   - Returns 1-based line, column, and trimmed preview snippets (up to 300 characters).
   - Supports file extension filters (e.g. `extensions: [".ts", ".md"]` or `extensions: ["ts", "md"]`).
   - Automatically skips binary files (NUL bytes) and files larger than 1 MiB (`MAX_SEARCH_FILE_BYTES`).
   - Limits: Hard defaults (`maxResults: 100` [max 500], `maxFiles: 5000` [max 50000], `timeoutMs: 10000` [max 30000]).
   - Fully cancellable via client `AbortSignal`.

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
  --root=<path>                  Allowlisted read-only workspace root (repeatable, max 16)
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
| `MCP_PROFILE` | `string` | `safe` | Default tool profile override (`safe`, `workspace`, `network`, `diagnostics`, `benchmark`, `admin`, `all`) |
| `PORT` | `number` | `3000` | Default HTTP port override (strict integer 1-65535) |
| `MCP_ROOTS_JSON` | `string` | *(none)* | JSON array of workspace roots (e.g. `["/home/user/project", "/home/user/docs"]`) |
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

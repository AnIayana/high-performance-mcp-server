# Security Policy

## Supported Versions

Only the latest published release of this project is actively supported with security fixes and updates.

| Version | Supported          |
| :---    | :---               |
| Latest  | :white_check_mark: |
| < Latest| :x:                |

---

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

- **Do NOT open a public GitHub issue** to disclose sensitive vulnerability details.
- Please use GitHub's **Private Vulnerability Reporting** feature on the repository to submit a confidential report.
- Provide clear reproduction steps, potential impact analysis, and suggested remediations if available.

---

## Security Model & Threat Considerations

### 1. Safe-by-Default Tool Profiles
By default, the server operates under the `safe` profile, exposing only harmless utilities (`echo`, `ping`).
- **`safe`**: Zero filesystem access, zero hardware metrics, zero mutation. Safe for public exposure.
- **`workspace`**: Explicit read-only filesystem inspection restricted to configured `--root` directories.
- **`diagnostics`**: Exposes host OS name, CPU model, uptime, and memory usage. Should only be enabled in trusted monitoring environments.
- **`benchmark`**: Executes heavy CPU prime calculations. When enabled, CPU consumption increases significantly.
- **`admin`**: Allows mutating server runtime state (such as clearing the LRU cache or resetting telemetry counters).

### 2. Workspace Profile Security & Risk Model
- **Explicit Opt-In**: The `workspace` profile is disabled by default and requires at least one `--root` directory.
- **Risk of File Exposure**: All files within configured workspace roots may be read by connected LLMs or MCP clients. **Never allowlist sensitive directories** (such as `/`, `C:\`, `/etc`, or entire user home directories `~`).
- **Strict Read-Only Enforcement**: The server contains no filesystem mutation capabilities (`writeFile`, `unlink`, `rm`, `mkdir`, `rename`, `chmod`, `exec`, `spawn`).
- **Path Traversal & Symlink Escape Guards**: Canonical path resolution (`fs.realpath`) verifies that requested paths and symlinks/junctions never escape the configured root boundaries.
- **Buffer & Context Exhaustion Limits**: Hard maximum file read limit is 1 MiB (`MAX_TEXT_READ_BYTES`), and binary files (containing NUL bytes) are automatically rejected.

### 3. Host Path Privacy
- **Logical Root Identifiers**: The server maps configured `--root` directories to logical identifiers (`root-1`, `root-2`, etc.) and sanitized directory names. Absolute configured host paths (`C:\...`, `/home/user/...`) are internal server configuration and are never serialized in `workspace_roots`, `search_files`, `search_text`, server instructions, prompts, or `workspace://roots` to MCP clients or LLMs.
- **Sanitized Error Responses**: All client-facing workspace errors are strictly sanitized to reference only logical root IDs, root names, and requested relative paths, preventing internal host directory tree leakage.

### 4. Workspace Search Security
- **Strict Root Boundaries**: Search operations never expand beyond allowlisted workspace roots.
- **No Symlink Directory Traversal**: Recursive directory walking ignores symlink/junction directories to prevent recursion cycles, symlink escape vulnerabilities, and denial-of-service loops.
- **Hard Resource Limits**: Search execution is bounded by default limits (`maxResults: 100` [max 500], `maxFiles: 5000` [max 50000], `timeoutMs: 10000` [max 30000], and `maxDepth: 64`).
- **Binary and Large File Skipping**: Text search automatically detects and skips binary files (NUL bytes) and files exceeding 1 MiB (`MAX_SEARCH_FILE_BYTES`).
- **Vendor/Build Directory Skipping**: Common generated directories (`.git`, `node_modules`, `.next`, `dist`, `build`, etc.) are skipped by default unless `includeIgnored: true` is explicitly requested.
- **Client Cancellation Support**: Search loops check standard `AbortSignal` for immediate, clean termination upon client cancellation.

### 5. Prompt Security & Task Data Boundaries
- **Template-Only Generation**: MCP prompts do not execute filesystem I/O directly; they return structured message templates for the model to follow.
- **Delimiter Escaping**: User-controlled prompt arguments are deterministically escaped (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`) to prevent delimiter closing or instruction breakout attacks.
- **Task Data Demarcation**: User-provided inputs (`goal`, `query`, `focus`, `symbol`, `path`) are wrapped in explicit boundary blocks and labeled as literal user data rather than server instructions. User arguments are never raw-interpolated into instruction sentences.
- **Scope & Limitations**: Prompt data boundary hardening isolates user inputs from server instructions and prevents XML delimiter breakout. This design does not claim to eliminate all semantic prompt-injection risks at the model cognitive layer.
- **Root Validation**: Prompt arguments validate the specified `rootId` against the active workspace configuration before generating messages.
- **Zero Host Path Leaks**: Prompts use only logical root identifiers (`root-1`) and root-relative file paths.

### 6. Release Security Gates & Payload Scanning
- **Automated Tarball Security Scan**: Pre-release packaging executes `scripts/package-security-check.ts` to guarantee only whitelisted distribution files are included in the npm package payload and no development machine paths or secrets exist in compiled artifacts.
- **Isolated Smoke Testing**: Automated testing installs the packed tarball into an isolated consumer to ensure default execution exposes only the `safe` profile.
- **Dependency Auditing**: Production releases require clean `npm audit --omit=dev` verification.

### 7. Local-Only HTTP Transport
- The HTTP transport binds strictly to `127.0.0.1` and performs Host and Origin header validation to protect against DNS rebinding and cross-origin attacks.
- **Do not expose the HTTP transport directly to the public internet** without an authenticating reverse proxy or API gateway.

### 8. Concurrency & Denial of Service Protection
- An in-memory LRU cache with generation tracking and single-flight request coalescing prevents cache stampedes on duplicate concurrent requests.
- Worker threads isolate CPU-heavy tasks from the main Node.js event loop with configurable task execution timeouts.

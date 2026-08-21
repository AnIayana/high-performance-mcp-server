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

### 9. Automated Release Pipeline Security
- **Trusted Publishing / OIDC**: npm package publishing is automated through GitHub Actions using cryptographic OpenID Connect (OIDC) identity tokens. No long-lived `NPM_TOKEN` or publish secrets are stored or required. Publishing via OIDC requires `npm >= 11.5.1` and `Node >= 22.14.0` (pinned to `11.19.0` in the release workflow).
- **npm Trust CLI Management**: Managing trusted publishers via the command line (`npm trust github ...`) requires `npm >= 11.15.0`. Alternatively, trusted publishers can be configured via the npmjs.com web interface.
- **npm Provenance**: Packages published via the trusted release workflow automatically include verifiable npm provenance attestations linking published tarballs back to the exact source commit and GitHub Actions run.
- **MCP Registry GitHub OIDC**: Official MCP Registry publication utilizes non-interactive `mcp-publisher login github-oidc` authentication with short-lived GitHub Actions identity tokens scoped to `io.github.eminyilmz/*`.
- **Least Privilege Permissions**: Release jobs require explicit `id-token: write` and `contents: write` permissions, while standard validation and CI jobs remain strictly read-only (`contents: read`).
- **Release Environment Protection**: Irreversible publication jobs run within the `release` GitHub Environment, allowing repository maintainers to enforce manual approval gates and required reviewer checks before publication proceeds.
- **Immutable Version & Tag Enforcement**: Real releases require exact SemVer matching across `package.json`, `server.json`, and an immutable Git tag (`vX.Y.Z`) pointing directly to the checked-out commit. Dry-run validation tests the quality gate without requiring Git tags.

### 10. Network & SSRF Security (`fetch_url`)
- **Explicit Profile Opt-In**: Outbound network fetching is disabled by default. It is exposed exclusively when `--profile=network` (or `--profile=all`) is active.
- **Strict Read-Only Semantics**: Only standard HTTP/HTTPS GET requests are performed. No mutation verbs (`POST`, `PUT`, `DELETE`, `PATCH`), arbitrary custom headers, caller cookies, or authorization tokens are accepted.
- **SSRF Subnet & Cloud Metadata Blocking**: All target IP addresses (both initial target and every redirect hop) are validated against `net.BlockList` tables:
  - **IPv4**: Loopback (`127.0.0.0/8`), private RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), carrier-grade NAT (`100.64.0.0/10`), cloud metadata (`169.254.169.254`), multicast (`224.0.0.0/4`), broadcast (`255.255.255.255/32`), and reserved ranges (`0.0.0.0/8`, `240.0.0.0/4`).
  - **IPv6**: Loopback (`::1/128`), unspecified (`::/128`), unique-local (`fc00::/7`), link-local (`fe80::/10`), multicast (`ff00::/8`), and documentation (`2001:db8::/32`).
  - **Transition & IPv4-Mapped IPv6**: Embedded IPv4 addresses in `::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`, and `2001::/32` are decomposed and classified against the full IPv4 policy.
- **Authoritative Socket Lookup & DNS Rebinding Defenses**: Socket connection establishment receives a custom `lookup` function tied directly to the security resolver. TCP connections connect strictly to verified public IPs. If a hostname resolves to multiple IP addresses and *any* address is blocked, the entire hostname is rejected (All-or-Nothing rule).
- **Port Allowlist**: Outbound requests are restricted to standard public web ports: `80`, `443`, `8080`, and `8443`.
- **Redirect Controls**: Maximum 5 redirects. Every hop is re-validated against the full URL and IP policy. HTTPS-to-HTTP downgrade redirects are strictly rejected (`redirect_downgrade_not_allowed`).
- **Resource Bounds & Truncation**: Default body size limit is 1 MiB (`DEFAULT_MAX_FETCH_BYTES`), with a hard upper bound of 5 MiB (`HARD_MAX_FETCH_BYTES`). Default timeout is 10 seconds (`DEFAULT_TIMEOUT_MS`), with a 30-second hard cap (`MAX_TIMEOUT_MS`). Streaming responses exceeding `maxBytes` are truncated with `truncated: true` and the underlying socket is immediately destroyed.
- **Textual Content Decoding**: Responses must have textual Content-Types and are decoded with fatal UTF-8 rules (`new TextDecoder("utf-8", { fatal: true })`). Binary payloads and non-UTF-8 explicit charsets are rejected. Non-identity compression (`gzip`, `br`, `deflate`) is rejected.
- **Client Error Sanitization**: Client-facing errors never leak internal IP addresses, local socket details, or DNS topologies.
- **Untrusted External Data Boundary**: Fetched remote content is external untrusted data. Connected models are instructed not to treat remote web content as authoritative server instructions.


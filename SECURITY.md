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
  - **IPv4**:
    - `0.0.0.0/8` ("This network" / Unspecified - RFC 1122)
    - `10.0.0.0/8` (Private-Use - RFC 1918)
    - `100.64.0.0/10` (Carrier-Grade NAT - RFC 6598)
    - `127.0.0.0/8` (Loopback - RFC 1122)
    - `169.254.0.0/16` (Link-Local & Cloud Metadata `169.254.169.254` - RFC 3927)
    - `172.16.0.0/12` (Private-Use - RFC 1918)
    - `192.0.0.0/24` (IETF Protocol Assignments - RFC 6890)
    - `192.0.2.0/24` (TEST-NET-1 Documentation - RFC 5737)
    - `192.88.99.0/24` (6to4 Relay Anycast - RFC 7526)
    - `192.168.0.0/16` (Private-Use - RFC 1918)
    - `198.18.0.0/15` (Benchmarking - RFC 2544)
    - `198.51.100.0/24` (TEST-NET-2 Documentation - RFC 5737)
    - `203.0.113.0/24` (TEST-NET-3 Documentation - RFC 5737)
    - `224.0.0.0/4` (Multicast - RFC 5771)
    - `240.0.0.0/4` (Reserved for Future Use & Broadcast `255.255.255.255` - RFC 1112)
  - **IPv6**:
    - `::/128` (Unspecified - RFC 4291)
    - `::1/128` (Loopback - RFC 4291)
    - `::/96` (IPv4-Compatible IPv6 Deprecated - RFC 4291)
    - `64:ff9b:1::/48` (Local-Use IPv4/IPv6 Translation - RFC 8215)
    - `100::/64` (Discard-Only - RFC 6666)
    - `2001::/32` (Teredo Tunneling - RFC 4380, entire prefix blocked in v0.2.0)
    - `2001:20::/28` (ORCHIDv2 - RFC 7343)
    - `2001:db8::/32` (Documentation - RFC 3849)
    - `2002::/16` (6to4 Tunneling - RFC 3056, entire prefix blocked in v0.2.0)
    - `fc00::/7` (Unique-Local Unicast - RFC 4193)
    - `fe80::/10` (Link-Local Unicast - RFC 4291)
    - `ff00::/8` (Multicast - RFC 4291)
  - **Transition & IPv4-Mapped IPv6**: Embedded IPv4 addresses in `::ffff:0:0/96` and `64:ff9b::/96` are decomposed and classified against the full IPv4 policy.
- **Authoritative Socket Lookup & DNS Rebinding Defenses**: Socket connection establishment receives a custom `lookup` function tied directly to the security resolver. TCP connections connect strictly to verified public IPs. If a hostname resolves to multiple IP addresses and *any* address is blocked, the entire hostname is rejected (All-or-Nothing rule).
- **Port Allowlist**: Outbound requests are restricted to standard public web ports: `80`, `443`, `8080`, and `8443`.
- **Redirect Controls**: Maximum 5 redirects. Every hop is re-validated against the full URL and IP policy. HTTPS-to-HTTP downgrade redirects are strictly rejected (`redirect_downgrade_not_allowed`).
- **Resource Bounds & Truncation**: Default body size limit is 1 MiB (`DEFAULT_MAX_FETCH_BYTES`), with a hard upper bound of 5 MiB (`HARD_MAX_FETCH_BYTES`). Default timeout is 10 seconds (`DEFAULT_TIMEOUT_MS`), with a 30-second hard cap (`MAX_TIMEOUT_MS`). Streaming responses exceeding `maxBytes` are truncated with `truncated: true` and the underlying socket is immediately destroyed.
- **Textual Content Decoding**: Responses must have textual Content-Types and are decoded with fatal UTF-8 rules (`new TextDecoder("utf-8", { fatal: true })`). Binary payloads and non-UTF-8 explicit charsets are rejected. Non-identity compression (`gzip`, `br`, `deflate`) is rejected.
- **Client Error Sanitization**: Client-facing errors never leak internal IP addresses, local socket details, or DNS topologies.
- **Untrusted External Data Boundary**: Fetched remote content is external untrusted data. Connected models are instructed not to treat remote web content as authoritative server instructions.
- **Policy Scope & Inherent Limitations**: IP subnet blocklists prevent reaching non-public, loopback, link-local, cloud metadata, and private network address spaces. However, globally routable public IP addresses are considered network-eligible even if the underlying web application is organizationally restricted or requires network perimeter firewalls.

### 11. Operator-Configurable Network Egress Policy
- **Restrictive Layering**: Operator policies are strictly additive/restrictive (`built-in SSRF policy AND operator policy`). Configuration cannot override or bypass built-in private IP, loopback, link-local, or cloud metadata protections.
- **Hostname Pattern Normalization**: Allowed and denied hostnames are strictly normalized (WHATWG URL parsing, lowercase, trailing dot removal). IP literals (`127.0.0.1`, `::1`), URLs, paths, query parameters, ports, credentials, and forbidden local domains (`localhost`, `*.local`, `*.internal`) are rejected at configuration time.
- **Subdomain Wildcards**: Wildcard patterns must use the `*.domain.tld` prefix format, matching subdomains (e.g. `api.example.com`, `a.b.example.com`) while strictly excluding the apex domain (`example.com`).
- **Deny Precedence**: If a destination matches both allow and deny lists, the deny rule strictly takes precedence (`host_denied`).
- **HTTPS-Only Enforcement**: When enabled, HTTP requests and redirects to HTTP are rejected (`https_required`).
- **Configurable Resource Caps**: Operators can lower the maximum response size (`maxResponseBytes`, 1 to 5,242,880) and timeout (`maxTimeoutMs`, 1,000 to 30,000). Caller requests are clamped to `min(caller, operator, hard_cap)`.
- **Hop-by-Hop Re-evaluation**: All operator egress rules (allowlist, denylist, HTTPS-only) are re-evaluated independently on every redirect destination before establishing subsequent connections.
- **Configuration Privacy**: Sanitized client error messages (`host_not_allowed`, `host_denied`, `https_required`) never leak configured host allowlists or denylists to clients.

### 12. Conditional HTTP Response Cache Security
- **Opt-In Capability**: Disabled by default. Enabled exclusively when explicitly configured by the server operator via `--network-cache` or `MCP_NETWORK_CACHE_ENABLED=true`.
- **Conservative v1 Eligibility Rules**: Only responses meeting all conservative criteria are eligible for caching:
  1. Scheme is strictly HTTPS (plain HTTP responses are never cached).
  2. Direct request only (responses resulting from redirects are uncacheable).
  3. Status code is strictly 200 OK.
  4. Response body was received in full without truncation (`truncated === false`).
  5. Content-Type is an accepted textual MIME type.
  6. Content-Encoding is uncompressed (`identity` or absent).
  7. Response contains a valid, sanitized `ETag` or `Last-Modified` header.
  8. `Cache-Control` does not contain `no-store` or `private`.
  9. `Set-Cookie` header is absent.
  10. Request URL contains no query string parameters or fragment identifiers.
  11. `Vary` header is not `*`.
- **Mandatory Live Revalidation Invariant**: The configured TTL is a retention TTL for cache eviction, NOT an offline freshness window. Every reuse must send conditional headers (`If-None-Match` or `If-Modified-Since`) to the origin over the secure transport.
- **Zero Offline Stale Fallback**: Stale cached responses are never served on network errors, timeouts, aborts, or destination security failures. The origin failure is always returned directly to the caller.
- **Continuous SSRF & Egress Policy Enforcement**: Revalidation connections pass through the exact same socket-level security controls (custom DNS lookup hook, private IP blocklists, DNS rebinding defenses, TLS verification, and operator allow/deny policy).
- **Privacy-Preserving SHA-256 Keys**: Cache keys are 256-bit opaque SHA-256 hashes generated over canonical HTTPS identities. Plaintext URLs and authorization tokens are never stored in cache keys or cache records.
- **Validator Header Sanitization**: `ETag` and `Last-Modified` values are sanitized to reject any control characters (CR, LF, NUL, ASCII 0x00–0x1F, 0x7F) and capped at safe byte lengths (1,024 bytes for ETag, 256 bytes for Last-Modified).
### 13. Guarded Workspace Text Write & Edit Security (`workspace_write`)
- **Explicit Separation of Mutation Capabilities**: The standard `workspace` profile remains strictly read-only. Text mutation capabilities (`write_text_file`, `edit_text_file`) are exposed exclusively under the opt-in `workspace_write` and `all` profiles.
- **Strict Root Boundary Confinement**: All write and edit operations require relative paths within an allowlisted workspace root. Absolute paths (POSIX `/...` or Windows `C:\...`), path traversal sequences (`../`, `..\`), and empty root paths are strictly rejected.
- **Canonical Parent & Target Validation (Symlink Defense)**: For new file creation (`create: true`), the parent directory is canonicalized via `fs.realpath` and verified to reside strictly within `root.realPath`. For existing file modifications, both the target file and its parent directory are canonicalized and verified within the root boundary.
- **Regular File Enforcement**: Mutation tools operate exclusively on regular text files (`stats.isFile()`). Mutations targeting directories, devices, FIFOs, or sockets are rejected (`unsupported_file_type`).
- **Optimistic Concurrency Control (`expectedSha256`)**: Overwriting or editing an existing file strictly requires providing `expectedSha256` matching the file's current SHA-256 hash (64-character lowercase hex string). If the hash does not match, the operation fails with `content_conflict` and the file is untouched.
- **Atomic Same-Directory Replacement**: File writes create a temporary file (`.mcp-temp-<uuid>.tmp`) within the target file's canonical directory with mode `0o600`. The buffer is flushed to disk (`fileHandle.sync()`), target hash and existence are re-validated immediately before the rename to eliminate TOCTOU race conditions, and `fs.rename` is executed. Any error unlinks the temporary file.
- **Transactional Sequential Edits**: The `edit_text_file` tool applies an ordered sequence of literal text replacements in memory. If any edit fails its `expectedOccurrences` count or if the file hash mismatches, the operation aborts with `occurrence_mismatch` or `content_conflict`, and zero bytes are written to disk.
- **Literal Replacement Fidelity**: In-memory replacements use function-based replacements to guarantee 100% exact literal insertion without expanding JavaScript replacement patterns (e.g. `$$`, `$1`, `$&`).
- **Strict UTF-8 Encoding & Binary Rejection**: All writes and edits enforce UTF-8 text encoding. Embedded NUL bytes (`\0`) in paths, content, or edit parameters are rejected (`invalid_text_encoding`). Target files for editing must decode cleanly with fatal UTF-8 rules.
- **Operator-Configurable Write Ceilings**: Operators can enforce deployment-wide write size limits via `--workspace-max-write-bytes` (1 to 5,242,880 bytes / 5 MiB, default: `1048576` / 1 MiB).
- **Zero Process or Deletion Capabilities**: The server contains no file deletion (`unlink`, `rm`), rename, directory removal, permission modification (`chmod`, `chown`), or command execution (`exec`, `spawn`) capabilities.





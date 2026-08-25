# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- MCP-native read-only workspace Resource Template (`workspace:///{rootId}/{+path}`) for consuming allowlisted workspace text files directly through standard MCP `resources/read`.
- Profile-gated workspace file resource access exposed exclusively in workspace-capable profiles (`workspace`, `workspace_write`, `all`).
- Operator-configurable workspace resource read limit (`--workspace-max-resource-bytes`, `MCP_WORKSPACE_MAX_RESOURCE_BYTES`) with a 1 MiB default and 5 MiB hard maximum cap.
- Opt-in `workspace_write` tool profile exposing guarded text file creation/overwrite (`write_text_file`) and transactional literal editing (`edit_text_file`) capabilities.
- Optimistic concurrency control via mandatory `expectedSha256` hashing for file overwrites and edits to prevent lost updates and race conditions.
- Transactional in-memory sequential editing engine applying exact literal replacements with strict occurrence guarantees (`expectedOccurrences`) and zero regex replacement token expansion (`$$`, `$1`, `$&`).
- Operator-configurable workspace write limit policy (`--workspace-max-write-bytes`, `MCP_WORKSPACE_MAX_WRITE_BYTES`) with a 1 MiB default and 5 MiB hard maximum ceiling.
- Authoritative `sha256` digest returned in non-truncated `read_text_file` output to facilitate seamless optimistic concurrency workflows.
- Opt-in `network` tool profile exposing the SSRF-hardened `fetch_url` read-only HTTP/HTTPS GET tool.
- Dedicated network security engine with mathematical IPv4/IPv6 classification (`net.BlockList`), custom socket `lookup` hooks preventing TOCTOU DNS rebinding, manual redirect re-validation (up to 5 redirects), and bounded stream decoding.
- Operator-configurable network egress policy supporting allowed host patterns (`--network-allow-host`, `MCP_NETWORK_ALLOW_HOSTS_JSON`), denied host patterns (`--network-deny-host`, `MCP_NETWORK_DENY_HOSTS_JSON`), HTTPS-only mode (`--network-https-only`, `MCP_NETWORK_HTTPS_ONLY`), max response byte caps (`--network-max-response-bytes`, `MCP_NETWORK_MAX_RESPONSE_BYTES`), and max timeout caps (`--network-max-timeout-ms`, `MCP_NETWORK_MAX_TIMEOUT_MS`).
- Optional in-memory conditional HTTP response cache for `fetch_url` (`--network-cache`, `MCP_NETWORK_CACHE_ENABLED`) utilizing `ETag`, `Last-Modified`, `If-None-Match`, `If-Modified-Since`, and HTTP 304 revalidation with bounded LRU storage and configurable limits (`--network-cache-max-size-bytes`, `--network-cache-max-entries`, `--network-cache-ttl-ms`).
- Profile-aware server instruction guidance for safe network resource access, untrusted content boundaries, and operator egress restrictions.

### Security

- Resource reads reuse the central workspace security resolver, enforcing strict containment inside configured `--root` directories and blocking symlink/junction escapes.
- Complete bounded UTF-8 resource reads with strict size checking (`stat` check + buffer bound defense in depth), strict UTF-8 fatal decoding (`fatal: true`), and binary/NUL rejection.
- Plain, percent-encoded, and double-encoded path traversal and separator protections (`%2e%2e`, `%2f`, `%5c`, `%252e`).
- Resource template discovery model without recursive repository enumeration in `resources/list`.
- Workspace isolation and canonical parent directory containment verification preventing symlink and junction escape attacks during file creation and modification.
- Atomic same-directory file writing strategy using temporary files (`.mcp-temp-<uuid>.tmp`), explicit filesystem sync (`fsync`), pre-rename race revalidation, and atomic `fs.rename` replacement.
- Invariant preservation: standard `workspace` profile remains strictly read-only; mutation tools exist exclusively in `workspace_write` and `all` profiles.
- Zero process execution, zero file deletion, zero directory removal, zero permission mutation (`chmod`), and zero arbitrary absolute path access.
- Multi-layered SSRF protection blocking loopback, private (RFC 1918), link-local, carrier-grade NAT, cloud metadata (`169.254.169.254`), IPv4-mapped IPv6 (`::ffff:x.x.x.x`), IPv6 transition ranges, and multicast destinations.
- Connection-time authoritative DNS lookup hook preventing DNS rebinding during socket establishment.
- Strict additive operator egress policy layer: operator configuration can never bypass built-in private IP, loopback, or cloud metadata protections.
- Hostname pattern normalization and startup validation rejecting IP literals, URLs, ports, credentials, and forbidden hostnames.
- Subdomain wildcard support (`*.domain.tld`) with strict apex exclusion and deny-list precedence over allow-list.
- Explicit allowed port policy (`80`, `443`, `8080`, `8443`) and HTTPS-to-HTTP redirect downgrade prevention.
- Bounded response streaming (1 MiB default, 5 MiB hard maximum), strict UTF-8 decoding (`fatal: true`), safe trailing multibyte UTF-8 boundary trimming on truncation, unsupported binary MIME rejection, and zero IP address disclosure in error messages.
- Conservative v1 conditional cache security: HTTPS-only caching, zero offline stale fallback, privacy-preserving SHA-256 cache keys without plaintext URLs or credentials, strict validator header sanitization, and runtime `ServerContext` isolation.

## [0.1.0] - 2026-08-20

### Added

- Native Model Context Protocol (MCP) 2026-07-28 modern protocol support with legacy 2025-era client compatibility.
- Dual transport architecture supporting both `stdio` and Streamable HTTP (`/mcp` endpoint with DNS rebinding and Origin protections).
- Safe-by-default security profile system (`safe`, `workspace`, `diagnostics`, `benchmark`, `admin`, `all`).
- Read-only workspace access strictly bounded to allowlisted `--root` directories.
- Directory listing (`list_directory`) and text file inspection (`read_text_file`, `file_info`) with 1 MiB hard limits and binary NUL-byte rejection.
- General-purpose bounded workspace search tools (`search_files`, `search_text`) with candidate filtering, ignored directory defaults, and client cancellation.
- MCP Resources (`workspace://roots` static list and `workspace://file/{rootId}{?path}` dynamic text template).
- Profile-aware server instructions delivering dynamic guidance to connected LLMs and MCP clients.
- Modular MCP prompt templates (`explore_workspace`, `find_and_explain`, `review_file`, `trace_symbol`).
- Reusable Worker Thread Pool for CPU-heavy tasks with deterministic zero-drift worker lifecycle management.
- In-memory LRU cache with generation tracking and single-flight request coalescing (stampede prevention).
- Process telemetry, event-loop lag monitoring, and stdio-safe structured JSON logging to `stderr`.
- Strict CLI configuration parsing with explicit error handling and environment variable support.
- Cross-platform build packaging, automated package payload security scanning, and isolated smoke tests.

### Security

- Workspace isolation preventing path traversal (`../`) and directory symlink/junction breakout.
- Host absolute path privacy ensuring local machine paths are never exposed to connected clients or LLMs.
- Bounded search execution with hard limits on matches, scanned files, traversal depth, and execution timeout.
- Binary file detection and large file safeguards preventing context window exhaustion.
- Prompt argument data boundary escaping preventing delimiter breakout or instruction confusion.
- Local-only HTTP binding with strict Host and Origin header validation.

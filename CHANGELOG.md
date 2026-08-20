# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

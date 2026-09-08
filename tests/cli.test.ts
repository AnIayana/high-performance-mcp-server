import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync, spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  getHelpText,
  getPackageVersion,
  parseCliArgs,
  parseStrictPort,
} from "../src/config/cli.js";

test("Helper — parseStrictPort validation rules", () => {
  assert.equal(parseStrictPort("3000"), 3000);
  assert.equal(parseStrictPort("8080"), 8080);
  assert.equal(parseStrictPort("1"), 1);
  assert.equal(parseStrictPort("65535"), 65535);
  assert.equal(parseStrictPort("03000"), 3000);

  // Invalid formats
  assert.equal(parseStrictPort("3000abc"), null);
  assert.equal(parseStrictPort("3000.5"), null);
  assert.equal(parseStrictPort("1e3"), null);
  assert.equal(parseStrictPort("-1"), null);
  assert.equal(parseStrictPort("0"), null);
  assert.equal(parseStrictPort("65536"), null);
  assert.equal(parseStrictPort(""), null);
  assert.equal(parseStrictPort("   "), null);
});

test("CLI Parser — default configuration is safe stdio", () => {
  const config = parseCliArgs([], {});
  assert.equal(config.action, "start");
  assert.equal(config.transport, "stdio");
  assert.equal(config.port, 3000);
  assert.equal(config.profile, "safe");
  assert.deepEqual(config.roots, []);
  assert.equal(config.error, undefined);
});

test("CLI Parser — transport and port arguments", () => {
  const config = parseCliArgs(["--transport=http", "--port=8080"], {});
  assert.equal(config.transport, "http");
  assert.equal(config.port, 8080);
  assert.equal(config.profile, "safe");
});

test("CLI Parser — profile arguments", () => {
  assert.equal(parseCliArgs(["--profile=workspace", "--root=./a"], {}).profile, "workspace");
  assert.equal(parseCliArgs(["--profile=network"], {}).profile, "network");
  assert.equal(parseCliArgs(["--profile=diagnostics"], {}).profile, "diagnostics");
  assert.equal(parseCliArgs(["--profile=benchmark"], {}).profile, "benchmark");
  assert.equal(parseCliArgs(["--profile=admin"], {}).profile, "admin");
  assert.equal(parseCliArgs(["--profile=all", "--root=./a"], {}).profile, "all");
});

test("CLI Parser — repeatable --root arguments", () => {
  const config = parseCliArgs(
    ["--profile=workspace", "--root=./project-a", "--root=./project-b"],
    {}
  );
  assert.equal(config.profile, "workspace");
  assert.deepEqual(config.roots, ["./project-a", "./project-b"]);
  assert.equal(config.error, undefined);
});

test("CLI Parser — MCP_ROOTS_JSON environment variable and CLI override", () => {
  // ENV roots parsing
  const envConfig = parseCliArgs(["--profile=workspace"], {
    MCP_ROOTS_JSON: '["/path/one", "/path/two"]',
  });
  assert.deepEqual(envConfig.roots, ["/path/one", "/path/two"]);
  assert.equal(envConfig.error, undefined);

  // CLI --root overrides MCP_ROOTS_JSON
  const overrideConfig = parseCliArgs(["--profile=workspace", "--root=/cli/override"], {
    MCP_ROOTS_JSON: '["/path/one", "/path/two"]',
  });
  assert.deepEqual(overrideConfig.roots, ["/cli/override"]);
});

test("CLI Parser — workspace profile requires at least one root when starting", () => {
  const missingRoot = parseCliArgs(["--profile=workspace"], {});
  assert.ok(missingRoot.error?.includes("Workspace profile requires at least one allowed root"));

  const allMissingRoot = parseCliArgs(["--profile=all"], {});
  assert.ok(allMissingRoot.error?.includes("Workspace profile requires at least one allowed root"));

  // Non-start action (e.g. list-tools) does not require roots
  const listToolsConfig = parseCliArgs(["--profile=workspace", "--list-tools"], {});
  assert.equal(listToolsConfig.action, "list-tools");
  assert.equal(listToolsConfig.error, undefined);
});

test("CLI Parser — invalid port formats rejected (strict decimal)", () => {
  const alphaPort = parseCliArgs(["--port=3000abc"], {});
  assert.ok(alphaPort.error?.includes("Invalid port option"));

  const floatPort = parseCliArgs(["--port=3000.5"], {});
  assert.ok(floatPort.error?.includes("Invalid port option"));

  const expPort = parseCliArgs(["--port=1e3"], {});
  assert.ok(expPort.error?.includes("Invalid port option"));

  const outOfRangePort = parseCliArgs(["--port=65536"], {});
  assert.ok(outOfRangePort.error?.includes("Invalid port option"));
});

test("CLI Parser — invalid PORT environment variable fail-fast", () => {
  const invalidEnvPort = parseCliArgs([], { PORT: "3000abc" });
  assert.ok(invalidEnvPort.error?.includes("Invalid PORT environment variable"));

  const floatEnvPort = parseCliArgs([], { PORT: "8080.2" });
  assert.ok(floatEnvPort.error?.includes("Invalid PORT environment variable"));
});

test("CLI Parser — unknown CLI options and typo rejection", () => {
  const typoProfile = parseCliArgs(["--profle=workspace"], {});
  assert.ok(typoProfile.error?.includes("Unknown CLI option: \"--profle=workspace\""));

  const unknownOption = parseCliArgs(["--something"], {});
  assert.ok(unknownOption.error?.includes("Unknown CLI option: \"--something\""));

  const unknownKeyVal = parseCliArgs(["--foo=bar"], {});
  assert.ok(unknownKeyVal.error?.includes("Unknown CLI option: \"--foo=bar\""));
});

test("CLI Parser — positional argument rejection", () => {
  const positional = parseCliArgs(["something"], {});
  assert.ok(positional.error?.includes("Unexpected positional argument: \"something\""));

  const positionalAfterFlag = parseCliArgs(["--profile=safe", "extra"], {});
  assert.ok(positionalAfterFlag.error?.includes("Unexpected positional argument: \"extra\""));
});

test("CLI Parser — duplicate singleton options rejected", () => {
  const dupProfile = parseCliArgs(["--profile=safe", "--profile=workspace", "--root=./a"], {});
  assert.ok(dupProfile.error?.includes("Duplicate option specified: \"--profile\""));

  const dupTransport = parseCliArgs(["--transport=stdio", "--transport=http"], {});
  assert.ok(dupTransport.error?.includes("Duplicate option specified: \"--transport\""));

  const dupPort = parseCliArgs(["--port=3000", "--port=4000"], {});
  assert.ok(dupPort.error?.includes("Duplicate option specified: \"--port\""));

  const dupListTools = parseCliArgs(["--list-tools", "--list-tools"], {});
  assert.ok(dupListTools.error?.includes("Duplicate option specified: \"--list-tools\""));
});

test("CLI Parser — error handling for invalid options and roots", () => {
  const invalidProfile = parseCliArgs(["--profile=invalid"], {});
  assert.ok(invalidProfile.error?.includes("Invalid tool profile"));

  const invalidTransport = parseCliArgs(["--transport=unknown"], {});
  assert.ok(invalidTransport.error?.includes("Invalid transport"));

  const emptyRoot = parseCliArgs(["--root="], {});
  assert.ok(emptyRoot.error?.includes("Root path cannot be empty"));

  const invalidJsonRoots = parseCliArgs([], { MCP_ROOTS_JSON: "not-json" });
  assert.ok(invalidJsonRoots.error?.includes("Invalid MCP_ROOTS_JSON"));

  const nonArrayRoots = parseCliArgs([], { MCP_ROOTS_JSON: '{"path":"/foo"}' });
  assert.ok(nonArrayRoots.error?.includes("Must be a valid JSON array"));

  const nonStringRoots = parseCliArgs([], { MCP_ROOTS_JSON: "[123, true]" });
  assert.ok(nonStringRoots.error?.includes("Array items must be non-empty strings"));
});

test("CLI Helpers — getHelpText and getPackageVersion", () => {
  const help = getHelpText();
  assert.ok(help.includes("Usage:"));
  assert.ok(help.includes("workspace"));
  assert.ok(help.includes("--root="));
  assert.ok(help.includes("MCP_ROOTS_JSON"));
  assert.ok(help.includes("--workspace-write-confirmation"));
  assert.ok(help.includes("MCP_WORKSPACE_WRITE_CONFIRMATION"));
  assert.ok(help.includes("--list-tools"));
  assert.ok(help.includes("--network-allow-host"));
  assert.ok(help.includes("--network-deny-host"));
  assert.ok(help.includes("--network-https-only"));
  assert.ok(help.includes("--network-max-response-bytes"));
  assert.ok(help.includes("--network-max-timeout-ms"));
  assert.ok(help.includes("MCP_NETWORK_ALLOW_HOSTS_JSON"));

  const version = getPackageVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("CLI Parser — network operator policy CLI flags parsing and normalization", () => {
  const config = parseCliArgs(
    [
      "--profile=network",
      "--network-allow-host=example.com",
      "--network-allow-host=*.github.com",
      "--network-deny-host=ads.example.com",
      "--network-https-only",
      "--network-max-response-bytes=262144",
      "--network-max-timeout-ms=5000",
    ],
    {}
  );

  assert.equal(config.error, undefined);
  assert.deepEqual(config.networkPolicy.allowHosts, ["example.com", "*.github.com"]);
  assert.deepEqual(config.networkPolicy.denyHosts, ["ads.example.com"]);
  assert.equal(config.networkPolicy.httpsOnly, true);
  assert.equal(config.networkPolicy.maxResponseBytes, 262144);
  assert.equal(config.networkPolicy.maxTimeoutMs, 5000);
});

test("CLI Parser — network operator policy space-separated option values", () => {
  const config = parseCliArgs(
    [
      "--profile",
      "network",
      "--network-allow-host",
      "api.test.org",
      "--network-deny-host",
      "bad.test.org",
      "--network-max-response-bytes",
      "1048576",
      "--network-max-timeout-ms",
      "15000",
    ],
    {}
  );

  assert.equal(config.error, undefined);
  assert.deepEqual(config.networkPolicy.allowHosts, ["api.test.org"]);
  assert.deepEqual(config.networkPolicy.denyHosts, ["bad.test.org"]);
  assert.equal(config.networkPolicy.maxResponseBytes, 1048576);
  assert.equal(config.networkPolicy.maxTimeoutMs, 15000);
});

test("CLI Parser — network operator policy environment variables", () => {
  const config = parseCliArgs([], {
    MCP_NETWORK_ALLOW_HOSTS_JSON: '["example.com", "*.githubusercontent.com"]',
    MCP_NETWORK_DENY_HOSTS_JSON: '["evil.com"]',
    MCP_NETWORK_HTTPS_ONLY: "true",
    MCP_NETWORK_MAX_RESPONSE_BYTES: "524288",
    MCP_NETWORK_MAX_TIMEOUT_MS: "8000",
  });

  assert.equal(config.error, undefined);
  assert.deepEqual(config.networkPolicy.allowHosts, [
    "example.com",
    "*.githubusercontent.com",
  ]);
  assert.deepEqual(config.networkPolicy.denyHosts, ["evil.com"]);
  assert.equal(config.networkPolicy.httpsOnly, true);
  assert.equal(config.networkPolicy.maxResponseBytes, 524288);
  assert.equal(config.networkPolicy.maxTimeoutMs, 8000);
});

test("CLI Parser — CLI options override environment variables (no merging)", () => {
  const config = parseCliArgs(
    [
      "--network-allow-host=override.com",
      "--network-deny-host=denied.com",
      "--network-max-response-bytes=100000",
      "--network-max-timeout-ms=4000",
    ],
    {
      MCP_NETWORK_ALLOW_HOSTS_JSON: '["env1.com", "env2.com"]',
      MCP_NETWORK_DENY_HOSTS_JSON: '["env-deny.com"]',
      MCP_NETWORK_MAX_RESPONSE_BYTES: "500000",
      MCP_NETWORK_MAX_TIMEOUT_MS: "20000",
    }
  );

  assert.equal(config.error, undefined);
  assert.deepEqual(config.networkPolicy.allowHosts, ["override.com"]);
  assert.deepEqual(config.networkPolicy.denyHosts, ["denied.com"]);
  assert.equal(config.networkPolicy.maxResponseBytes, 100000);
  assert.equal(config.networkPolicy.maxTimeoutMs, 4000);
});

test("CLI Parser — invalid network CLI options fail fast", () => {
  // Invalid hostname (contains scheme)
  const invalidHost = parseCliArgs(["--network-allow-host=https://example.com"], {});
  assert.ok(invalidHost.error?.includes("Invalid --network-allow-host option"));

  // IP literal rejected
  const ipHost = parseCliArgs(["--network-allow-host=127.0.0.1"], {});
  assert.ok(ipHost.error?.includes("IP literals are not allowed"));

  // Forbidden hostname rejected
  const localHost = parseCliArgs(["--network-allow-host=localhost"], {});
  assert.ok(localHost.error?.includes("Localhost and private hostnames"));

  // Invalid max response bytes (out of range)
  const outOfRangeBytes = parseCliArgs(["--network-max-response-bytes=99999999"], {});
  assert.ok(outOfRangeBytes.error?.includes("Invalid --network-max-response-bytes option"));

  // Invalid timeout (too low)
  const lowTimeout = parseCliArgs(["--network-max-timeout-ms=500"], {});
  assert.ok(lowTimeout.error?.includes("Invalid --network-max-timeout-ms option"));

  // Duplicate singleton option
  const dupHttps = parseCliArgs(["--network-https-only", "--network-https-only"], {});
  assert.ok(dupHttps.error?.includes("Duplicate option specified: \"--network-https-only\""));
});

test("CLI Parser — invalid network environment variables fail fast", () => {
  const invalidJson = parseCliArgs([], {
    MCP_NETWORK_ALLOW_HOSTS_JSON: "not-json",
  });
  assert.ok(invalidJson.error?.includes("Invalid MCP_NETWORK_ALLOW_HOSTS_JSON"));

  const invalidArrayType = parseCliArgs([], {
    MCP_NETWORK_ALLOW_HOSTS_JSON: '{"host":"example.com"}',
  });
  assert.ok(invalidArrayType.error?.includes("Must be a valid JSON array"));

  const invalidHttpsOnly = parseCliArgs([], {
    MCP_NETWORK_HTTPS_ONLY: "maybe",
  });
  assert.ok(invalidHttpsOnly.error?.includes("Invalid MCP_NETWORK_HTTPS_ONLY"));

  const invalidTimeout = parseCliArgs([], {
    MCP_NETWORK_MAX_TIMEOUT_MS: "invalid",
  });
  assert.ok(invalidTimeout.error?.includes("Invalid MCP_NETWORK_MAX_TIMEOUT_MS"));
});

test("CLI Parser — network conditional cache CLI flags and environment variables", () => {
  // 1. Defaults when disabled
  const configDefault = parseCliArgs([], {});
  assert.equal(configDefault.networkCachePolicy.enabled, false);
  assert.equal(configDefault.networkCachePolicy.maxSizeBytes, 16 * 1024 * 1024);
  assert.equal(configDefault.networkCachePolicy.maxEntries, 128);
  assert.equal(configDefault.networkCachePolicy.retentionTtlMs, 300_000);

  // 2. CLI flags enable and custom options
  const configCli = parseCliArgs(
    [
      "--profile=network",
      "--network-cache",
      "--network-cache-max-size-bytes=8388608",
      "--network-cache-max-entries=64",
      "--network-cache-ttl-ms=60000",
    ],
    {}
  );
  assert.equal(configCli.error, undefined);
  assert.equal(configCli.networkCachePolicy.enabled, true);
  assert.equal(configCli.networkCachePolicy.maxSizeBytes, 8388608);
  assert.equal(configCli.networkCachePolicy.maxEntries, 64);
  assert.equal(configCli.networkCachePolicy.retentionTtlMs, 60000);

  // 3. Environment variables
  const configEnv = parseCliArgs([], {
    MCP_NETWORK_CACHE_ENABLED: "true",
    MCP_NETWORK_CACHE_MAX_SIZE_BYTES: "4194304",
    MCP_NETWORK_CACHE_MAX_ENTRIES: "32",
    MCP_NETWORK_CACHE_TTL_MS: "120000",
  });
  assert.equal(configEnv.error, undefined);
  assert.equal(configEnv.networkCachePolicy.enabled, true);
  assert.equal(configEnv.networkCachePolicy.maxSizeBytes, 4194304);
  assert.equal(configEnv.networkCachePolicy.maxEntries, 32);
  assert.equal(configEnv.networkCachePolicy.retentionTtlMs, 120000);

  // 4. CLI overrides environment variables
  const configOverride = parseCliArgs(
    [
      "--network-cache-max-size-bytes=2097152",
      "--network-cache-max-entries=16",
      "--network-cache-ttl-ms=30000",
    ],
    {
      MCP_NETWORK_CACHE_ENABLED: "1",
      MCP_NETWORK_CACHE_MAX_SIZE_BYTES: "33554432",
      MCP_NETWORK_CACHE_MAX_ENTRIES: "256",
      MCP_NETWORK_CACHE_TTL_MS: "600000",
    }
  );
  assert.equal(configOverride.error, undefined);
  assert.equal(configOverride.networkCachePolicy.enabled, true);
  assert.equal(configOverride.networkCachePolicy.maxSizeBytes, 2097152);
  assert.equal(configOverride.networkCachePolicy.maxEntries, 16);
  assert.equal(configOverride.networkCachePolicy.retentionTtlMs, 30000);
});

test("CLI Parser — invalid network conditional cache options fail fast", () => {
  // Invalid enabled env
  const invalidEnabled = parseCliArgs([], { MCP_NETWORK_CACHE_ENABLED: "not-bool" });
  assert.ok(invalidEnabled.error?.includes("Invalid MCP_NETWORK_CACHE_ENABLED"));

  // Out of range max size bytes CLI (too low <= 0, too high > 64 MiB, non-integer)
  const zeroSize = parseCliArgs(["--network-cache-max-size-bytes=0"], {});
  assert.ok(zeroSize.error?.includes("Invalid --network-cache-max-size-bytes"));

  const lowSize = parseCliArgs(["--network-cache-max-size-bytes=500"], {});
  assert.ok(lowSize.error?.includes("Invalid --network-cache-max-size-bytes"));

  const highSize = parseCliArgs(["--network-cache-max-size-bytes=999999999"], {});
  assert.ok(highSize.error?.includes("Invalid --network-cache-max-size-bytes"));

  const nonIntSize = parseCliArgs(["--network-cache-max-size-bytes=10.5"], {});
  assert.ok(nonIntSize.error?.includes("Invalid --network-cache-max-size-bytes"));

  // Out of range max entries CLI (<= 0, too high > 512, non-integer)
  const zeroEntries = parseCliArgs(["--network-cache-max-entries=0"], {});
  assert.ok(zeroEntries.error?.includes("Invalid --network-cache-max-entries"));

  const highEntries = parseCliArgs(["--network-cache-max-entries=1000"], {});
  assert.ok(highEntries.error?.includes("Invalid --network-cache-max-entries"));

  const nonIntEntries = parseCliArgs(["--network-cache-max-entries=abc"], {});
  assert.ok(nonIntEntries.error?.includes("Invalid --network-cache-max-entries"));

  // Out of range TTL CLI (<= 0, too low < 1000, too high > 3600000, non-integer)
  const zeroTtl = parseCliArgs(["--network-cache-ttl-ms=0"], {});
  assert.ok(zeroTtl.error?.includes("Invalid --network-cache-ttl-ms"));

  const lowTtl = parseCliArgs(["--network-cache-ttl-ms=100"], {});
  assert.ok(lowTtl.error?.includes("Invalid --network-cache-ttl-ms"));

  const highTtl = parseCliArgs(["--network-cache-ttl-ms=99999999"], {});
  assert.ok(highTtl.error?.includes("Invalid --network-cache-ttl-ms"));

  const nonIntTtl = parseCliArgs(["--network-cache-ttl-ms=two-minutes"], {});
  assert.ok(nonIntTtl.error?.includes("Invalid --network-cache-ttl-ms"));

  // Duplicate singleton flag
  const dupCache = parseCliArgs(["--network-cache", "--network-cache"], {});
  assert.ok(dupCache.error?.includes('Duplicate option specified: "--network-cache"'));
});

test("CLI Parser — workspace write operator policy CLI flags and environment variables", () => {
  // Default workspace policy
  const defaultCfg = parseCliArgs([], {});
  assert.equal(defaultCfg.workspacePolicy.maxWriteBytes, 1048576);

  // CLI flag parsing
  const cliCfg = parseCliArgs(["--workspace-max-write-bytes=2097152"], {});
  assert.equal(cliCfg.workspacePolicy.maxWriteBytes, 2097152);

  // Space-separated CLI flag parsing
  const spaceCfg = parseCliArgs(["--workspace-max-write-bytes", "3145728"], {});
  assert.equal(spaceCfg.workspacePolicy.maxWriteBytes, 3145728);

  // Environment variable parsing
  const envCfg = parseCliArgs([], { MCP_WORKSPACE_MAX_WRITE_BYTES: "524288" });
  assert.equal(envCfg.workspacePolicy.maxWriteBytes, 524288);

  // CLI flag overrides environment variable
  const overrideCfg = parseCliArgs(["--workspace-max-write-bytes=100000"], {
    MCP_WORKSPACE_MAX_WRITE_BYTES: "500000",
  });
  assert.equal(overrideCfg.workspacePolicy.maxWriteBytes, 100000);

  // Invalid CLI flags fail fast
  const zeroWrite = parseCliArgs(["--workspace-max-write-bytes=0"], {});
  assert.ok(zeroWrite.error?.includes("Invalid --workspace-max-write-bytes"));

  const highWrite = parseCliArgs(["--workspace-max-write-bytes=99999999"], {});
  assert.ok(highWrite.error?.includes("Invalid --workspace-max-write-bytes"));

  const nonIntWrite = parseCliArgs(["--workspace-max-write-bytes=abc"], {});
  assert.ok(nonIntWrite.error?.includes("Invalid --workspace-max-write-bytes"));

  // Duplicate CLI flag fails fast
  const dupWrite = parseCliArgs(
    ["--workspace-max-write-bytes=1024", "--workspace-max-write-bytes=2048"],
    {}
  );
  assert.ok(dupWrite.error?.includes('Duplicate option specified: "--workspace-max-write-bytes"'));

  // Invalid environment variable fails fast
  const invalidEnvWrite = parseCliArgs([], { MCP_WORKSPACE_MAX_WRITE_BYTES: "not-an-int" });
  assert.ok(invalidEnvWrite.error?.includes("Invalid MCP_WORKSPACE_MAX_WRITE_BYTES"));
});

test("CLI Parser — workspace write confirmation is opt-in with strict CLI/env parsing", () => {
  assert.equal(parseCliArgs([], {}).workspacePolicy.requireWriteConfirmation, false);
  assert.equal(parseCliArgs(["--workspace-write-confirmation"], {}).workspacePolicy.requireWriteConfirmation, true);
  for (const value of ["true", "1", " TRUE "]) {
    const config = parseCliArgs([], { MCP_WORKSPACE_WRITE_CONFIRMATION: value });
    assert.equal(config.error, undefined);
    assert.equal(config.workspacePolicy.requireWriteConfirmation, true);
  }
  for (const value of ["false", "0", " FALSE ", "", "   "]) {
    const config = parseCliArgs([], { MCP_WORKSPACE_WRITE_CONFIRMATION: value });
    assert.equal(config.error, undefined);
    assert.equal(config.workspacePolicy.requireWriteConfirmation, false);
  }
  const override = parseCliArgs(["--workspace-write-confirmation"], {
    MCP_WORKSPACE_WRITE_CONFIRMATION: "false",
  });
  assert.equal(override.error, undefined);
  assert.equal(override.workspacePolicy.requireWriteConfirmation, true);
  assert.ok(parseCliArgs(["--workspace-write-confirmation", "--workspace-write-confirmation"], {}).error?.includes("Duplicate option"));
  for (const value of ["yes", "2", "true,false"]) {
    assert.ok(parseCliArgs([], { MCP_WORKSPACE_WRITE_CONFIRMATION: value }).error?.includes("Invalid MCP_WORKSPACE_WRITE_CONFIRMATION"));
  }
  assert.ok(parseCliArgs(["--workspace-write-confirmation=false"], {}).error?.includes("Unknown CLI option"));
});

test("CLI Parser — workspace resource operator policy CLI flags and environment variables", () => {
  // Default workspace policy
  const defaultCfg = parseCliArgs([], {});
  assert.equal(defaultCfg.workspacePolicy.maxResourceBytes, 1048576);

  // CLI flag parsing
  const cliCfg = parseCliArgs(["--workspace-max-resource-bytes=2097152"], {});
  assert.equal(cliCfg.workspacePolicy.maxResourceBytes, 2097152);

  // Space-separated CLI flag parsing
  const spaceCfg = parseCliArgs(["--workspace-max-resource-bytes", "3145728"], {});
  assert.equal(spaceCfg.workspacePolicy.maxResourceBytes, 3145728);

  // Environment variable parsing
  const envCfg = parseCliArgs([], { MCP_WORKSPACE_MAX_RESOURCE_BYTES: "524288" });
  assert.equal(envCfg.workspacePolicy.maxResourceBytes, 524288);

  // CLI flag overrides environment variable
  const overrideCfg = parseCliArgs(["--workspace-max-resource-bytes=100000"], {
    MCP_WORKSPACE_MAX_RESOURCE_BYTES: "500000",
  });
  assert.equal(overrideCfg.workspacePolicy.maxResourceBytes, 100000);

  // Invalid CLI flags fail fast
  const zeroRes = parseCliArgs(["--workspace-max-resource-bytes=0"], {});
  assert.ok(zeroRes.error?.includes("Invalid --workspace-max-resource-bytes"));

  const negRes = parseCliArgs(["--workspace-max-resource-bytes=-500"], {});
  assert.ok(negRes.error?.includes("Invalid --workspace-max-resource-bytes"));

  const highRes = parseCliArgs(["--workspace-max-resource-bytes=99999999"], {});
  assert.ok(highRes.error?.includes("Invalid --workspace-max-resource-bytes"));

  const nonIntRes = parseCliArgs(["--workspace-max-resource-bytes=abc"], {});
  assert.ok(nonIntRes.error?.includes("Invalid --workspace-max-resource-bytes"));

  // Duplicate CLI flag fails fast
  const dupRes = parseCliArgs(
    ["--workspace-max-resource-bytes=1024", "--workspace-max-resource-bytes=2048"],
    {}
  );
  assert.ok(dupRes.error?.includes('Duplicate option specified: "--workspace-max-resource-bytes"'));

  // Invalid environment variable fails fast
  const invalidEnvRes = parseCliArgs([], { MCP_WORKSPACE_MAX_RESOURCE_BYTES: "not-an-int" });
  assert.ok(invalidEnvRes.error?.includes("Invalid MCP_WORKSPACE_MAX_RESOURCE_BYTES"));

  const zeroEnvRes = parseCliArgs([], { MCP_WORKSPACE_MAX_RESOURCE_BYTES: "0" });
  assert.ok(zeroEnvRes.error?.includes("Invalid MCP_WORKSPACE_MAX_RESOURCE_BYTES"));

  const highEnvRes = parseCliArgs([], { MCP_WORKSPACE_MAX_RESOURCE_BYTES: "6000000" });
  assert.ok(highEnvRes.error?.includes("Invalid MCP_WORKSPACE_MAX_RESOURCE_BYTES"));
});

test("CLI Parser — log-level parsing and validation", () => {
  // Defaults to undefined in parsed config (process-global env bootstrap handles default info)
  assert.equal(parseCliArgs([], {}).logLevel, undefined);

  // Valid values via =
  assert.equal(parseCliArgs(["--log-level=debug"], {}).logLevel, "debug");
  assert.equal(parseCliArgs(["--log-level=info"], {}).logLevel, "info");
  assert.equal(parseCliArgs(["--log-level=warn"], {}).logLevel, "warn");
  assert.equal(parseCliArgs(["--log-level=error"], {}).logLevel, "error");
  assert.equal(parseCliArgs(["--log-level=off"], {}).logLevel, "off");

  // Valid values via space
  assert.equal(parseCliArgs(["--log-level", "warn"], {}).logLevel, "warn");
  assert.equal(parseCliArgs(["--log-level", "DEBUG"], {}).logLevel, "debug");

  // Duplicate flag fails
  const dupRes = parseCliArgs(["--log-level=info", "--log-level=warn"], {});
  assert.ok(dupRes.error?.includes('Duplicate option specified: "--log-level"'));

  // Missing value fails
  const missingRes = parseCliArgs(["--log-level"], {});
  assert.ok(missingRes.error?.includes('Missing value for option "--log-level"'));

  // Invalid value fails
  const invalidRes = parseCliArgs(["--log-level=verbose"], {});
  assert.ok(invalidRes.error?.includes('Invalid log level option: "verbose"'));
});

test("CLI Parser — getHelpText includes --log-level and MCP_LOG_LEVEL", () => {
  const help = getHelpText();
  assert.ok(help.includes("--log-level=<level>"));
  assert.ok(help.includes("MCP_LOG_LEVEL"));
});

test("CLI Parser — MCP_TRANSPORT environment variable and precedence", () => {
  // A. unset: no --transport, no MCP_TRANSPORT => stdio
  const unsetCfg = parseCliArgs([], {});
  assert.equal(unsetCfg.error, undefined);
  assert.equal(unsetCfg.transport, "stdio");

  // B. env stdio: MCP_TRANSPORT=stdio => stdio
  const stdioEnvCfg = parseCliArgs([], { MCP_TRANSPORT: "stdio" });
  assert.equal(stdioEnvCfg.error, undefined);
  assert.equal(stdioEnvCfg.transport, "stdio");

  // C. env http: MCP_TRANSPORT=http => http
  const httpEnvCfg = parseCliArgs([], { MCP_TRANSPORT: "http" });
  assert.equal(httpEnvCfg.error, undefined);
  assert.equal(httpEnvCfg.transport, "http");

  // D. trim and case-insensitivity: MCP_TRANSPORT="  HTTP  " => http, "  STDIO  " => stdio
  const trimHttpCfg = parseCliArgs([], { MCP_TRANSPORT: "  HTTP  " });
  assert.equal(trimHttpCfg.error, undefined);
  assert.equal(trimHttpCfg.transport, "http");

  const trimStdioCfg = parseCliArgs([], { MCP_TRANSPORT: "  STDIO  " });
  assert.equal(trimStdioCfg.error, undefined);
  assert.equal(trimStdioCfg.transport, "stdio");

  // E. empty: MCP_TRANSPORT="" => stdio (treated as unset)
  const emptyEnvCfg = parseCliArgs([], { MCP_TRANSPORT: "" });
  assert.equal(emptyEnvCfg.error, undefined);
  assert.equal(emptyEnvCfg.transport, "stdio");

  // F. whitespace-only: MCP_TRANSPORT="   " => stdio (treated as unset)
  const wsEnvCfg = parseCliArgs([], { MCP_TRANSPORT: "   " });
  assert.equal(wsEnvCfg.error, undefined);
  assert.equal(wsEnvCfg.transport, "stdio");

  // G. CLI override: MCP_TRANSPORT=stdio + --transport=http => http
  const cliOverrideCfg = parseCliArgs(["--transport=http"], { MCP_TRANSPORT: "stdio" });
  assert.equal(cliOverrideCfg.error, undefined);
  assert.equal(cliOverrideCfg.transport, "http");

  // H. reverse CLI override: MCP_TRANSPORT=http + --transport=stdio => stdio
  const revOverrideCfg = parseCliArgs(["--transport=stdio"], { MCP_TRANSPORT: "http" });
  assert.equal(revOverrideCfg.error, undefined);
  assert.equal(revOverrideCfg.transport, "stdio");

  // CLI space-separated argument override
  const spaceOverrideCfg = parseCliArgs(["--transport", "http"], { MCP_TRANSPORT: "stdio" });
  assert.equal(spaceOverrideCfg.error, undefined);
  assert.equal(spaceOverrideCfg.transport, "http");
});

test("CLI Parser — invalid MCP_TRANSPORT environment variable fails fast", () => {
  // I. invalid env: human-readable error with env name and supported transports
  const invalidEnvRes = parseCliArgs([], { MCP_TRANSPORT: "websocket" });
  assert.ok(invalidEnvRes.error?.includes("Invalid MCP_TRANSPORT environment variable:"));
  assert.ok(invalidEnvRes.error?.includes('"websocket"'));
  assert.ok(invalidEnvRes.error?.includes("Supported transports: stdio, http"));

  // J. invalid CLI: preserves existing CLI validation error
  const invalidCliRes = parseCliArgs(["--transport=tcp"], {});
  assert.ok(invalidCliRes.error?.includes("Invalid transport option:"));
  assert.ok(invalidCliRes.error?.includes('"tcp"'));
  assert.ok(invalidCliRes.error?.includes("Supported transports: stdio, http"));

  // Duplicate CLI flag fails fast
  const dupCliRes = parseCliArgs(["--transport=stdio", "--transport=http"], {});
  assert.ok(dupCliRes.error?.includes('Duplicate option specified: "--transport"'));

  // Missing CLI option value fails fast
  const missingCliRes = parseCliArgs(["--transport"], {});
  assert.ok(missingCliRes.error?.includes('Missing value for option "--transport"'));
});

test("CLI Parser — getHelpText includes MCP_TRANSPORT", () => {
  const help = getHelpText();
  assert.ok(help.includes("MCP_TRANSPORT"));
  assert.ok(help.includes("--transport=<stdio|http>"));
});

test("CLI Subprocess — MCP_TRANSPORT runtime behavior and precedence", async () => {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const distCliPath = path.resolve(rootDir, "dist/cli.js");
  if (!fs.existsSync(distCliPath)) {
    execSync("npm run build", { cwd: rootDir, stdio: "pipe" });
  }

  // 1. Invalid MCP_TRANSPORT produces exit code 1 and human-readable stderr
  const invalidRes = spawnSync(process.execPath, [distCliPath], {
    env: { ...process.env, MCP_TRANSPORT: "invalid_val" },
    encoding: "utf-8",
  });
  assert.equal(invalidRes.status, 1);
  assert.ok(
    invalidRes.stderr.includes(
      '[Error] Invalid MCP_TRANSPORT environment variable: "invalid_val". Supported transports: stdio, http'
    )
  );

  // 2. Empty/whitespace MCP_TRANSPORT defaults to stdio cleanly with actual MCP session
  const stdioTransportEmpty = new StdioClientTransport({
    command: process.execPath,
    args: [distCliPath],
    env: { ...process.env, MCP_TRANSPORT: "   " },
    stderr: "pipe",
  });
  const clientEmpty = new Client({ name: "test-client-empty", version: "1.0.0" });
  await clientEmpty.connect(stdioTransportEmpty);
  const pingEmpty = await clientEmpty.callTool({ name: "ping", arguments: {} });
  assert.ok(!pingEmpty.isError);
  assert.deepEqual(pingEmpty.content, [{ type: "text", text: "pong" }]);
  await clientEmpty.close();

  // 3. CLI --transport=stdio overrides MCP_TRANSPORT=http via actual stdio MCP session
  const stdioTransportOverride = new StdioClientTransport({
    command: process.execPath,
    args: [distCliPath, "--transport=stdio"],
    env: { ...process.env, MCP_TRANSPORT: "http" },
    stderr: "pipe",
  });
  const clientOverride = new Client({ name: "test-client-override", version: "1.0.0" });
  await clientOverride.connect(stdioTransportOverride);
  const pingOverride = await clientOverride.callTool({ name: "ping", arguments: {} });
  assert.ok(!pingOverride.isError);
  assert.deepEqual(pingOverride.content, [{ type: "text", text: "pong" }]);
  await clientOverride.close();

  // 4. CLI --transport=http overrides MCP_TRANSPORT=stdio via actual HTTP server and /healthz probe
  const testPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not acquire ephemeral port")));
      }
    });
    srv.on("error", reject);
  });

  const httpChild = spawn(
    process.execPath,
    [distCliPath, "--transport=http", `--port=${testPort}`],
    {
      env: { ...process.env, MCP_TRANSPORT: "stdio" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for HTTP server to start"));
      }, 10000);

      httpChild.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.event === "http_listening") {
              clearTimeout(timeout);
              resolve();
              return;
            }
          } catch {
            // Ignore non-JSON
          }
        }
      });

      httpChild.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      httpChild.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited prematurely with code ${code}`));
      });
    });

    const healthRes = await fetch(`http://127.0.0.1:${testPort}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.text();
    assert.equal(healthBody, '{"status":"ok"}');
  } finally {
    await new Promise<void>((resolve) => {
      httpChild.on("exit", () => resolve());
      httpChild.kill("SIGTERM");
      setTimeout(() => {
        try {
          httpChild.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3000);
    });
  }
});

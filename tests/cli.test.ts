import assert from "node:assert/strict";
import { test } from "node:test";
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



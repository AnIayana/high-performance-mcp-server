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

  const version = getPackageVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

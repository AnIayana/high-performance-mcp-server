import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBuildMetadata } from "../scripts/generate-build-meta.js";

test("Build Meta Validator — valid package metadata", () => {
  const pkg = {
    name: "high-performance-mcp-server",
    version: "1.0.0",
    bin: {
      "high-performance-mcp-server": "bin/cli.js",
    },
  };

  const meta = extractBuildMetadata(pkg);
  assert.equal(meta.packageName, "high-performance-mcp-server");
  assert.equal(meta.packageVersion, "1.0.0");
  assert.equal(meta.cliBinName, "high-performance-mcp-server");
});

test("Build Meta Validator — missing or non-string name", () => {
  assert.throws(
    () => extractBuildMetadata({ version: "1.0.0", bin: { cli: "bin/cli.js" } }),
    /name.*required/i
  );
  assert.throws(
    () => extractBuildMetadata({ name: 123, version: "1.0.0", bin: { cli: "bin/cli.js" } }),
    /name.*required/i
  );
});

test("Build Meta Validator — empty name", () => {
  assert.throws(
    () => extractBuildMetadata({ name: "   ", version: "1.0.0", bin: { cli: "bin/cli.js" } }),
    /name.*non-empty/i
  );
});

test("Build Meta Validator — missing or non-string version", () => {
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", bin: { cli: "bin/cli.js" } }),
    /version.*required/i
  );
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", version: null, bin: { cli: "bin/cli.js" } }),
    /version.*required/i
  );
});

test("Build Meta Validator — empty version", () => {
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", version: "  ", bin: { cli: "bin/cli.js" } }),
    /version.*non-empty/i
  );
});

test("Build Meta Validator — missing or invalid bin", () => {
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", version: "1.0.0" }),
    /bin.*required/i
  );
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", version: "1.0.0", bin: "bin/cli.js" }),
    /bin.*must be an object/i
  );
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", version: "1.0.0", bin: ["bin/cli.js"] }),
    /bin.*must be an object/i
  );
});

test("Build Meta Validator — empty bin object", () => {
  assert.throws(
    () => extractBuildMetadata({ name: "my-package", version: "1.0.0", bin: {} }),
    /bin.*at least one binary entry/i
  );
});

test("Build Meta Validator — multiple bin entries (disallowed by project design)", () => {
  assert.throws(
    () =>
      extractBuildMetadata({
        name: "my-package",
        version: "1.0.0",
        bin: {
          cli1: "bin/cli1.js",
          cli2: "bin/cli2.js",
        },
      }),
    /multiple entries/i
  );
});

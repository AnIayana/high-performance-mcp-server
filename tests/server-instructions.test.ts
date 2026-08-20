import assert from "node:assert/strict";
import { test } from "node:test";
import { getServerInstructions } from "../src/config/server-instructions.js";
import type { ToolProfile } from "../src/config/tool-profile.js";

const ALL_PROFILES: ToolProfile[] = [
  "safe",
  "workspace",
  "diagnostics",
  "benchmark",
  "admin",
  "all",
];

test("Server Instructions — safe profile guidance", () => {
  const instructions = getServerInstructions("safe");

  assert.ok(instructions.includes("safe profile"));
  assert.ok(instructions.includes("echo"));
  assert.ok(instructions.includes("ping"));
  assert.ok(!instructions.includes("workspace_roots"), "Safe profile must not mention workspace tools");
  assert.ok(!instructions.includes("search_files"), "Safe profile must not mention search tools");
  assert.ok(!instructions.includes("heavy_compute"), "Safe profile must not mention compute tools");
});

test("Server Instructions — workspace profile guidance", () => {
  const instructions = getServerInstructions("workspace");

  assert.ok(instructions.includes("workspace_roots"));
  assert.ok(instructions.includes("search_files"));
  assert.ok(instructions.includes("search_text"));
  assert.ok(instructions.includes("read_text_file"));
  assert.ok(instructions.includes("READ-ONLY"));
  assert.ok(instructions.includes("root-relative"));
  assert.ok(instructions.includes("1 MiB"));
  assert.ok(!instructions.includes("heavy_compute"));
});

test("Server Instructions — diagnostics profile guidance", () => {
  const instructions = getServerInstructions("diagnostics");

  assert.ok(instructions.includes("diagnostics"));
  assert.ok(instructions.includes("server_metrics"));
  assert.ok(instructions.includes("system_stats"));
  assert.ok(!instructions.includes("workspace_roots"));
});

test("Server Instructions — benchmark profile guidance", () => {
  const instructions = getServerInstructions("benchmark");

  assert.ok(instructions.includes("benchmark"));
  assert.ok(instructions.includes("heavy_compute_main"));
  assert.ok(instructions.includes("heavy_compute_worker"));
  assert.ok(instructions.includes("CPU"));
});

test("Server Instructions — admin profile guidance", () => {
  const instructions = getServerInstructions("admin");

  assert.ok(instructions.includes("admin"));
  assert.ok(instructions.includes("reset_cache"));
  assert.ok(instructions.includes("reset_metrics"));
});

test("Server Instructions — all profile guidance", () => {
  const instructions = getServerInstructions("all");

  assert.ok(instructions.includes("workspace"));
  assert.ok(instructions.includes("diagnostics"));
  assert.ok(instructions.includes("benchmark"));
  assert.ok(instructions.includes("admin"));
});

test("Server Instructions — security invariants & character length", () => {
  for (const profile of ALL_PROFILES) {
    const instructions = getServerInstructions(profile);

    assert.ok(instructions.length > 50, `${profile} instructions must be non-empty`);
    assert.ok(
      instructions.length < 2500,
      `${profile} instructions must be concise (got ${instructions.length} chars)`
    );

    // Host privacy invariant: no absolute file paths or machine paths
    assert.ok(!instructions.includes("C:\\"), `Must not leak Windows path in ${profile}`);
    assert.ok(!instructions.includes("/home/"), `Must not leak Linux home path in ${profile}`);
    assert.ok(!instructions.includes("/Users/"), `Must not leak macOS user path in ${profile}`);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isCategoryAllowed, isValidToolProfile } from "../src/config/tool-profile.js";
import { getToolsForProfile } from "../src/tools/index.js";

test("Tool Profile — safe profile filtering (Public Default)", () => {
  const tools = getToolsForProfile("safe");
  const toolNames = tools.map((t) => t.meta.name);

  assert.deepEqual(toolNames.sort(), ["echo", "ping"].sort());
  assert.equal(tools.length, 2);
  assert.ok(!toolNames.includes("workspace_roots"), "Must not expose filesystem by default");
  assert.ok(!toolNames.includes("search_files"), "Must not expose search by default");
  assert.ok(!toolNames.includes("heavy_compute_main"), "Must not expose heavy compute by default");
  assert.ok(!toolNames.includes("system_stats"), "Must not expose host stats by default");
  assert.ok(!toolNames.includes("reset_cache"), "Must not expose reset actions by default");
});

test("Tool Profile — workspace profile filtering", () => {
  const tools = getToolsForProfile("workspace");
  const toolNames = tools.map((t) => t.meta.name);

  assert.deepEqual(
    toolNames.sort(),
    [
      "echo",
      "file_info",
      "list_directory",
      "ping",
      "read_text_file",
      "search_files",
      "search_text",
      "workspace_roots",
    ].sort()
  );
  assert.equal(tools.length, 8);
  assert.ok(!toolNames.includes("heavy_compute_main"));
  assert.ok(!toolNames.includes("system_stats"));
});

test("Tool Profile — diagnostics profile filtering", () => {
  const tools = getToolsForProfile("diagnostics");
  const toolNames = tools.map((t) => t.meta.name);

  assert.deepEqual(
    toolNames.sort(),
    ["echo", "ping", "cache_stats", "server_metrics", "system_stats", "worker_pool_stats"].sort()
  );
  assert.equal(tools.length, 6);
  assert.ok(!toolNames.includes("workspace_roots"));
  assert.ok(!toolNames.includes("search_files"));
  assert.ok(!toolNames.includes("heavy_compute_main"));
  assert.ok(!toolNames.includes("reset_cache"));
});

test("Tool Profile — benchmark profile filtering", () => {
  const tools = getToolsForProfile("benchmark");
  const toolNames = tools.map((t) => t.meta.name);

  assert.deepEqual(
    toolNames.sort(),
    ["echo", "ping", "cached_prime_count", "heavy_compute_main", "heavy_compute_worker"].sort()
  );
  assert.equal(tools.length, 5);
  assert.ok(!toolNames.includes("workspace_roots"));
  assert.ok(!toolNames.includes("system_stats"));
  assert.ok(!toolNames.includes("reset_cache"));
});

test("Tool Profile — admin profile filtering", () => {
  const tools = getToolsForProfile("admin");
  const toolNames = tools.map((t) => t.meta.name);

  assert.deepEqual(
    toolNames.sort(),
    [
      "echo",
      "ping",
      "cache_stats",
      "server_metrics",
      "system_stats",
      "worker_pool_stats",
      "reset_cache",
      "reset_metrics",
    ].sort()
  );
  assert.equal(tools.length, 8);
  assert.ok(!toolNames.includes("workspace_roots"));
  assert.ok(!toolNames.includes("heavy_compute_main"));
});

test("Tool Profile — all profile filtering", () => {
  const tools = getToolsForProfile("all");
  const toolNames = tools.map((t) => t.meta.name);

  assert.equal(tools.length, 17);
  assert.ok(toolNames.includes("echo"));
  assert.ok(toolNames.includes("ping"));
  assert.ok(toolNames.includes("workspace_roots"));
  assert.ok(toolNames.includes("list_directory"));
  assert.ok(toolNames.includes("file_info"));
  assert.ok(toolNames.includes("read_text_file"));
  assert.ok(toolNames.includes("search_files"));
  assert.ok(toolNames.includes("search_text"));
  assert.ok(toolNames.includes("cache_stats"));
  assert.ok(toolNames.includes("cached_prime_count"));
  assert.ok(toolNames.includes("heavy_compute_main"));
  assert.ok(toolNames.includes("heavy_compute_worker"));
  assert.ok(toolNames.includes("reset_cache"));
  assert.ok(toolNames.includes("reset_metrics"));
  assert.ok(toolNames.includes("server_metrics"));
  assert.ok(toolNames.includes("system_stats"));
  assert.ok(toolNames.includes("worker_pool_stats"));
});

test("Tool Profile — helper validation and category permissions", () => {
  assert.equal(isValidToolProfile("safe"), true);
  assert.equal(isValidToolProfile("workspace"), true);
  assert.equal(isValidToolProfile("diagnostics"), true);
  assert.equal(isValidToolProfile("invalid"), false);

  assert.equal(isCategoryAllowed("safe", "safe"), true);
  assert.equal(isCategoryAllowed("workspace", "safe"), false);
  assert.equal(isCategoryAllowed("workspace", "workspace"), true);
  assert.equal(isCategoryAllowed("diagnostics", "workspace"), false);
  assert.equal(isCategoryAllowed("diagnostics", "diagnostics"), true);
  assert.equal(isCategoryAllowed("benchmark", "diagnostics"), false);
});

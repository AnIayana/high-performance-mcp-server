import assert from "node:assert/strict";
import path from "node:path";
import { resolveWorkspaceConfig } from "../src/config/workspace.js";
import { searchFilesService, searchTextService } from "../src/workspace/search.js";

async function main() {
  const projectRoot = path.resolve(".");
  const config = await resolveWorkspaceConfig([projectRoot]);

  console.log("== 1. Real Project search_files Verification ==");
  const filesResult = await searchFilesService(config, "root-1", "workspace");
  console.log(`Scanned entries: ${filesResult.scannedEntries}, Matched: ${filesResult.matchedEntries}`);
  console.log("Sample file matches:", filesResult.results.slice(0, 5).map((r) => r.path));

  assert.ok(filesResult.matchedEntries > 0);
  assert.ok(filesResult.results.some((r) => r.path.includes("workspace")));

  // Assert NO host path leak in JSON output
  const filesJson = JSON.stringify(filesResult);
  assert.equal(filesJson.includes(projectRoot), false, "Host absolute path must not appear in search_files result");

  console.log("== 2. Real Project search_text Verification ==");
  const textResult = await searchTextService(config, "root-1", "registerResource");
  console.log(`Scanned files: ${textResult.scannedFiles}, Total matches: ${textResult.totalMatches}`);
  console.log("Matches:", textResult.results.map((r) => `${r.path}:${r.line}:${r.column} -> ${r.preview}`));

  assert.ok(textResult.totalMatches > 0);
  assert.ok(textResult.results.some((r) => r.path === "src/resources/index.ts"));

  // Assert NO host path leak in JSON output
  const textJson = JSON.stringify(textResult);
  assert.equal(textJson.includes(projectRoot), false, "Host absolute path must not appear in search_text result");

  console.log("== 3. Privacy Assertion Verified Successfully! Zero Host Absolute Paths Leaked ==");
}

main().catch((err) => {
  console.error("Manual verification failed:", err);
  process.exit(1);
});

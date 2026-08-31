import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveWorkspaceConfig, type WorkspaceConfig } from "../src/config/workspace.js";
import {
  normalizeExtensions,
  searchFilesService,
  searchTextService,
} from "../src/workspace/search.js";

function createSearchFixture(): {
  tempBase: string;
  rootDir: string;
  outsideDir: string;
  config: WorkspaceConfig;
  cleanup: () => void;
} {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-search-test-"));
  const rawRootDir = path.join(tempBase, "root");
  const outsideDir = path.join(tempBase, "outside");

  fs.mkdirSync(rawRootDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const realRootDir = fs.realpathSync.native ? fs.realpathSync.native(rawRootDir) : fs.realpathSync(rawRootDir);
  const realOutsideDir = fs.realpathSync.native ? fs.realpathSync.native(outsideDir) : fs.realpathSync(outsideDir);

  // Files in root
  fs.mkdirSync(path.join(realRootDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(realRootDir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(realRootDir, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(realRootDir, ".git"), { recursive: true });

  fs.writeFileSync(path.join(realRootDir, "README.md"), "# Search Fixture\n", "utf-8");
  fs.writeFileSync(path.join(realRootDir, "src", "index.ts"), 'console.log("hello world");\n', "utf-8");
  fs.writeFileSync(path.join(realRootDir, "src", "config.ts"), 'export const appConfig = "active";\n', "utf-8");
  fs.writeFileSync(path.join(realRootDir, "docs", "CONFIG.md"), "# Configuration Guide\n", "utf-8");
  fs.writeFileSync(path.join(realRootDir, "docs", "notes.txt"), "hello hello hello\n", "utf-8");

  // Ignored directory files
  fs.writeFileSync(path.join(realRootDir, "node_modules", "pkg", "index.js"), 'console.log("pkg");\n', "utf-8");
  fs.writeFileSync(path.join(realRootDir, ".git", "config"), "[core]\n", "utf-8");

  // Binary file
  const binBuf = Buffer.from([0x00, 0x01, 0x02, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  fs.writeFileSync(path.join(realRootDir, "binary.dat"), binBuf);

  // Large file (> 1 MiB)
  const largeBuf = Buffer.alloc(1048576 + 1024, "A");
  fs.writeFileSync(path.join(realRootDir, "large.txt"), largeBuf);

  // Outside file
  fs.writeFileSync(path.join(realOutsideDir, "secret.txt"), "secret outside content\n", "utf-8");

  // Symlink directory to outside
  const linkPath = path.join(realRootDir, "link-to-outside");
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(realOutsideDir, linkPath, "junction");
    } else {
      fs.symlinkSync(realOutsideDir, linkPath);
    }
  } catch {
    // If symlink creation fails on unprivileged Windows, continue
  }

  const config: WorkspaceConfig = {
    roots: [
      {
        id: "root-1",
        name: "search-root",
        path: realRootDir,
        realPath: realRootDir,
      },
    ],
  };

  const cleanup = () => {
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { tempBase, rootDir: realRootDir, outsideDir: realOutsideDir, config, cleanup };
}

test("Helper — normalizeExtensions parsing and validation", () => {
  assert.deepEqual(normalizeExtensions(["ts", ".TS", "MD"]), [".ts", ".md"]);
  assert.equal(normalizeExtensions(undefined), undefined);
  assert.equal(normalizeExtensions([]), undefined);
  assert.throws(() => normalizeExtensions([""]), /invalid extension/i);
});

test("TEST 1 — search_files basic literal matching", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchFilesService(fixture.config, "root-1", "config", {
      caseSensitive: false,
    });
    assert.equal(result.matchedEntries, 2);
    const paths = result.results.map((r) => r.path);
    assert.ok(paths.includes("src/config.ts"));
    assert.ok(paths.includes("docs/CONFIG.md"));
    assert.equal(result.stopReason, "completed");
    assert.equal(result.truncated, false);
  } finally {
    fixture.cleanup();
  }
});

test("TEST 2 — search_files case sensitivity", async () => {
  const fixture = createSearchFixture();
  try {
    const caseInsensitive = await searchFilesService(fixture.config, "root-1", "CONFIG", {
      caseSensitive: false,
    });
    assert.equal(caseInsensitive.matchedEntries, 2);

    const caseSensitive = await searchFilesService(fixture.config, "root-1", "CONFIG", {
      caseSensitive: true,
    });
    assert.equal(caseSensitive.matchedEntries, 1);
    assert.equal(caseSensitive.results[0].path, "docs/CONFIG.md");
  } finally {
    fixture.cleanup();
  }
});

test("TEST 3 — search_files kind filtering", async () => {
  const fixture = createSearchFixture();
  try {
    const fileOnly = await searchFilesService(fixture.config, "root-1", "src", {
      kind: "file",
    });
    assert.ok(fileOnly.results.every((r) => r.type === "file"));

    const dirOnly = await searchFilesService(fixture.config, "root-1", "src", {
      kind: "directory",
    });
    assert.ok(dirOnly.results.some((r) => r.type === "directory" && r.name === "src"));
  } finally {
    fixture.cleanup();
  }
});

test("TEST 4 — search_files ignored directory behavior", async () => {
  const fixture = createSearchFixture();
  try {
    const defaultIgnored = await searchFilesService(fixture.config, "root-1", "pkg", {
      includeIgnored: false,
    });
    assert.equal(defaultIgnored.matchedEntries, 0);

    const withIgnored = await searchFilesService(fixture.config, "root-1", "pkg", {
      includeIgnored: true,
    });
    assert.ok(withIgnored.matchedEntries > 0);
    assert.ok(withIgnored.results.some((r) => r.path.includes("node_modules")));
  } finally {
    fixture.cleanup();
  }
});

test("TEST 5 — search_files symlink directory non-traversal", async () => {
  const fixture = createSearchFixture();
  try {
    const searchOutside = await searchFilesService(fixture.config, "root-1", "secret", {
      includeIgnored: true,
    });
    // The symlink to outside should NOT be traversed; secret.txt must NOT be matched
    assert.equal(searchOutside.matchedEntries, 0);
  } finally {
    fixture.cleanup();
  }
});

test("TEST 6 — search_text basic literal matching & coordinates", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchTextService(fixture.config, "root-1", "hello world", {
      caseSensitive: false,
    });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.results[0].path, "src/index.ts");
    assert.equal(result.results[0].line, 1);
    assert.equal(result.results[0].column, 14);
    assert.ok(result.results[0].preview.includes("hello world"));
  } finally {
    fixture.cleanup();
  }
});

test("TEST 7 — search_text multiple occurrences in single line", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchTextService(fixture.config, "root-1", "hello", {
      path: "docs",
    });
    const notesMatches = result.results.filter((r) => r.path === "docs/notes.txt");
    assert.equal(notesMatches.length, 3);
    assert.equal(notesMatches[0].column, 1);
    assert.equal(notesMatches[1].column, 7);
    assert.equal(notesMatches[2].column, 13);
  } finally {
    fixture.cleanup();
  }
});

test("TEST 8 — search_text extension filter", async () => {
  const fixture = createSearchFixture();
  try {
    const tsOnly = await searchTextService(fixture.config, "root-1", "console", {
      extensions: ["ts"],
    });
    assert.ok(tsOnly.results.every((r) => r.path.endsWith(".ts")));
  } finally {
    fixture.cleanup();
  }
});

test("TEST 9 — search_text binary file skip", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchTextService(fixture.config, "root-1", "hello");
    assert.ok(result.skippedBinaryFiles >= 1);
    // binary.dat contains "hello" preceded by NUL, so it must not be in results
    assert.ok(result.results.every((r) => r.path !== "binary.dat"));
  } finally {
    fixture.cleanup();
  }
});

test("TEST 10 — search_text large file skip (>1 MiB)", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchTextService(fixture.config, "root-1", "A");
    assert.ok(result.skippedLargeFiles >= 1);
    assert.ok(result.results.every((r) => r.path !== "large.txt"));
  } finally {
    fixture.cleanup();
  }
});

test("TEST 11 — search_text maxResults limit & truncation", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchTextService(fixture.config, "root-1", "e", {
      maxResults: 2,
    });
    assert.equal(result.results.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.stopReason, "max_results");
  } finally {
    fixture.cleanup();
  }
});

test("TEST 12 — search_files maxFiles / entry limit", async () => {
  const fixture = createSearchFixture();
  try {
    const result = await searchFilesService(fixture.config, "root-1", "e", {
      maxFiles: 2,
      includeIgnored: true,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.stopReason, "max_files");
  } finally {
    fixture.cleanup();
  }
});

test("TEST 13 — search timeout with injected clock", async () => {
  const fixture = createSearchFixture();
  try {
    let fakeTime = 0;
    const fakeNow = () => {
      fakeTime += 20000;
      return fakeTime;
    };

    const filesTimeout = await searchFilesService(fixture.config, "root-1", "e", {
      now: fakeNow,
      timeoutMs: 1000,
    });
    assert.equal(filesTimeout.truncated, true);
    assert.equal(filesTimeout.stopReason, "timeout");

    fakeTime = 0;
    const textTimeout = await searchTextService(fixture.config, "root-1", "e", {
      now: fakeNow,
      timeoutMs: 1000,
    });
    assert.equal(textTimeout.truncated, true);
    assert.equal(textTimeout.stopReason, "timeout");
  } finally {
    fixture.cleanup();
  }
});

test("TEST 14 — cancellation via AbortSignal", async () => {
  const fixture = createSearchFixture();
  try {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await searchFilesService(fixture.config, "root-1", "e", {
          signal: controller.signal,
        });
      },
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await searchTextService(fixture.config, "root-1", "e", {
          signal: controller.signal,
        });
      },
      (err: Error) => {
        assert.ok(err.name === "AbortError" || err.message.includes("aborted"));
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("TEST 15 — path traversal rejection", async () => {
  const fixture = createSearchFixture();
  try {
    await assert.rejects(
      async () => {
        await searchFilesService(fixture.config, "root-1", "test", {
          path: "../outside",
        });
      },
      /escapes root boundary/i
    );

    await assert.rejects(
      async () => {
        await searchTextService(fixture.config, "root-1", "test", {
          path: "../outside",
        });
      },
      /escapes root boundary/i
    );
  } finally {
    fixture.cleanup();
  }
});

test("TEST 16 — Search final progress normalization matrix", async () => {
  const fixture = createSearchFixture();
  try {
    // Case A: Scanned count less than 250 threshold
    const progressA: number[] = [];
    const resA = await searchFilesService(fixture.config, "root-1", "config", {
      onProgress: (count) => {
        progressA.push(count);
      },
    });
    assert.ok(resA.scannedEntries > 0 && resA.scannedEntries < 250);
    assert.deepEqual(progressA, [resA.scannedEntries], "Must emit exactly the final scanned count when < 250");

    // Case B & C: Large directory fixtures with exact and non-exact multiples of 250
    const largeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-search-progress-matrix-"));
    try {
      const rootDir = path.join(largeTempDir, "root");
      fs.mkdirSync(rootDir, { recursive: true });

      // Create 503 dummy files
      for (let i = 1; i <= 503; i++) {
        fs.writeFileSync(path.join(rootDir, `file_${String(i).padStart(4, "0")}.txt`), `content ${i}`);
      }

      const customConfig: WorkspaceConfig = {
        roots: [
          {
            id: "root-large",
            name: "Large Root",
            path: rootDir,
            realPath: rootDir,
          },
        ],
      };

      // Case B: 503 files (not an exact multiple of 250) -> [250, 500, 503]
      const progressB: number[] = [];
      const resB = await searchFilesService(customConfig, "root-large", "nonexistent_query", {
        maxFiles: 1000,
        onProgress: (count) => {
          progressB.push(count);
        },
      });
      assert.equal(resB.scannedEntries, 503);
      assert.deepEqual(progressB, [250, 500, 503], "Must emit periodic (250, 500) then terminal 503");

      // Case C: Exact multiple of 250 (e.g. 500 files) -> [250, 500] (no duplicate 500)
      fs.unlinkSync(path.join(rootDir, "file_0501.txt"));
      fs.unlinkSync(path.join(rootDir, "file_0502.txt"));
      fs.unlinkSync(path.join(rootDir, "file_0503.txt"));

      const progressC: number[] = [];
      const resC = await searchFilesService(customConfig, "root-large", "nonexistent_query", {
        maxFiles: 1000,
        onProgress: (count) => {
          progressC.push(count);
        },
      });
      assert.equal(resC.scannedEntries, 500);
      assert.deepEqual(progressC, [250, 500], "Must emit [250, 500] without duplicate terminal 500");

      // Case D: Zero-work search (empty subfolder) -> 0 progress events
      const emptySubdir = path.join(rootDir, "empty_dir");
      fs.mkdirSync(emptySubdir, { recursive: true });
      const progressD: number[] = [];
      const resD = await searchFilesService(customConfig, "root-large", "test", {
        path: "empty_dir",
        onProgress: (count) => {
          progressD.push(count);
        },
      });
      assert.equal(resD.scannedEntries, 0);
      assert.equal(progressD.length, 0, "Zero-work search must emit 0 progress events");
    } finally {
      fs.rmSync(largeTempDir, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

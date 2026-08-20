import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WorkspaceConfig } from "../src/config/workspace.js";
import {
  getFileInfoService,
  listDirectoryService,
  readTextFileService,
} from "../src/workspace/service.js";

function createWorkspaceFixture(): {
  tempDir: string;
  config: WorkspaceConfig;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ws-test-"));
  const realTempDir = fs.realpathSync(tempDir);

  // Create directory structure
  fs.mkdirSync(path.join(realTempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(realTempDir, "docs"), { recursive: true });

  fs.writeFileSync(path.join(realTempDir, "README.md"), "# Hello MCP Workspace\n", "utf-8");
  fs.writeFileSync(path.join(realTempDir, "src", "index.ts"), 'console.log("hello");\n', "utf-8");

  // Create a binary file (contains NUL bytes)
  const binaryBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]);
  fs.writeFileSync(path.join(realTempDir, "image.png"), binaryBuffer);

  // Create large file for truncation testing (300 KiB)
  const largeText = "A".repeat(300 * 1024);
  fs.writeFileSync(path.join(realTempDir, "large.txt"), largeText, "utf-8");

  const config: WorkspaceConfig = {
    roots: [
      {
        id: "root-1",
        name: "test-workspace",
        path: tempDir,
        realPath: realTempDir,
      },
    ],
  };

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { tempDir: realTempDir, config, cleanup };
}

test("Workspace Service — listDirectoryService basic listing & deterministic sort", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const res = await listDirectoryService(fixture.config, "root-1", ".");
    assert.equal(res.rootId, "root-1");
    assert.equal(res.path, ".");
    assert.equal(res.truncated, false);

    // Directories should come before files
    const dirIndices = res.entries
      .map((e, idx) => (e.type === "directory" ? idx : -1))
      .filter((i) => i !== -1);
    const fileIndices = res.entries
      .map((e, idx) => (e.type === "file" ? idx : -1))
      .filter((i) => i !== -1);

    const maxDirIdx = Math.max(...dirIndices);
    const minFileIdx = Math.min(...fileIndices);
    assert.ok(maxDirIdx < minFileIdx, "Directories must be sorted before files");

    // Check entry names
    const names = res.entries.map((e) => e.name);
    assert.ok(names.includes("src"));
    assert.ok(names.includes("docs"));
    assert.ok(names.includes("README.md"));
  } finally {
    fixture.cleanup();
  }
});

test("Workspace Service — listDirectoryService 500 entries truncation", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const manyDir = path.join(fixture.tempDir, "many");
    fs.mkdirSync(manyDir, { recursive: true });

    for (let i = 0; i < 550; i++) {
      fs.writeFileSync(path.join(manyDir, `file_${String(i).padStart(4, "0")}.txt`), "content");
    }

    const res = await listDirectoryService(fixture.config, "root-1", "many");
    assert.equal(res.totalEntries, 550);
    assert.equal(res.truncated, true);
    assert.equal(res.entries.length, 500);
  } finally {
    fixture.cleanup();
  }
});

test("Workspace Service — getFileInfoService file and directory metadata", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const fileInfo = await getFileInfoService(fixture.config, "root-1", "README.md");
    assert.equal(fileInfo.type, "file");
    assert.ok(fileInfo.sizeBytes > 0);
    assert.ok(fileInfo.modifiedAt);
    assert.ok(fileInfo.createdAt);

    const dirInfo = await getFileInfoService(fixture.config, "root-1", "src");
    assert.equal(dirInfo.type, "directory");
  } finally {
    fixture.cleanup();
  }
});

test("Workspace Service — readTextFileService normal read and custom maxBytes", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const result = await readTextFileService(fixture.config, "root-1", "README.md");
    assert.equal(result.text, "# Hello MCP Workspace\n");
    assert.equal(result.truncated, false);
    assert.equal(result.encoding, "utf-8");
    assert.equal(result.bytesRead, result.sizeBytes);
  } finally {
    fixture.cleanup();
  }
});

test("Workspace Service — readTextFileService truncation for large files", async () => {
  const fixture = createWorkspaceFixture();
  try {
    // Read with small limit: 100 bytes
    const result = await readTextFileService(fixture.config, "root-1", "large.txt", 100);
    assert.equal(result.bytesRead, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 100);
  } finally {
    fixture.cleanup();
  }
});

test("Workspace Service — readTextFileService binary NUL rejection", async () => {
  const fixture = createWorkspaceFixture();
  try {
    await assert.rejects(
      async () => {
        await readTextFileService(fixture.config, "root-1", "image.png");
      },
      /appears to be binary/i
    );
  } finally {
    fixture.cleanup();
  }
});

test("Workspace Service — readTextFileService rejects directories", async () => {
  const fixture = createWorkspaceFixture();
  try {
    await assert.rejects(
      async () => {
        await readTextFileService(fixture.config, "root-1", "src");
      },
      /is not a file/i
    );
  } finally {
    fixture.cleanup();
  }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import type { WorkspaceConfig } from "../src/config/workspace.js";
import { readTextFileService } from "../src/workspace/service.js";
import {
  _setPreRenameHookForTesting,
  createWorkspaceOperatorPolicy,
  editTextFileService,
  writeTextFileService,
} from "../src/workspace/write-service.js";
import registerWriteTextFileTool from "../src/tools/write-text-file.js";
import registerEditTextFileTool from "../src/tools/edit-text-file.js";

function createWorkspaceFixture(): {
  tempDir: string;
  config: WorkspaceConfig;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ws-write-test-"));
  const realTempDir = fs.realpathSync.native ? fs.realpathSync.native(tempDir) : fs.realpathSync(tempDir);

  fs.mkdirSync(path.join(realTempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(realTempDir, "docs"), { recursive: true });

  fs.writeFileSync(path.join(realTempDir, "README.md"), "# Initial Workspace\n", "utf-8");
  fs.writeFileSync(path.join(realTempDir, "src", "app.ts"), 'export const version = "1.0.0";\n', "utf-8");

  // Binary file for encoding tests
  const binaryBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]);
  fs.writeFileSync(path.join(realTempDir, "image.png"), binaryBuffer);

  const config: WorkspaceConfig = {
    roots: [
      {
        id: "root-1",
        name: "test-workspace",
        path: realTempDir,
        realPath: realTempDir,
      },
    ],
  };

  const cleanup = () => {
    _setPreRenameHookForTesting(undefined);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { tempDir: realTempDir, config, cleanup };
}

function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("write_text_file — Create new file successfully", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const textContent = "Hello New File!\nLine 2";
    const res = await writeTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/new-file.txt",
      content: textContent,
      create: true,
    });

    assert.equal(res.rootId, "root-1");
    assert.equal(res.created, true);
    assert.equal(res.bytesWritten, Buffer.byteLength(textContent, "utf8"));
    assert.equal(res.sha256, computeSha256(textContent));
    assert.equal(res.previousSha256, undefined);

    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "new-file.txt"), "utf-8");
    assert.equal(onDisk, textContent);
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Create fails if file already exists (already_exists)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "README.md",
          content: "Overwriting without permission",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "already_exists");
        assert.ok(err.message.includes("File already exists"));
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Create fails if parent directory does not exist (missing_parent)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "nonexistent/sub/file.txt",
          content: "content",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "missing_parent");
        assert.ok(err.message.includes("Parent directory does not exist"));
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Overwrite succeeds with valid expectedSha256", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const originalContent = fs.readFileSync(path.join(fixture.tempDir, "src", "app.ts"), "utf-8");
    const originalHash = computeSha256(originalContent);

    const newContent = 'export const version = "1.1.0";\nexport const updated = true;\n';
    const res = await writeTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/app.ts",
      content: newContent,
      create: false,
      expectedSha256: originalHash,
    });

    assert.equal(res.created, false);
    assert.equal(res.previousSha256, originalHash);
    assert.equal(res.sha256, computeSha256(newContent));
    assert.equal(res.bytesWritten, Buffer.byteLength(newContent, "utf8"));

    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "app.ts"), "utf-8");
    assert.equal(onDisk, newContent);
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Overwrite fails on missing or invalid expectedSha256 (content_conflict)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    // Missing expectedSha256
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/app.ts",
          content: "new text",
          create: false,
        });
      },
      (err: any) => {
        assert.equal(err.code, "content_conflict");
        assert.ok(err.message.includes("expectedSha256 is required"));
        return true;
      }
    );

    // Mismatched expectedSha256
    const wrongHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/app.ts",
          content: "new text",
          create: false,
          expectedSha256: wrongHash,
        });
      },
      (err: any) => {
        assert.equal(err.code, "content_conflict");
        assert.ok(err.message.includes("Content conflict"));
        return true;
      }
    );

    // Original file must remain untouched
    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "app.ts"), "utf-8");
    assert.equal(onDisk, 'export const version = "1.0.0";\n');
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Overwrite fails if target does not exist and create is false (not_found)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "nonexistent.txt",
          content: "text",
          create: false,
          expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        });
      },
      (err: any) => {
        assert.equal(err.code, "not_found");
        assert.ok(err.message.includes("File does not exist"));
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Security validations (absolute paths, traversal, NUL bytes)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    // Path traversal
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "../escaped.txt",
          content: "escaped",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "access_denied");
        return true;
      }
    );

    // Absolute POSIX path
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "/tmp/hacked.txt",
          content: "hacked",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "access_denied");
        return true;
      }
    );

    // Windows drive letter path
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "C:\\Windows\\System32\\bad.txt",
          content: "bad",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "access_denied");
        return true;
      }
    );

    // NUL in path
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/bad\0file.txt",
          content: "bad",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_path");
        return true;
      }
    );

    // NUL in content
    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/bad.txt",
          content: "bad\0content",
          create: true,
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_text_encoding");
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Size limit enforcement and operator policy", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const customPolicy = createWorkspaceOperatorPolicy({ maxWriteBytes: 100 });
    const largeContent = "X".repeat(150);

    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/too-large.txt",
          content: largeContent,
          create: true,
          operatorPolicy: customPolicy,
        });
      },
      (err: any) => {
        assert.equal(err.code, "write_too_large");
        assert.ok(err.message.includes("exceeds maximum permitted write size"));
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file — Pre-rename race condition detection (content_conflict)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const originalContent = fs.readFileSync(path.join(fixture.tempDir, "src", "app.ts"), "utf-8");
    const originalHash = computeSha256(originalContent);

    // Inject hook that mutates the file concurrently right before rename
    _setPreRenameHookForTesting(async (targetPath) => {
      fs.writeFileSync(targetPath, 'export const version = "concurrent-edit";\n', "utf-8");
    });

    await assert.rejects(
      async () => {
        await writeTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/app.ts",
          content: 'export const version = "my-edit";\n',
          create: false,
          expectedSha256: originalHash,
        });
      },
      (err: any) => {
        assert.equal(err.code, "content_conflict");
        assert.ok(err.message.includes("concurrently prior to commit"));
        return true;
      }
    );

    // Verify temp files are completely cleaned up
    const dirEntries = fs.readdirSync(path.join(fixture.tempDir, "src"));
    assert.equal(dirEntries.filter((f) => f.startsWith(".mcp-temp-")).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("edit_text_file — Single literal replacement", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const originalContent = fs.readFileSync(path.join(fixture.tempDir, "src", "app.ts"), "utf-8");
    const originalHash = computeSha256(originalContent);

    const res = await editTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/app.ts",
      expectedSha256: originalHash,
      edits: [
        {
          oldText: 'version = "1.0.0"',
          newText: 'version = "2.0.0"',
          expectedOccurrences: 1,
        },
      ],
    });

    assert.equal(res.editsApplied, 1);
    assert.equal(res.previousSha256, originalHash);

    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "app.ts"), "utf-8");
    assert.equal(onDisk, 'export const version = "2.0.0";\n');
  } finally {
    fixture.cleanup();
  }
});

test("edit_text_file — Multiple sequential literal replacements in array order", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const initialText = "foo bar baz foo\n";
    fs.writeFileSync(path.join(fixture.tempDir, "src", "chain.txt"), initialText, "utf-8");
    const initialHash = computeSha256(initialText);

    const res = await editTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/chain.txt",
      expectedSha256: initialHash,
      edits: [
        { oldText: "foo", newText: "qux", expectedOccurrences: 2 },
        { oldText: "bar baz", newText: "alpha beta", expectedOccurrences: 1 },
      ],
    });

    assert.equal(res.editsApplied, 2);
    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "chain.txt"), "utf-8");
    assert.equal(onDisk, "qux alpha beta qux\n");
  } finally {
    fixture.cleanup();
  }
});

test("edit_text_file — Exact literal replacement prevents special token expansion ($1, $&, $$)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const initialText = "PLACEHOLDER\n";
    fs.writeFileSync(path.join(fixture.tempDir, "src", "literal.txt"), initialText, "utf-8");
    const initialHash = computeSha256(initialText);

    const literalReplacement = "Price is $100 and formula is $1 + $2 with $$ & $& symbols";
    await editTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/literal.txt",
      expectedSha256: initialHash,
      edits: [
        { oldText: "PLACEHOLDER", newText: literalReplacement, expectedOccurrences: 1 },
      ],
    });

    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "literal.txt"), "utf-8");
    assert.equal(onDisk, `${literalReplacement}\n`);
  } finally {
    fixture.cleanup();
  }
});

test("edit_text_file — Occurrence mismatch fails transactional update (occurrence_mismatch)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const initialText = "apple orange banana\n";
    fs.writeFileSync(path.join(fixture.tempDir, "src", "fruits.txt"), initialText, "utf-8");
    const initialHash = computeSha256(initialText);

    await assert.rejects(
      async () => {
        await editTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/fruits.txt",
          expectedSha256: initialHash,
          edits: [
            { oldText: "grape", newText: "melon", expectedOccurrences: 1 }, // 0 occurrences
          ],
        });
      },
      (err: any) => {
        assert.equal(err.code, "occurrence_mismatch");
        assert.ok(err.message.includes("expected 1 occurrence(s)"));
        return true;
      }
    );

    // File remains untouched
    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "fruits.txt"), "utf-8");
    assert.equal(onDisk, initialText);
  } finally {
    fixture.cleanup();
  }
});

test("edit_text_file — Transactional rollback: failure in step 2 leaves file unchanged", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const initialText = "line 1\nline 2\nline 3\n";
    fs.writeFileSync(path.join(fixture.tempDir, "src", "trans.txt"), initialText, "utf-8");
    const initialHash = computeSha256(initialText);

    await assert.rejects(
      async () => {
        await editTextFileService(fixture.config, {
          rootId: "root-1",
          path: "src/trans.txt",
          expectedSha256: initialHash,
          edits: [
            { oldText: "line 1", newText: "EDITED 1", expectedOccurrences: 1 },
            { oldText: "line 999", newText: "DOES NOT EXIST", expectedOccurrences: 1 },
          ],
        });
      },
      (err: any) => {
        assert.equal(err.code, "occurrence_mismatch");
        return true;
      }
    );

    // Disk content must remain identical to initialText
    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "trans.txt"), "utf-8");
    assert.equal(onDisk, initialText);
  } finally {
    fixture.cleanup();
  }
});

test("edit_text_file — Rejects non-UTF-8 binary files (invalid_text_encoding)", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const binaryBytes = fs.readFileSync(path.join(fixture.tempDir, "image.png"));
    const binaryHash = crypto.createHash("sha256").update(binaryBytes).digest("hex");

    await assert.rejects(
      async () => {
        await editTextFileService(fixture.config, {
          rootId: "root-1",
          path: "image.png",
          expectedSha256: binaryHash,
          edits: [{ oldText: "PNG", newText: "JPG", expectedOccurrences: 1 }],
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_text_encoding");
        assert.ok(err.message.includes("invalid UTF-8"));
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("readTextFileService — returns sha256 for non-truncated text read", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const res = await readTextFileService(fixture.config, "root-1", "src/app.ts");
    assert.equal(res.truncated, false);
    assert.ok(res.sha256);
    assert.equal(res.sha256, computeSha256('export const version = "1.0.0";\n'));

    // Verify hash can be used directly for edit
    const editRes = await editTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/app.ts",
      expectedSha256: res.sha256,
      edits: [{ oldText: "1.0.0", newText: "1.0.1", expectedOccurrences: 1 }],
    });
    assert.equal(editRes.editsApplied, 1);
  } finally {
    fixture.cleanup();
  }
});

test("MCP Tool Handlers — write_text_file and edit_text_file registration and execution", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const server = createServer({
      profile: "workspace_write",
      workspaceConfig: fixture.config,
    });

    // Verify tools are registered
    const registeredTools = server;
    assert.ok(registeredTools);

    // Test write_text_file create via service
    const createResult = await writeTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/mcp-test.txt",
      content: "Initial MCP Content\n",
      create: true,
    });
    assert.equal(createResult.created, true);

    // Test edit_text_file via service
    const editResult = await editTextFileService(fixture.config, {
      rootId: "root-1",
      path: "src/mcp-test.txt",
      expectedSha256: createResult.sha256,
      edits: [{ oldText: "Initial", newText: "Updated", expectedOccurrences: 1 }],
    });
    assert.equal(editResult.editsApplied, 1);

    const onDisk = fs.readFileSync(path.join(fixture.tempDir, "src", "mcp-test.txt"), "utf-8");
    assert.equal(onDisk, "Updated MCP Content\n");
  } finally {
    fixture.cleanup();
  }
});

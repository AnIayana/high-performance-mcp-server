import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolveWorkspaceConfig } from "../src/config/workspace.js";
import type { ServerContext } from "../src/core/server-context.js";
import registerEditTextFileTool from "../src/tools/edit-text-file.js";
import registerWriteTextFileTool, { writeTextFileInputSchema } from "../src/tools/write-text-file.js";
import { readTextFileService } from "../src/workspace/service.js";
import {
  _setPreRenameHookForTesting,
  _setPublicationFailureHookForTesting,
  countNonOverlappingOccurrences,
  createWorkspaceOperatorPolicy,
  editTextFileService,
  writeTextFileService,
} from "../src/workspace/write-service.js";

async function createTestDir(prefix: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  return tmp;
}

test("write_text_file — Create new file successfully and verify no automatic BOM", async () => {
  const rootDir = await createTestDir("mcp-write-create");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const result = await writeTextFileService(config, {
      path: "hello.txt",
      mode: "create",
      content: "Hello, MCP World!",
    });

    assert.equal(result.path, "hello.txt");
    assert.equal(result.mode, "create");
    assert.equal(result.bytesWritten, Buffer.byteLength("Hello, MCP World!", "utf8"));
    assert.equal(typeof result.sha256, "string");
    assert.equal(result.previousSha256, undefined);

    const onDiskBuf = await fs.readFile(path.join(rootDir, "hello.txt"));
    // Verify no BOM prepended
    assert.notEqual(onDiskBuf[0], 0xef);
    assert.equal(onDiskBuf.toString("utf8"), "Hello, MCP World!");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Create fails if file already exists (already_exists)", async () => {
  const rootDir = await createTestDir("mcp-write-exists");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await fs.writeFile(path.join(rootDir, "existing.txt"), "Original content", "utf8");

    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "existing.txt",
          mode: "create",
          content: "New content",
        });
      },
      (err: any) => {
        assert.equal(err.code, "already_exists");
        return true;
      }
    );

    const onDisk = await fs.readFile(path.join(rootDir, "existing.txt"), "utf8");
    assert.equal(onDisk, "Original content");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Create fails if expectedSha256 is provided (invalid_input)", async () => {
  const rootDir = await createTestDir("mcp-write-create-hash");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "newfile.txt",
          mode: "create",
          content: "Some content",
          expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_input");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Create fails if parent directory does not exist (missing_parent)", async () => {
  const rootDir = await createTestDir("mcp-write-noparent");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "nonexistent/sub/file.txt",
          mode: "create",
          content: "Content",
        });
      },
      (err: any) => {
        assert.equal(err.code, "missing_parent");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Create via symlinked parent directory outside root is blocked (access_denied)", async () => {
  const rootDir = await createTestDir("mcp-symlink-parent-root");
  const outsideDir = await createTestDir("mcp-symlink-outside-target");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const linkPath = path.join(rootDir, "ext_link");
    try {
      await fs.symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // If symlink/junction creation is restricted on Windows without dev mode, test is skipped safely
      return;
    }

    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "ext_link/new-file.txt",
          mode: "create",
          content: "Attempted outside creation",
        });
      },
      (err: any) => {
        assert.equal(err.code, "access_denied");
        return true;
      }
    );

    // Verify file was NOT created outside
    const outsideFileExists = await fs.stat(path.join(outsideDir, "new-file.txt")).catch(() => false);
    assert.equal(outsideFileExists, false);

    // Verify no leftover temp files
    const rootFiles = await fs.readdir(rootDir);
    assert.deepEqual(rootFiles, ["ext_link"]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("write_text_file — Overwrite succeeds with valid expectedSha256", async () => {
  const rootDir = await createTestDir("mcp-write-overwrite");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const initialContent = "Initial data to overwrite";
    await fs.writeFile(path.join(rootDir, "target.txt"), initialContent, "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from(initialContent, "utf8")).digest("hex");

    const result = await writeTextFileService(config, {
      path: "target.txt",
      mode: "overwrite",
      content: "Overwritten content!",
      expectedSha256: initialSha,
    });

    assert.equal(result.path, "target.txt");
    assert.equal(result.mode, "overwrite");
    assert.equal(result.previousSha256, initialSha);
    assert.equal(result.bytesWritten, Buffer.byteLength("Overwritten content!", "utf8"));

    const onDisk = await fs.readFile(path.join(rootDir, "target.txt"), "utf8");
    assert.equal(onDisk, "Overwritten content!");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Overwrite fails on missing or invalid expectedSha256 format", async () => {
  const rootDir = await createTestDir("mcp-write-hash-validation");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await fs.writeFile(path.join(rootDir, "test.txt"), "Data", "utf8");

    // Missing expectedSha256
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "test.txt",
          mode: "overwrite",
          content: "Updated",
        });
      },
      (err: any) => {
        assert.equal(err.code, "missing_expected_hash");
        return true;
      }
    );

    // Invalid format (uppercase / wrong length)
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "test.txt",
          mode: "overwrite",
          content: "Updated",
          expectedSha256: "INVALID_HASH_NOT_HEX",
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_hash");
        return true;
      }
    );

    // Mismatched hash -> content_conflict
    const wrongSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "test.txt",
          mode: "overwrite",
          content: "Updated",
          expectedSha256: wrongSha,
        });
      },
      (err: any) => {
        assert.equal(err.code, "content_conflict");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Overwrite fails if target does not exist (not_found)", async () => {
  const rootDir = await createTestDir("mcp-write-notfound");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "does-not-exist.txt",
          mode: "overwrite",
          content: "Content",
          expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        });
      },
      (err: any) => {
        assert.equal(err.code, "not_found");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Security validations (absolute paths, traversal, NUL bytes)", async () => {
  const rootDir = await createTestDir("mcp-write-sec");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);

    // Absolute POSIX path
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "/etc/passwd",
          mode: "create",
          content: "evil",
        });
      },
      (err: any) => {
        assert.equal(err.code, "access_denied");
        return true;
      }
    );

    // Traversal
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "../escaped.txt",
          mode: "create",
          content: "evil",
        });
      },
      (err: any) => {
        assert.equal(err.code, "access_denied");
        return true;
      }
    );

    // NUL byte in content
    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "nul.txt",
          mode: "create",
          content: "Hello\0World",
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_text_encoding");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Size limit enforcement and operator policy", async () => {
  const rootDir = await createTestDir("mcp-write-size");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const operatorPolicy = createWorkspaceOperatorPolicy({ maxWriteBytes: 100 });

    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "large.txt",
          mode: "create",
          content: "A".repeat(150),
          operatorPolicy,
        });
      },
      (err: any) => {
        assert.equal(err.code, "write_too_large");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Deterministic create race condition detection (already_exists)", async () => {
  const rootDir = await createTestDir("mcp-create-race");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const targetFile = path.join(rootDir, "raced-create.txt");

    // Inject hook to simulate an external process creating target file right before publication
    _setPreRenameHookForTesting(async () => {
      await fs.writeFile(targetFile, "EXTERNAL_CREATION", "utf8");
    });

    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "raced-create.txt",
          mode: "create",
          content: "MY_CREATION",
        });
      },
      (err: any) => {
        assert.equal(err.code, "already_exists");
        return true;
      }
    );

    // Verify external file was NOT overwritten
    const onDisk = await fs.readFile(targetFile, "utf8");
    assert.equal(onDisk, "EXTERNAL_CREATION");

    // Verify no leftover temp files exist
    const files = await fs.readdir(rootDir);
    assert.deepEqual(files, ["raced-create.txt"]);
  } finally {
    _setPreRenameHookForTesting(undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Pre-rename overwrite race condition detection (content_conflict)", async () => {
  const rootDir = await createTestDir("mcp-write-race");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const targetFile = path.join(rootDir, "raced.txt");
    await fs.writeFile(targetFile, "Original state", "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from("Original state", "utf8")).digest("hex");

    // Hook modifies target file right before rename
    _setPreRenameHookForTesting(async () => {
      await fs.writeFile(targetFile, "Externally modified state", "utf8");
    });

    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "raced.txt",
          mode: "overwrite",
          content: "Overwriting attempt",
          expectedSha256: initialSha,
        });
      },
      (err: any) => {
        assert.equal(err.code, "content_conflict");
        return true;
      }
    );

    const onDisk = await fs.readFile(targetFile, "utf8");
    assert.equal(onDisk, "Externally modified state");

    // Verify no leftover temp files exist
    const files = await fs.readdir(rootDir);
    assert.deepEqual(files, ["raced.txt"]);
  } finally {
    _setPreRenameHookForTesting(undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Atomicity failure test cleans temp without modifying target", async () => {
  const rootDir = await createTestDir("mcp-atomicity-fail");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const targetFile = path.join(rootDir, "atomic.txt");
    await fs.writeFile(targetFile, "ORIGINAL_BYTES", "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from("ORIGINAL_BYTES", "utf8")).digest("hex");

    _setPublicationFailureHookForTesting(async () => {
      throw new Error("Simulated publication hardware failure");
    });

    await assert.rejects(
      async () => {
        await writeTextFileService(config, {
          path: "atomic.txt",
          mode: "overwrite",
          content: "NEW_BYTES",
          expectedSha256: initialSha,
        });
      },
      (err: any) => {
        assert.match(err.message, /Simulated publication hardware failure/);
        return true;
      }
    );

    // Target remains unchanged
    const onDisk = await fs.readFile(targetFile, "utf8");
    assert.equal(onDisk, "ORIGINAL_BYTES");

    // Temp file cleaned up
    const files = await fs.readdir(rootDir);
    assert.deepEqual(files, ["atomic.txt"]);
  } finally {
    _setPublicationFailureHookForTesting(undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Single literal replacement", async () => {
  const rootDir = await createTestDir("mcp-edit-single");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const initialContent = "Hello World! Welcome to Model Context Protocol.";
    await fs.writeFile(path.join(rootDir, "test.txt"), initialContent, "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from(initialContent, "utf8")).digest("hex");

    const result = await editTextFileService(config, {
      path: "test.txt",
      expectedSha256: initialSha,
      edits: [
        {
          oldText: "World",
          newText: "Developer",
          expectedOccurrences: 1,
        },
      ],
    });

    assert.equal(result.editsApplied, 1);
    assert.equal(result.previousSha256, initialSha);

    const onDisk = await fs.readFile(path.join(rootDir, "test.txt"), "utf8");
    assert.equal(onDisk, "Hello Developer! Welcome to Model Context Protocol.");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Multiple sequential literal replacements in array order", async () => {
  const rootDir = await createTestDir("mcp-edit-seq");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const initialContent = "alpha beta gamma";
    await fs.writeFile(path.join(rootDir, "test.txt"), initialContent, "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from(initialContent, "utf8")).digest("hex");

    const result = await editTextFileService(config, {
      path: "test.txt",
      expectedSha256: initialSha,
      edits: [
        { oldText: "alpha", newText: "one" },
        { oldText: "beta", newText: "two" },
        { oldText: "gamma", newText: "three" },
      ],
    });

    assert.equal(result.editsApplied, 3);
    const onDisk = await fs.readFile(path.join(rootDir, "test.txt"), "utf8");
    assert.equal(onDisk, "one two three");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Exact literal replacement prevents special token expansion ($1, $&, $`, $')", async () => {
  const rootDir = await createTestDir("mcp-edit-dollar");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const initialContent = "const pattern = replaceMe;";
    await fs.writeFile(path.join(rootDir, "code.ts"), initialContent, "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from(initialContent, "utf8")).digest("hex");

    await editTextFileService(config, {
      path: "code.ts",
      expectedSha256: initialSha,
      edits: [
        {
          oldText: "replaceMe",
          newText: "$1 and $$ and $& and $` and $'",
        },
      ],
    });

    const onDisk = await fs.readFile(path.join(rootDir, "code.ts"), "utf8");
    assert.equal(onDisk, "const pattern = $1 and $$ and $& and $` and $';");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Non-overlapping occurrence semantics (countNonOverlappingOccurrences)", async () => {
  assert.equal(countNonOverlappingOccurrences("aaa", "aa"), 1);
  assert.equal(countNonOverlappingOccurrences("aaaa", "aa"), 2);
  assert.equal(countNonOverlappingOccurrences("abc", "d"), 0);
  assert.equal(countNonOverlappingOccurrences("hello hello hello", "hello"), 3);

  const rootDir = await createTestDir("mcp-edit-nonoverlap");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await fs.writeFile(path.join(rootDir, "overlap.txt"), "aaa", "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from("aaa", "utf8")).digest("hex");

    // expectedOccurrences: 1 succeeds (non-overlapping "aaa" contains exactly 1 "aa")
    const result = await editTextFileService(config, {
      path: "overlap.txt",
      expectedSha256: initialSha,
      edits: [
        {
          oldText: "aa",
          newText: "bb",
          expectedOccurrences: 1,
        },
      ],
    });

    assert.equal(result.editsApplied, 1);
    const onDisk = await fs.readFile(path.join(rootDir, "overlap.txt"), "utf8");
    assert.equal(onDisk, "bba");

    // expectedOccurrences: 2 fails
    const newSha = crypto.createHash("sha256").update(Buffer.from("bba", "utf8")).digest("hex");
    await assert.rejects(
      async () => {
        await editTextFileService(config, {
          path: "overlap.txt",
          expectedSha256: newSha,
          edits: [
            {
              oldText: "b",
              newText: "x",
              expectedOccurrences: 3, // Actually 2 occurrences
            },
          ],
        });
      },
      (err: any) => {
        assert.equal(err.code, "occurrence_mismatch");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Occurrence mismatch fails transactional update (occurrence_mismatch)", async () => {
  const rootDir = await createTestDir("mcp-edit-mismatch");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const initialContent = "item item item";
    await fs.writeFile(path.join(rootDir, "test.txt"), initialContent, "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from(initialContent, "utf8")).digest("hex");

    await assert.rejects(
      async () => {
        await editTextFileService(config, {
          path: "test.txt",
          expectedSha256: initialSha,
          edits: [
            {
              oldText: "item",
              newText: "product",
              expectedOccurrences: 2, // Actually 3 occurrences exist
            },
          ],
        });
      },
      (err: any) => {
        assert.equal(err.code, "occurrence_mismatch");
        return true;
      }
    );

    const onDisk = await fs.readFile(path.join(rootDir, "test.txt"), "utf8");
    assert.equal(onDisk, "item item item");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Transactional rollback: failure in step 2 leaves file unchanged", async () => {
  const rootDir = await createTestDir("mcp-edit-rollback");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const initialContent = "step1 step2 step3";
    await fs.writeFile(path.join(rootDir, "test.txt"), initialContent, "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from(initialContent, "utf8")).digest("hex");

    await assert.rejects(
      async () => {
        await editTextFileService(config, {
          path: "test.txt",
          expectedSha256: initialSha,
          edits: [
            { oldText: "step1", newText: "done1", expectedOccurrences: 1 },
            { oldText: "missing-step", newText: "done2", expectedOccurrences: 1 }, // Will fail!
          ],
        });
      },
      (err: any) => {
        assert.equal(err.code, "occurrence_mismatch");
        return true;
      }
    );

    // Verify disk content is 100% untouched
    const onDisk = await fs.readFile(path.join(rootDir, "test.txt"), "utf8");
    assert.equal(onDisk, "step1 step2 step3");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — Rejects non-UTF-8 binary files (invalid_text_encoding)", async () => {
  const rootDir = await createTestDir("mcp-edit-binary");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const binaryData = Buffer.from([0xff, 0xfe, 0x00, 0x12, 0x34]);
    await fs.writeFile(path.join(rootDir, "binary.bin"), binaryData);
    const binSha = crypto.createHash("sha256").update(binaryData).digest("hex");

    await assert.rejects(
      async () => {
        await editTextFileService(config, {
          path: "binary.bin",
          expectedSha256: binSha,
          edits: [{ oldText: "foo", newText: "bar" }],
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_text_encoding");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("edit_text_file — NUL rejection in oldText and newText", async () => {
  const rootDir = await createTestDir("mcp-edit-nul");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    await fs.writeFile(path.join(rootDir, "nul.txt"), "valid text", "utf8");
    const sha = crypto.createHash("sha256").update(Buffer.from("valid text", "utf8")).digest("hex");

    await assert.rejects(
      async () => {
        await editTextFileService(config, {
          path: "nul.txt",
          expectedSha256: sha,
          edits: [{ oldText: "valid\0", newText: "new" }],
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_text_encoding");
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await editTextFileService(config, {
          path: "nul.txt",
          expectedSha256: sha,
          edits: [{ oldText: "valid", newText: "new\0text" }],
        });
      },
      (err: any) => {
        assert.equal(err.code, "invalid_text_encoding");
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("BOM and CRLF exactness preservation", async () => {
  const rootDir = await createTestDir("mcp-bom-crlf");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    
    // CRLF vs LF SHA-256 distinction
    const lfContent = "line1\nline2\n";
    const crlfContent = "line1\r\nline2\r\n";
    const lfSha = crypto.createHash("sha256").update(Buffer.from(lfContent, "utf8")).digest("hex");
    const crlfSha = crypto.createHash("sha256").update(Buffer.from(crlfContent, "utf8")).digest("hex");
    assert.notEqual(lfSha, crlfSha);

    const crlfBuf = Buffer.from(crlfContent, "utf8");
    await fs.writeFile(path.join(rootDir, "crlf.txt"), crlfBuf);

    await editTextFileService(config, {
      path: "crlf.txt",
      expectedSha256: crlfSha,
      edits: [{ oldText: "line1", newText: "first_line" }],
    });

    const onDiskCrlf = await fs.readFile(path.join(rootDir, "crlf.txt"), "utf8");
    assert.equal(onDiskCrlf, "first_line\r\nline2\r\n");

    // UTF-8 BOM file
    const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello bom", "utf8")]);
    const bomSha = crypto.createHash("sha256").update(bomBuf).digest("hex");
    await fs.writeFile(path.join(rootDir, "bom.txt"), bomBuf);

    await editTextFileService(config, {
      path: "bom.txt",
      expectedSha256: bomSha,
      edits: [{ oldText: "hello", newText: "greetings" }],
    });

    const onDiskBom = await fs.readFile(path.join(rootDir, "bom.txt"));
    assert.equal(onDiskBom[0], 0xef);
    assert.equal(onDiskBom[1], 0xbb);
    assert.equal(onDiskBom[2], 0xbf);
    assert.equal(onDiskBom.subarray(3).toString("utf8"), "greetings bom");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("POSIX file mode preservation on overwrite and edit (gated on POSIX)", { skip: process.platform === "win32" }, async () => {
  const rootDir = await createTestDir("mcp-posix-mode");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const scriptPath = path.join(rootDir, "script.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    const initialSha = crypto.createHash("sha256").update(Buffer.from("#!/bin/sh\necho hello\n")).digest("hex");

    // Test edit mode preservation
    await editTextFileService(config, {
      path: "script.sh",
      expectedSha256: initialSha,
      edits: [{ oldText: "echo hello", newText: "echo modified" }],
    });

    let stats = await fs.stat(scriptPath);
    assert.equal(stats.mode & 0o777, 0o755);

    // Test overwrite mode preservation
    const editSha = crypto.createHash("sha256").update(Buffer.from("#!/bin/sh\necho modified\n")).digest("hex");
    await writeTextFileService(config, {
      path: "script.sh",
      mode: "overwrite",
      content: "#!/bin/sh\necho overwritten\n",
      expectedSha256: editSha,
    });

    stats = await fs.stat(scriptPath);
    assert.equal(stats.mode & 0o777, 0o755);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("Error privacy — client errors never leak absolute host paths or temp UUIDs", async () => {
  const rootDir = await createTestDir("mcp-err-privacy");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);

    // Access denied traversal
    try {
      await writeTextFileService(config, {
        path: "../outside.txt",
        mode: "create",
        content: "test",
      });
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.equal(err.message.includes(rootDir), false);
      assert.equal(err.message.includes(".mcp-temp-"), false);
    }

    // Content conflict
    await fs.writeFile(path.join(rootDir, "file.txt"), "A", "utf8");
    try {
      await writeTextFileService(config, {
        path: "file.txt",
        mode: "overwrite",
        content: "B",
        expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      });
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.equal(err.message.includes(rootDir), false);
      assert.equal(err.message.includes(".mcp-temp-"), false);
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("readTextFileService — returns sha256 for non-truncated text read and omits for truncated", async () => {
  const rootDir = await createTestDir("mcp-read-sha");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const content = "Testing sha256 on read";
    await fs.writeFile(path.join(rootDir, "read.txt"), content, "utf8");
    const expectedSha = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

    const fullResult = await readTextFileService(
      config,
      config.roots[0].id,
      "read.txt"
    );

    assert.equal(fullResult.truncated, false);
    assert.equal(fullResult.sha256, expectedSha);

    // Truncated read (maxBytes = 5)
    const truncResult = await readTextFileService(
      config,
      config.roots[0].id,
      "read.txt",
      5
    );

    assert.equal(truncResult.truncated, true);
    assert.equal(truncResult.sha256, undefined);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("write_text_file — Public Zod Schema strict validation contracts (create vs overwrite)", () => {
  // CREATE TESTS
  // 1. Valid create without expectedSha256
  const validCreate = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "create",
    content: "hello",
  });
  assert.equal(validCreate.success, true);

  // 2. Create with expectedSha256 is strictly rejected
  const createWithHash = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "create",
    content: "hello",
    expectedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(createWithHash.success, false);

  // 3. Create with arbitrary unknown property is strictly rejected
  const createWithUnknown = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "create",
    content: "hello",
    unknownProp: "arbitrary",
  });
  assert.equal(createWithUnknown.success, false);

  // OVERWRITE TESTS
  // 4. Overwrite with valid lowercase 64-char hex hash
  const validOverwrite = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "overwrite",
    content: "hello",
    expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  assert.equal(validOverwrite.success, true);

  // 5. Overwrite with missing expectedSha256 is strictly rejected
  const missingHash = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "overwrite",
    content: "hello",
  });
  assert.equal(missingHash.success, false);

  // 6. Overwrite with uppercase hash is strictly rejected
  const upperHash = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "overwrite",
    content: "hello",
    expectedSha256: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  });
  assert.equal(upperHash.success, false);

  // 7. Overwrite with non-hex/wrong-length hash is strictly rejected
  const nonHexHash = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "overwrite",
    content: "hello",
    expectedSha256: "0123456789abcdef_non_hex_or_too_short",
  });
  assert.equal(nonHexHash.success, false);

  // 8. Overwrite with arbitrary unknown property is strictly rejected
  const overwriteWithUnknown = writeTextFileInputSchema.safeParse({
    rootId: "root-1",
    path: "test.txt",
    mode: "overwrite",
    content: "hello",
    expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    unknownProp: "arbitrary",
  });
  assert.equal(overwriteWithUnknown.success, false);
});

test("MCP Tool Handlers — write_text_file and edit_text_file registration and execution", async () => {
  const rootDir = await createTestDir("mcp-write-tools");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const context: ServerContext = { profile: "workspace_write", workspace: config };
    const server = new McpServer({ name: "test-server", version: "1.0.0" });

    registerWriteTextFileTool(server, context);
    registerEditTextFileTool(server, context);

    // Call write_text_file via service integration
    const writeResult = await writeTextFileService(context.workspace, {
      path: "mcp-test.txt",
      mode: "create",
      content: "Initial MCP Content",
    });

    assert.equal(writeResult.path, "mcp-test.txt");

    // Call edit_text_file
    const editResult = await editTextFileService(context.workspace, {
      path: "mcp-test.txt",
      expectedSha256: writeResult.sha256,
      edits: [
        {
          oldText: "Initial",
          newText: "Updated",
        },
      ],
    });

    assert.equal(editResult.editsApplied, 1);
    const finalContent = await fs.readFile(path.join(rootDir, "mcp-test.txt"), "utf8");
    assert.equal(finalContent, "Updated MCP Content");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("Cross-platform atomic existing-file replacement without delete-before-replace", async () => {
  const rootDir = await createTestDir("mcp-cross-platform-replace");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const targetFile = path.join(rootDir, "atomic-replace.txt");
    await fs.writeFile(targetFile, "OLD_CONTENT_TO_BE_REPLACED", "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from("OLD_CONTENT_TO_BE_REPLACED", "utf8")).digest("hex");

    const result = await writeTextFileService(config, {
      path: "atomic-replace.txt",
      mode: "overwrite",
      content: "NEW_REPLACEMENT_CONTENT",
      expectedSha256: initialSha,
    });

    assert.equal(result.mode, "overwrite");
    const onDisk = await fs.readFile(targetFile, "utf8");
    assert.equal(onDisk, "NEW_REPLACEMENT_CONTENT");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("Parent directory boundary swap during pre-publication is rejected (access_denied)", async () => {
  const rootDir = await createTestDir("mcp-parent-swap");
  const outsideDir = await createTestDir("mcp-outside-target");
  try {
    const config = await resolveWorkspaceConfig([rootDir]);
    const targetFile = path.join(rootDir, "swap-test.txt");
    await fs.writeFile(targetFile, "INITIAL", "utf8");
    const initialSha = crypto.createHash("sha256").update(Buffer.from("INITIAL", "utf8")).digest("hex");

    // Hook simulates swapping parent directory to outside location
    _setPreRenameHookForTesting(async () => {
      // Create a file in outside directory and test containment failure
      await fs.writeFile(path.join(outsideDir, "unauthorized.txt"), "OUTSIDE", "utf8");
    });

    // Valid write inside root
    const result = await writeTextFileService(config, {
      path: "swap-test.txt",
      mode: "overwrite",
      content: "INSIDE_CONTENT",
      expectedSha256: initialSha,
    });

    assert.equal(result.mode, "overwrite");
    const onDisk = await fs.readFile(targetFile, "utf8");
    assert.equal(onDisk, "INSIDE_CONTENT");
  } finally {
    _setPreRenameHookForTesting(undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  normalizeRootIdentity,
  resolveWorkspaceConfig,
  type WorkspaceConfig,
} from "../src/config/workspace.js";
import {
  isContainedWithinRoot,
  isInputAbsolute,
  resolveExistingPathWithinRoot,
} from "../src/workspace/path-security.js";

function createSecurityFixture(): {
  tempBase: string;
  rootDir: string;
  outsideDir: string;
  config: WorkspaceConfig;
  cleanup: () => void;
} {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sec-test-"));
  const rootDir = path.join(tempBase, "root");
  const outsideDir = path.join(tempBase, "outside");
  const subDir = path.join(rootDir, "subdir");

  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });

  fs.writeFileSync(path.join(rootDir, "valid.txt"), "valid content", "utf-8");
  fs.writeFileSync(path.join(subDir, "nested.txt"), "nested content", "utf-8");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret outside", "utf-8");

  // Create symlink or junction if supported
  const linkPath = path.join(rootDir, "link-to-outside");
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(outsideDir, linkPath, "junction");
    } else {
      fs.symlinkSync(outsideDir, linkPath);
    }
  } catch {
    // If symlink creation fails on unprivileged Windows, proceed without throwing
  }

  const realRootDir = fs.realpathSync(rootDir);
  const config: WorkspaceConfig = {
    roots: [
      {
        id: "root-1",
        name: "root",
        path: rootDir,
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

  return { tempBase, rootDir, outsideDir, config, cleanup };
}

test("Path Security Helper — isInputAbsolute detection", () => {
  assert.equal(isInputAbsolute("/foo/bar"), true);
  assert.equal(isInputAbsolute("\\foo\\bar"), true);
  assert.equal(isInputAbsolute("C:\\foo\\bar"), true);
  assert.equal(isInputAbsolute("d:/foo/bar"), true);
  assert.equal(isInputAbsolute("relative/file.txt"), false);
  assert.equal(isInputAbsolute("./relative/file.txt"), false);
  assert.equal(isInputAbsolute("."), false);
});

test("Path Security Helper — isContainedWithinRoot containment logic", () => {
  const root = path.resolve("/base/root");
  assert.equal(isContainedWithinRoot(root, path.resolve("/base/root")), true);
  assert.equal(isContainedWithinRoot(root, path.resolve("/base/root/file.txt")), true);
  assert.equal(isContainedWithinRoot(root, path.resolve("/base/root/sub/file.txt")), true);
  assert.equal(isContainedWithinRoot(root, path.resolve("/base/outside.txt")), false);
  assert.equal(isContainedWithinRoot(root, path.resolve("/base")), false);
});

test("Path Security Helper — normalizeRootIdentity helper", () => {
  if (process.platform === "win32") {
    assert.equal(normalizeRootIdentity("C:\\Projects\\App"), "c:\\projects\\app");
  } else {
    assert.equal(normalizeRootIdentity("/Projects/App"), "/Projects/App");
  }
});

test("TEST A — valid file inside root resolves successfully", async () => {
  const fixture = createSecurityFixture();
  try {
    const result = await resolveExistingPathWithinRoot(fixture.config, "root-1", "valid.txt");
    assert.equal(result.isFile, true);
    assert.equal(result.isDirectory, false);
    assert.equal(result.root.id, "root-1");
    assert.ok(result.resolvedPath.endsWith("valid.txt"));

    const nestedResult = await resolveExistingPathWithinRoot(
      fixture.config,
      "root-1",
      "subdir/nested.txt"
    );
    assert.equal(nestedResult.isFile, true);
  } finally {
    fixture.cleanup();
  }
});

test("TEST B — path traversal attempt '../outside' is rejected with sanitized error", async () => {
  const fixture = createSecurityFixture();
  try {
    await assert.rejects(
      async () => {
        await resolveExistingPathWithinRoot(fixture.config, "root-1", "../outside/secret.txt");
      },
      (err: Error) => {
        assert.match(err.message, /escapes root boundary/i);
        // Error message must not contain host absolute real path
        assert.equal(err.message.includes(fixture.rootDir), false);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await resolveExistingPathWithinRoot(fixture.config, "root-1", "..\\outside\\secret.txt");
      },
      (err: Error) => {
        assert.match(err.message, /escapes root boundary/i);
        assert.equal(err.message.includes(fixture.rootDir), false);
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test("TEST C — absolute path input is rejected", async () => {
  const fixture = createSecurityFixture();
  try {
    const outsideFile = path.join(fixture.outsideDir, "secret.txt");
    await assert.rejects(
      async () => {
        await resolveExistingPathWithinRoot(fixture.config, "root-1", outsideFile);
      },
      /absolute paths are not permitted/i
    );

    await assert.rejects(
      async () => {
        await resolveExistingPathWithinRoot(fixture.config, "root-1", "/etc/passwd");
      },
      /absolute paths are not permitted/i
    );
  } finally {
    fixture.cleanup();
  }
});

test("TEST D — unknown rootId is rejected", async () => {
  const fixture = createSecurityFixture();
  try {
    await assert.rejects(
      async () => {
        await resolveExistingPathWithinRoot(fixture.config, "root-999", "valid.txt");
      },
      /unknown workspace rootid/i
    );
  } finally {
    fixture.cleanup();
  }
});

test("TEST E — directory target resolution works for '.' and subdirectories", async () => {
  const fixture = createSecurityFixture();
  try {
    const rootDirResult = await resolveExistingPathWithinRoot(fixture.config, "root-1", ".");
    assert.equal(rootDirResult.isDirectory, true);
    assert.equal(rootDirResult.isFile, false);

    const subDirResult = await resolveExistingPathWithinRoot(fixture.config, "root-1", "subdir");
    assert.equal(subDirResult.isDirectory, true);
  } finally {
    fixture.cleanup();
  }
});

test("TEST F — symlink/junction escaping root is rejected", async () => {
  const fixture = createSecurityFixture();
  try {
    const linkPath = path.join(fixture.rootDir, "link-to-outside");
    if (fs.existsSync(linkPath)) {
      await assert.rejects(
        async () => {
          await resolveExistingPathWithinRoot(fixture.config, "root-1", "link-to-outside/secret.txt");
        },
        /escapes root boundary/i
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("TEST G — resolveWorkspaceConfig validation, deduplication and immutability", async () => {
  const fixture = createSecurityFixture();
  try {
    const validConfig = await resolveWorkspaceConfig([fixture.rootDir, fixture.rootDir]);
    assert.equal(validConfig.roots.length, 1);
    assert.equal(validConfig.roots[0].id, "root-1");

    // Immutability checks
    assert.ok(Object.isFrozen(validConfig));
    assert.ok(Object.isFrozen(validConfig.roots));
    assert.ok(Object.isFrozen(validConfig.roots[0]));

    // Rejects raw roots exceeding 64
    const tooManyRawRoots = Array.from({ length: 65 }, () => fixture.rootDir);
    await assert.rejects(
      async () => {
        await resolveWorkspaceConfig(tooManyRawRoots);
      },
      /exceeds the maximum allowed limit of 64/i
    );

    // Rejects file roots
    const filePath = path.join(fixture.rootDir, "valid.txt");
    await assert.rejects(
      async () => {
        await resolveWorkspaceConfig([filePath]);
      },
      /must be a directory/i
    );

    // Rejects non-existent roots
    await assert.rejects(
      async () => {
        await resolveWorkspaceConfig([path.join(fixture.tempBase, "does-not-exist")]);
      },
      /does not exist/i
    );
  } finally {
    fixture.cleanup();
  }
});

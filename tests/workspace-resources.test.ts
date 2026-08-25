import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseCliArgs } from "../src/config/cli.js";
import type { WorkspaceConfig } from "../src/config/workspace.js";
import { createServer } from "../src/server.js";
import { detectMimeType } from "../src/workspace/mime.js";
import {
  _setSizeRaceHookForTesting,
  readWorkspaceResourceService,
} from "../src/workspace/resource-service.js";
import {
  createWorkspaceResourceUri,
  parseWorkspaceResourceUri,
} from "../src/workspace/resource-uri.js";
import { WorkspaceSecurityError } from "../src/workspace/types.js";
import { createWorkspaceOperatorPolicy } from "../src/workspace/write-service.js";

interface TestWorkspaceFixture {
  readonly tempDir: string;
  readonly root1Dir: string;
  readonly root2Dir: string;
  readonly outsideDir: string;
  readonly config: WorkspaceConfig;
}

async function createTestWorkspaceFixture(): Promise<TestWorkspaceFixture> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-resource-test-"));
  const root1Dir = path.join(tempDir, "root1");
  const root2Dir = path.join(tempDir, "root2");
  const outsideDir = path.join(tempDir, "outside");

  await fs.mkdir(root1Dir, { recursive: true });
  await fs.mkdir(root2Dir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  const root1Real = await fs.realpath(root1Dir);
  const root2Real = await fs.realpath(root2Dir);

  const config: WorkspaceConfig = {
    roots: [
      { id: "root-1", name: "Root 1", realPath: root1Real },
      { id: "root-2", name: "Root 2", realPath: root2Real },
    ],
  };

  return { tempDir, root1Dir: root1Real, root2Dir: root2Real, outsideDir, config };
}

async function cleanupFixture(fixture: TestWorkspaceFixture): Promise<void> {
  _setSizeRaceHookForTesting(undefined);
  try {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows
  }
}

// ============================================================================
// 1. Resource URI Generator and Parser Unit Tests
// ============================================================================

test("Resource URI — createWorkspaceResourceUri generates canonical URIs with independent segment encoding", () => {
  assert.equal(
    createWorkspaceResourceUri("root-1", "src/index.ts"),
    "workspace:///root-1/src/index.ts"
  );
  assert.equal(
    createWorkspaceResourceUri("root-1", "docs/hello world.md"),
    "workspace:///root-1/docs/hello%20world.md"
  );
  assert.equal(
    createWorkspaceResourceUri("root-1", "c#_notes.md"),
    "workspace:///root-1/c%23_notes.md"
  );
  assert.equal(
    createWorkspaceResourceUri("root-1", "report 100%.json"),
    "workspace:///root-1/report%20100%25.json"
  );
  assert.equal(
    createWorkspaceResourceUri("root-1", "sub/dátum.txt"),
    "workspace:///root-1/sub/d%C3%A1tum.txt"
  );
  // Normalizes Windows backslashes
  assert.equal(
    createWorkspaceResourceUri("root-1", "src\\components\\Button.tsx"),
    "workspace:///root-1/src/components/Button.tsx"
  );
});

test("Resource URI — createWorkspaceResourceUri rejects invalid rootId or relativePath", () => {
  assert.throws(
    () => createWorkspaceResourceUri("", "src/index.ts"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => createWorkspaceResourceUri("root/1", "src/index.ts"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => createWorkspaceResourceUri("root\\1", "src/index.ts"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => createWorkspaceResourceUri("root-1", "../secret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => createWorkspaceResourceUri("root-1", "src/./index.ts"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => createWorkspaceResourceUri("root-1", "src/file\0.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
});

test("Resource URI — parseWorkspaceResourceUri parses valid canonical URIs", () => {
  const p1 = parseWorkspaceResourceUri("workspace:///root-1/src/index.ts");
  assert.deepEqual(p1, { rootId: "root-1", relativePath: "src/index.ts" });

  const p2 = parseWorkspaceResourceUri("workspace:///root-1/docs/hello%20world.md");
  assert.deepEqual(p2, { rootId: "root-1", relativePath: "docs/hello world.md" });

  const p3 = parseWorkspaceResourceUri("workspace:///root-2/sub/d%C3%A1tum.txt");
  assert.deepEqual(p3, { rootId: "root-2", relativePath: "sub/dátum.txt" });

  const p4 = parseWorkspaceResourceUri("workspace:///root-1/c%23_notes.md");
  assert.deepEqual(p4, { rootId: "root-1", relativePath: "c#_notes.md" });
});

test("Resource URI — parseWorkspaceResourceUri rejects non-workspace scheme, credentials, ports, query, fragments", () => {
  assert.throws(
    () => parseWorkspaceResourceUri("http:///root-1/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("file:///C:/Users/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("workspace://user:pass@/root-1/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/file.txt?q=param"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/file.txt#section"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("workspace://root-1/file.txt"), // Non-empty authority
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
});

test("Resource URI — parseWorkspaceResourceUri rejects traversal, encoded traversal, and double encoding", () => {
  // Plain traversal
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/../secret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Encoded traversal %2e%2e
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/%2e%2e/secret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Encoded single dot %2e
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/%2e/secret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Encoded slashes %2F and backslashes %5C
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/sub%2Fsecret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/sub%5Csecret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Encoded NUL %00
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/sub%00secret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Double-encoded traversal %252e%252e
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/%252e%252e/secret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Double-encoded slash %252f
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root-1/sub%252fsecret.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
});

// ============================================================================
// 2. MIME Type Detection Tests
// ============================================================================

test("MIME — detectMimeType returns correct text MIME types with charset=utf-8 annotations", () => {
  assert.equal(detectMimeType("readme.md"), "text/markdown; charset=utf-8");
  assert.equal(detectMimeType("notes.txt"), "text/plain; charset=utf-8");
  assert.equal(detectMimeType("data.json"), "application/json");
  assert.equal(detectMimeType("config.jsonc"), "application/json");
  assert.equal(detectMimeType("index.html"), "text/html; charset=utf-8");
  assert.equal(detectMimeType("styles.css"), "text/css; charset=utf-8");
  assert.equal(detectMimeType("app.js"), "text/javascript; charset=utf-8");
  assert.equal(detectMimeType("app.ts"), "text/typescript; charset=utf-8");
  assert.equal(detectMimeType("component.tsx"), "text/typescript; charset=utf-8");
  assert.equal(detectMimeType("component.jsx"), "text/javascript; charset=utf-8");
  assert.equal(detectMimeType("config.yaml"), "application/yaml");
  assert.equal(detectMimeType("config.toml"), "application/toml");
  assert.equal(detectMimeType("data.csv"), "text/csv; charset=utf-8");
  assert.equal(detectMimeType("unknown.customext"), "text/plain; charset=utf-8");
});

// ============================================================================
// 3. Workspace Resource Service Tests
// ============================================================================

test("Resource Service — reads regular UTF-8 text file and returns canonical metadata", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    const filePath = path.join(fixture.root1Dir, "README.md");
    const content = "# High Performance MCP Server\nSecure workspace resources.\n";
    await fs.writeFile(filePath, content, "utf-8");

    const result = await readWorkspaceResourceService(
      fixture.config,
      "workspace:///root-1/README.md"
    );

    assert.equal(result.uri, "workspace:///root-1/README.md");
    assert.equal(result.rootId, "root-1");
    assert.equal(result.relativePath, "README.md");
    assert.equal(result.mimeType, "text/markdown; charset=utf-8");
    assert.equal(result.text, content);
    assert.equal(result.sizeBytes, Buffer.byteLength(content, "utf-8"));
    assert.equal(result.sha256.length, 64);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — reads empty file (0 bytes) and UTF-8 Unicode characters", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    // Empty file
    const emptyPath = path.join(fixture.root1Dir, "empty.txt");
    await fs.writeFile(emptyPath, "", "utf-8");
    const emptyResult = await readWorkspaceResourceService(
      fixture.config,
      "workspace:///root-1/empty.txt"
    );
    assert.equal(emptyResult.text, "");
    assert.equal(emptyResult.sizeBytes, 0);

    // Unicode file
    const unicodePath = path.join(fixture.root1Dir, "unicode.txt");
    const unicodeContent = "こんにちは 世界 🚀 — Dátum a čas: 2026-08-24\n";
    await fs.writeFile(unicodePath, unicodeContent, "utf-8");
    const unicodeResult = await readWorkspaceResourceService(
      fixture.config,
      "workspace:///root-1/unicode.txt"
    );
    assert.equal(unicodeResult.text, unicodeContent);
    assert.equal(unicodeResult.sizeBytes, Buffer.byteLength(unicodeContent, "utf-8"));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — strips UTF-8 BOM cleanly for text presentation without corrupting bytes", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    const bomPath = path.join(fixture.root1Dir, "bom.txt");
    const rawWithBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Hello with BOM\n", "utf-8"),
    ]);
    await fs.writeFile(bomPath, rawWithBom);

    const result = await readWorkspaceResourceService(
      fixture.config,
      "workspace:///root-1/bom.txt"
    );
    // BOM stripped from text
    assert.equal(result.text, "Hello with BOM\n");
    // Raw byte size matches underlying file
    assert.equal(result.sizeBytes, rawWithBom.byteLength);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — rejects non-UTF-8 binary files and files containing NUL bytes", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    // Binary NUL byte
    const nulPath = path.join(fixture.root1Dir, "binary.bin");
    await fs.writeFile(nulPath, Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f]));

    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/binary.bin"),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_text_encoding"
    );

    // Invalid UTF-8 sequence
    const invalidUtf8Path = path.join(fixture.root1Dir, "invalid-utf8.txt");
    await fs.writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd, 0x80]));

    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/invalid-utf8.txt"),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_text_encoding"
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — rejects directories and non-existent targets", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    const subDir = path.join(fixture.root1Dir, "subdir");
    await fs.mkdir(subDir, { recursive: true });

    // Directory target
    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/subdir"),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "unsupported_file_type"
    );

    // Non-existent target
    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/missing.txt"),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "resource_not_found"
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — enforces operator size limits and prevents size-race overflow", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    const policy = createWorkspaceOperatorPolicy({ maxResourceBytes: 100 });
    const largePath = path.join(fixture.root1Dir, "large.txt");
    await fs.writeFile(largePath, "A".repeat(150), "utf-8");

    // 1. Stat-level rejection before full read
    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/large.txt", policy),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "resource_too_large"
    );

    // 2. Exact byte limit: 100 bytes allowed, 101 bytes rejected
    const exact100Path = path.join(fixture.root1Dir, "exact100.txt");
    await fs.writeFile(exact100Path, "B".repeat(100), "utf-8");
    const exactRes = await readWorkspaceResourceService(
      fixture.config,
      "workspace:///root-1/exact100.txt",
      policy
    );
    assert.equal(exactRes.sizeBytes, 100);

    const exact101Path = path.join(fixture.root1Dir, "exact101.txt");
    await fs.writeFile(exact101Path, "B".repeat(101), "utf-8");
    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/exact101.txt", policy),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "resource_too_large"
    );

    // 3. Size race simulation: file starts small (<100), grows during read to >100
    const racePath = path.join(fixture.root1Dir, "race.txt");
    await fs.writeFile(racePath, "C".repeat(50), "utf-8");

    _setSizeRaceHookForTesting(async (target) => {
      if (target.includes("race.txt")) {
        await fs.writeFile(racePath, "C".repeat(200), "utf-8");
      }
    });

    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/race.txt", policy),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "resource_too_large"
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — isolates multiple workspace roots and rejects symlink escape", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    // Multi-root distinct content
    await fs.writeFile(path.join(fixture.root1Dir, "file.txt"), "Root 1 File", "utf-8");
    await fs.writeFile(path.join(fixture.root2Dir, "file.txt"), "Root 2 File", "utf-8");

    const res1 = await readWorkspaceResourceService(fixture.config, "workspace:///root-1/file.txt");
    assert.equal(res1.text, "Root 1 File");

    const res2 = await readWorkspaceResourceService(fixture.config, "workspace:///root-2/file.txt");
    assert.equal(res2.text, "Root 2 File");

    // Outside file
    await fs.writeFile(path.join(fixture.outsideDir, "secret.txt"), "SECRET CONTENT", "utf-8");

    // Symlink escaping root
    const symlinkPath = path.join(fixture.root1Dir, "escape-link.txt");
    try {
      await fs.symlink(path.join(fixture.outsideDir, "secret.txt"), symlinkPath);
      await assert.rejects(
        () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/escape-link.txt"),
        (err: any) =>
          err instanceof WorkspaceSecurityError &&
          (err.code === "access_denied" || err.code === "resource_not_found")
      );
    } catch (symlinkErr: any) {
      // If OS user lacks SeCreateSymbolicLinkPrivilege on Windows, skip symlink creation
      if (process.platform === "win32") {
        // Platform skip on unprivileged Windows
      } else {
        throw symlinkErr;
      }
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Resource Service — error privacy: client errors never leak absolute server paths", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    try {
      await readWorkspaceResourceService(fixture.config, "workspace:///root-1/nonexistent.txt");
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(err instanceof WorkspaceSecurityError);
      assert.equal(err.message.includes(fixture.tempDir), false);
      assert.equal(err.message.includes(fixture.root1Dir), false);
      assert.ok(err.message.includes("root-1"));
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

// ============================================================================
// 4. CLI Operator Configuration Tests for Resources
// ============================================================================

test("CLI Parser — --workspace-max-resource-bytes flag and MCP_WORKSPACE_MAX_RESOURCE_BYTES env var", () => {
  // Default values
  const defaultCfg = parseCliArgs([]);
  assert.equal(defaultCfg.workspacePolicy.maxResourceBytes, 1048576);

  // CLI flag parsing
  const cliCfg = parseCliArgs(["--workspace-max-resource-bytes=2097152"]);
  assert.equal(cliCfg.workspacePolicy.maxResourceBytes, 2097152);

  // Space-separated CLI flag
  const cliSpaceCfg = parseCliArgs(["--workspace-max-resource-bytes", "3145728"]);
  assert.equal(cliSpaceCfg.workspacePolicy.maxResourceBytes, 3145728);

  // Environment variable parsing
  const envCfg = parseCliArgs([], { MCP_WORKSPACE_MAX_RESOURCE_BYTES: "524288" });
  assert.equal(envCfg.workspacePolicy.maxResourceBytes, 524288);

  // CLI overrides environment variable
  const overrideCfg = parseCliArgs(["--workspace-max-resource-bytes=4194304"], {
    MCP_WORKSPACE_MAX_RESOURCE_BYTES: "524288",
  });
  assert.equal(overrideCfg.workspacePolicy.maxResourceBytes, 4194304);

  // Invalid values fail fast
  const invalidCli = parseCliArgs(["--workspace-max-resource-bytes=0"]);
  assert.ok(invalidCli.error && invalidCli.error.includes("Invalid --workspace-max-resource-bytes"));

  const invalidOverMax = parseCliArgs(["--workspace-max-resource-bytes=10000000"]);
  assert.ok(invalidOverMax.error && invalidOverMax.error.includes("Invalid --workspace-max-resource-bytes"));

  const invalidEnv = parseCliArgs([], { MCP_WORKSPACE_MAX_RESOURCE_BYTES: "abc" });
  assert.ok(invalidEnv.error && invalidEnv.error.includes("Invalid MCP_WORKSPACE_MAX_RESOURCE_BYTES"));

  const dupCli = parseCliArgs([
    "--workspace-max-resource-bytes=1048576",
    "--workspace-max-resource-bytes=2097152",
  ]);
  assert.ok(dupCli.error && dupCli.error.includes("Duplicate option specified"));
});

// ============================================================================
// 5. MCP Client-Server Protocol Integration Tests
// ============================================================================

test("MCP Protocol — workspace profile exposes resource template and handles reads", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    await fs.writeFile(path.join(fixture.root1Dir, "hello.txt"), "Hello Workspace!", "utf-8");

    const server = createServer({
      profile: "workspace",
      workspaceConfig: fixture.config,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // 1. List resource templates
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.equal(resourceTemplates.length, 1);
    assert.equal(resourceTemplates[0]!.name, "workspace_text_file");
    assert.equal(resourceTemplates[0]!.uriTemplate, "workspace:///{rootId}/{+path}");

    // 2. Read resource
    const readRes = await client.readResource({ uri: "workspace:///root-1/hello.txt" });
    assert.equal(readRes.contents.length, 1);
    const content = readRes.contents[0] as any;
    assert.equal(content.uri, "workspace:///root-1/hello.txt");
    assert.equal(content.mimeType, "text/plain; charset=utf-8");
    assert.equal(content.text, "Hello Workspace!");

    // 3. Tool catalog remains strictly 8 read-only tools
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
    const toolNames = tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "echo",
      "file_info",
      "list_directory",
      "ping",
      "read_text_file",
      "search_files",
      "search_text",
      "workspace_roots",
    ]);

    await client.close();
    await server.close();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("MCP Protocol — workspace_write profile exposes resource template and retains mutation tools", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    await fs.writeFile(path.join(fixture.root1Dir, "hello.txt"), "Write Profile Read", "utf-8");

    const server = createServer({
      profile: "workspace_write",
      workspaceConfig: fixture.config,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // 1. List resource templates
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.equal(resourceTemplates.length, 1);
    assert.equal(resourceTemplates[0]!.name, "workspace_text_file");

    // 2. Read resource
    const readRes = await client.readResource({ uri: "workspace:///root-1/hello.txt" });
    const content = readRes.contents[0] as any;
    assert.equal(content.text, "Write Profile Read");

    // 3. Workspace prompts remain available in the write-capable superset profile
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map((prompt) => prompt.name).sort(),
      ["explore_workspace", "find_and_explain", "review_file", "trace_symbol"]
    );

    // 4. Tool catalog has exactly 10 tools including edit_text_file and write_text_file
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    const toolNames = tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "echo",
      "edit_text_file",
      "file_info",
      "list_directory",
      "ping",
      "read_text_file",
      "search_files",
      "search_text",
      "workspace_roots",
      "write_text_file",
    ]);

    await client.close();
    await server.close();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("MCP Protocol — safe and network profiles isolate resources completely", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    // 1. Safe profile
    const safeServer = createServer({
      profile: "safe",
      workspaceConfig: fixture.config,
    });

    const [clientTransport1, serverTransport1] = InMemoryTransport.createLinkedPair();
    const client1 = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client1.connect(clientTransport1), safeServer.connect(serverTransport1)]);

    // Safe profile client has no resource templates
    const safeTemplates = await client1.listResourceTemplates();
    assert.equal(safeTemplates.resourceTemplates.length, 0);

    // Reading resource in safe profile fails
    await assert.rejects(
      () => client1.readResource({ uri: "workspace:///root-1/hello.txt" }),
      (err: any) => err.message.includes("does not advertise resources capability") || err.message.includes("Method not found")
    );

    await client1.close();
    await safeServer.close();

    // 2. Network profile
    const networkServer = createServer({
      profile: "network",
      workspaceConfig: fixture.config,
    });

    const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client2.connect(clientTransport2), networkServer.connect(serverTransport2)]);

    const netTemplates = await client2.listResourceTemplates();
    assert.equal(netTemplates.resourceTemplates.length, 0);

    await assert.rejects(
      () => client2.readResource({ uri: "workspace:///root-1/hello.txt" }),
      (err: any) => err.message.includes("does not advertise resources capability") || err.message.includes("Method not found")
    );

    await client2.close();
    await networkServer.close();
  } finally {
    await cleanupFixture(fixture);
  }
});

// ============================================================================
// 4. Extended Protocol, Capabilities, Round-Trip & Security Edge-Case Tests
// ============================================================================

test("MCP Protocol — Initialize capabilities across all profiles", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    const profiles = [
      { profile: "safe", hasResources: false },
      { profile: "network", hasResources: false },
      { profile: "diagnostics", hasResources: false },
      { profile: "benchmark", hasResources: false },
      { profile: "admin", hasResources: false },
      { profile: "workspace", hasResources: true },
      { profile: "workspace_write", hasResources: true },
      { profile: "all", hasResources: true },
    ] as const;

    for (const item of profiles) {
      const server = createServer({
        profile: item.profile,
        workspaceConfig: fixture.config,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });

      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const capabilities = client.getServerCapabilities();
      if (item.hasResources) {
        assert.ok(capabilities?.resources, `Profile ${item.profile} must advertise resources capability`);
        assert.equal(capabilities.resources.listChanged, true);
      } else {
        assert.equal(
          capabilities?.resources,
          undefined,
          `Profile ${item.profile} must NOT advertise resources capability`
        );
      }

      await client.close();
      await server.close();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test("MCP Protocol — resources/list returns empty list without recursive filesystem traversal", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    await fs.writeFile(path.join(fixture.root1Dir, "a.txt"), "A", "utf-8");
    await fs.writeFile(path.join(fixture.root1Dir, "b.txt"), "B", "utf-8");

    const server = createServer({
      profile: "workspace",
      workspaceConfig: fixture.config,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // resources/list returns empty array (does not walk filesystem)
    const listRes = await client.listResources();
    assert.deepEqual(listRes.resources, []);

    // resources/templates/list returns the template
    const templatesRes = await client.listResourceTemplates();
    assert.equal(templatesRes.resourceTemplates.length, 1);
    assert.equal(templatesRes.resourceTemplates[0]!.name, "workspace_text_file");
    assert.equal(templatesRes.resourceTemplates[0]!.uriTemplate, "workspace:///{rootId}/{+path}");

    await client.close();
    await server.close();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("MCP Protocol — Rootless workspace profile starts safely and handles read requests without crash", async () => {
  const rootlessConfig: WorkspaceConfig = { roots: [] };

  const server = createServer({
    profile: "workspace",
    workspaceConfig: rootlessConfig,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  // Resource templates list works
  const templatesRes = await client.listResourceTemplates();
  assert.equal(templatesRes.resourceTemplates.length, 1);

  // Read resource fails with sanitized error (no server crash or path leak)
  await assert.rejects(
    () => client.readResource({ uri: "workspace:///root-1/test.txt" }),
    (err: any) => err.message.includes("No workspace roots configured") || err.message.includes("resource_not_found")
  );

  await client.close();
  await server.close();
});

test("Resource URI — Round-trip matrix for special characters (#, ?, %, spaces, unicode, brackets, parentheses)", () => {
  const testCases = [
    { rootId: "root-1", relativePath: "docs/hello world.md" },
    { rootId: "root-1", relativePath: "#tag/c#_doc.md" },
    { rootId: "root-1", relativePath: "query?file.txt" },
    { rootId: "root-1", relativePath: "report 100%.json" },
    { rootId: "root-1", relativePath: "my [special] (file).ts" },
    { rootId: "root-1", relativePath: "unicode_日本語/dátum.txt" },
    { rootId: "root-2", relativePath: "deep/nested/path/to/file.txt" },
  ];

  for (const tc of testCases) {
    const uri = createWorkspaceResourceUri(tc.rootId, tc.relativePath);
    assert.ok(uri.startsWith("workspace:///"), `URI must start with workspace:///: ${uri}`);
    // Ensure no unencoded # or ? in the URI string
    const afterScheme = uri.slice("workspace:///".length);
    assert.ok(!afterScheme.includes("?"), `URI must not contain raw query delimiter: ${uri}`);
    assert.ok(!afterScheme.includes("#"), `URI must not contain raw fragment delimiter: ${uri}`);

    const parsed = parseWorkspaceResourceUri(uri);
    assert.equal(parsed.rootId, tc.rootId);
    assert.equal(parsed.relativePath, tc.relativePath);
  }
});

test("Resource URI — Windows-like URI attack attempts are rejected", () => {
  const attacks = [
    "workspace:///root-1/C:",
    "workspace:///root-1/C:foo",
    "workspace:///root-1/C:\\foo",
    "workspace:///root-1/C:/foo",
    "workspace:///root-1/\\\\server\\share",
    "workspace:///root-1/\\\\?\\C:\\foo",
    "workspace:///root-1/\\\\.\\device",
  ];

  for (const attack of attacks) {
    assert.throws(
      () => parseWorkspaceResourceUri(attack),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri",
      `Expected rejection for Windows attack: ${attack}`
    );
  }
});

test("Resource URI — Root ID validation and injection prevention", () => {
  // Reject path separators in rootId
  assert.throws(
    () => createWorkspaceResourceUri("root/1", "file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => createWorkspaceResourceUri("root\\1", "file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );

  // Encoded slash in rootId
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root%2F1/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Encoded backslash in rootId
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///root%5C1/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  // Traversal in rootId
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///../root-1/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
  assert.throws(
    () => parseWorkspaceResourceUri("workspace:///%2e%2e/file.txt"),
    (err: any) => err instanceof WorkspaceSecurityError && err.code === "invalid_resource_uri"
  );
});

test("Resource Service — Multi-byte UTF-8 character boundary limits", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    // 3-byte UTF-8 characters: '日' = E6 97 A5 (3 bytes)
    // 3 x 3 = 9 bytes + 1 ASCII byte '!' = 10 bytes
    const text10Bytes = "日曜日!";
    const buffer10 = Buffer.from(text10Bytes, "utf-8");
    assert.equal(buffer10.byteLength, 10);

    await fs.writeFile(path.join(fixture.root1Dir, "multi.txt"), buffer10);

    // Limit == 10 bytes => succeeds
    const policy10 = createWorkspaceOperatorPolicy({ maxResourceBytes: 10 });
    const res10 = await readWorkspaceResourceService(fixture.config, "workspace:///root-1/multi.txt", policy10);
    assert.equal(res10.text, text10Bytes);
    assert.equal(res10.sizeBytes, 10);

    // Limit == 9 bytes => throws resource_too_large (multi-byte raw bytes exceed limit)
    const policy9 = createWorkspaceOperatorPolicy({ maxResourceBytes: 9 });
    await assert.rejects(
      () => readWorkspaceResourceService(fixture.config, "workspace:///root-1/multi.txt", policy9),
      (err: any) => err instanceof WorkspaceSecurityError && err.code === "resource_too_large"
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("MCP Protocol — Exact ResourceContents shape validation", async () => {
  const fixture = await createTestWorkspaceFixture();
  try {
    await fs.writeFile(path.join(fixture.root1Dir, "schema.json"), '{"valid":true}', "utf-8");

    const server = createServer({
      profile: "workspace",
      workspaceConfig: fixture.config,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const readRes = await client.readResource({ uri: "workspace:///root-1/schema.json" });

    // Validate ResourceContents shape
    assert.equal(readRes.contents.length, 1);
    const item = readRes.contents[0] as any;
    assert.equal(item.uri, "workspace:///root-1/schema.json");
    assert.equal(item.mimeType, "application/json");
    assert.equal(item.text, '{"valid":true}');

    // Validate NO host path leaks in any property
    const rawJson = JSON.stringify(readRes);
    assert.ok(!rawJson.includes(fixture.root1Dir), "Response must not contain host absolute path");
    assert.ok(!rawJson.includes("file://"), "Response must not contain file:// URI");

    await client.close();
    await server.close();
  } finally {
    await cleanupFixture(fixture);
  }
});

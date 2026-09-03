import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  isInputRequiredResult,
  type ElicitRequest,
  type ElicitResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { resolveWorkspaceConfig } from "../src/config/workspace.js";
import type { ToolProfile } from "../src/config/tool-profile.js";
import { createHttpTransportServer } from "../src/transports/http.js";
import {
  createWorkspaceWriteConfirmationMessage,
  requireWorkspaceWriteConfirmation,
} from "../src/workspace/write-confirmation.js";
import {
  createWorkspaceOperatorPolicy,
  DEFAULT_WORKSPACE_OPERATOR_POLICY,
} from "../src/workspace/write-service.js";

const initialText = "Initial private content";
const initialSha = crypto.createHash("sha256").update(initialText).digest("hex");

async function fixture(t: TestContext, options: {
  confirmation?: boolean;
  legacy?: boolean;
  profile?: ToolProfile;
  rootless?: boolean;
  transport?: "http" | "stdio";
  onElicit?: (request: ElicitRequest) => Promise<ElicitResult> | ElicitResult;
} = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-write-confirmation-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootDir, "existing.txt"), initialText);
  const server = options.transport === "stdio" ? undefined : await createHttpTransportServer(
    0,
    options.profile ?? "workspace_write",
    options.rootless ? { roots: [] } : await resolveWorkspaceConfig([rootDir]),
    undefined,
    undefined,
    options.confirmation === undefined ? undefined : createWorkspaceOperatorPolicy({
      requireWriteConfirmation: options.confirmation,
      maxWriteBytes: 128,
    }),
  );
  const client = new Client({ name: "confirmation-test", version: "1.0.0" }, {
    capabilities: options.onElicit ? { elicitation: { form: {} } } : {},
    versionNegotiation: { mode: options.legacy ? "legacy" : { pin: "2026-07-28" } },
  });
  if (options.onElicit) client.setRequestHandler("elicitation/create", options.onElicit);
  const clientTransport = options.transport === "stdio"
    ? new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts", `--profile=${options.profile ?? "workspace_write"}`, `--root=${rootDir}`, "--workspace-max-write-bytes=128"],
      env: { MCP_WORKSPACE_WRITE_CONFIRMATION: String(options.confirmation ?? false) },
      stderr: "pipe",
    })
    : new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server!.port}/mcp`));
  const wire: JSONRPCMessage[] = [];
  t.after(async () => { await client.close(); await server?.close(); });
  await client.connect(clientTransport);
  const onmessage = clientTransport.onmessage;
  clientTransport.onmessage = (message) => {
    wire.push(structuredClone(message));
    onmessage?.(message);
  };
  return { rootDir, client, wire };
}

const mutations = [
  { operation: "create", name: "write_text_file", arguments: {
    path: "new.txt", mode: "create", content: "New private content",
  }, target: "new.txt", final: "New private content" },
  { operation: "overwrite", name: "write_text_file", arguments: {
    rootId: "root-1", path: "existing.txt", mode: "overwrite", content: "Overwritten private content", expectedSha256: initialSha,
  }, target: "existing.txt", final: "Overwritten private content" },
  { operation: "edit", name: "edit_text_file", arguments: {
    path: "existing.txt", expectedSha256: initialSha, edits: [{ oldText: "Initial", newText: "Edited" }],
  }, target: "existing.txt", final: "Edited private content" },
];

test("Workspace confirmation policy — disabled by default and frozen per instance", () => {
  assert.equal(DEFAULT_WORKSPACE_OPERATOR_POLICY.requireWriteConfirmation, false);
  assert.equal(createWorkspaceOperatorPolicy().requireWriteConfirmation, false);
  const policy = createWorkspaceOperatorPolicy({ requireWriteConfirmation: true });
  assert.equal(policy.requireWriteConfirmation, true);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(createWorkspaceOperatorPolicy({ requireWriteConfirmation: false }).requireWriteConfirmation, false);
});

for (const mutation of mutations) {
  for (const [transport, legacy] of [["http", false], ["http", true], ["stdio", false], ["stdio", true]] as const) {
    test(`Workspace confirmation — ${mutation.operation} (${legacy ? "legacy" : "modern"} ${transport})`, async (t) => {
      let prompts = 0;
      const setup = await fixture(t, {
        confirmation: true,
        legacy,
        transport,
        onElicit: async (request) => {
          prompts++;
          assert.equal(request.params.mode, "form");
          assert.match(request.params.message, new RegExp(`workspace ${mutation.operation}`));
          assert.ok(request.params.message.includes('rootId="root-1"'));
          assert.ok(request.params.message.includes(`path="${mutation.target}"`));
          assert.ok(!request.params.message.includes(setup.rootDir));
          assert.ok(!request.params.message.includes(initialSha));
          assert.ok(!request.params.message.includes("private content"));
          assert.deepEqual(await fs.readdir(setup.rootDir), ["existing.txt"]);
          assert.equal(await fs.readFile(path.join(setup.rootDir, "existing.txt"), "utf8"), initialText);
          return { action: "accept", content: { confirm: true } };
        },
      });
      const result = await setup.client.callTool({ name: mutation.name, arguments: mutation.arguments });
      if (legacy && transport === "http") {
        // The production HTTP entry is stateless: no legacy reverse channel.
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /per-request legacy serving/);
        assert.equal(prompts, 0);
        assert.deepEqual(await fs.readdir(setup.rootDir), ["existing.txt"]);
        assert.equal(await fs.readFile(path.join(setup.rootDir, "existing.txt"), "utf8"), initialText);
        return;
      }
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(prompts, 1);
      assert.equal(await fs.readFile(path.join(setup.rootDir, mutation.target), "utf8"), mutation.final);
      assert.ok(!(await fs.readdir(setup.rootDir)).some(name => name.startsWith(".mcp-temp-")));
      if (!legacy) {
        const interactive = setup.wire.filter(message => "result" in message && message.result.resultType === "input_required");
        assert.equal(interactive.length, 1, "a real input_required response crossed the modern wire");
      }
    });
  }

  for (const response of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { confirm: false } },
  ] as ElicitResult[]) {
    test(`Workspace confirmation — ${mutation.operation} refuses ${JSON.stringify(response)}`, async (t) => {
      let prompts = 0;
      const setup = await fixture(t, { confirmation: true, onElicit: () => { prompts++; return response; } });
      const result = await setup.client.callTool({ name: mutation.name, arguments: mutation.arguments });
      assert.equal(result.isError, true);
      assert.equal(prompts, 1, "refusal does not re-prompt");
      assert.deepEqual(await fs.readdir(setup.rootDir), ["existing.txt"]);
      assert.equal(await fs.readFile(path.join(setup.rootDir, "existing.txt"), "utf8"), initialText);
    });
  }

  test(`Workspace confirmation — ${mutation.operation} fails closed without elicitation capability`, async (t) => {
    const setup = await fixture(t, { confirmation: true });
    await assert.rejects(
      setup.client.callTool({ name: mutation.name, arguments: mutation.arguments }),
      (error: any) => error.code === -32021
    );
    assert.deepEqual(await fs.readdir(setup.rootDir), ["existing.txt"]);
    assert.equal(await fs.readFile(path.join(setup.rootDir, "existing.txt"), "utf8"), initialText);
  });

  for (const [legacy, confirmation] of [[false, undefined], [false, false], [true, undefined], [true, false]] as const) {
    test(`Workspace confirmation — ${mutation.operation} preserves behavior with policy ${String(confirmation)} (${legacy ? "legacy" : "modern"})`, async (t) => {
      const setup = await fixture(t, { confirmation, legacy });
      const result = await setup.client.callTool({ name: mutation.name, arguments: mutation.arguments });
      assert.equal(result.isError, undefined);
      assert.equal(await fs.readFile(path.join(setup.rootDir, mutation.target), "utf8"), mutation.final);
    });
  }
}

test("Workspace confirmation — accepted response does not bypass SHA or size limits", async (t) => {
  const setup = await fixture(t, { confirmation: true, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
  for (const request of [
    { name: "write_text_file", arguments: { path: "existing.txt", mode: "overwrite", content: "change", expectedSha256: "0".repeat(64) } },
    { name: "edit_text_file", arguments: { path: "existing.txt", expectedSha256: "0".repeat(64), edits: [{ oldText: "Initial", newText: "Change" }] } },
    { name: "write_text_file", arguments: { path: "new.txt", mode: "create", content: "x".repeat(129) } },
    { name: "edit_text_file", arguments: { path: "existing.txt", expectedSha256: initialSha, edits: [{ oldText: "Initial", newText: "x".repeat(129) }] } },
  ]) {
    const result = await setup.client.callTool(request);
    assert.equal(result.isError, true);
  }
  assert.deepEqual(await fs.readdir(setup.rootDir), ["existing.txt"]);
  assert.equal(await fs.readFile(path.join(setup.rootDir, "existing.txt"), "utf8"), initialText);
});

test("Workspace confirmation — file changed during approval still conflicts", async (t) => {
  const setup = await fixture(t, { confirmation: true, onElicit: async () => {
    await fs.writeFile(path.join(setup.rootDir, "existing.txt"), "Concurrent change");
    return { action: "accept", content: { confirm: true } };
  } });
  const result = await setup.client.callTool({ name: "edit_text_file", arguments: mutations[2].arguments });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Content conflict/);
  assert.equal(await fs.readFile(path.join(setup.rootDir, "existing.txt"), "utf8"), "Concurrent change");
});

test("Workspace confirmation — invalid targets are refused before elicitation", async (t) => {
  let prompts = 0;
  const setup = await fixture(t, { confirmation: true, onElicit: () => { prompts++; return { action: "accept", content: { confirm: true } }; } });
  for (const arguments_ of [
    { path: "../outside.txt" },
    { path: path.join(setup.rootDir, "absolute.txt") },
    { path: "new.txt", rootId: "unknown" },
  ]) {
    const result = await setup.client.callTool({ name: "write_text_file", arguments: { mode: "create", content: "No", ...arguments_ } });
    assert.equal(result.isError, true);
  }
  assert.equal(prompts, 0);
  assert.deepEqual(await fs.readdir(setup.rootDir), ["existing.txt"]);
});

for (const profile of ["safe", "network", "workspace", "workspace_write", "all"] as const) {
  test(`Workspace confirmation — ${profile} profile isolation and tool counts`, async (t) => {
    const setup = await fixture(t, { confirmation: true, profile, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const { tools } = await setup.client.listTools();
    const canWrite = profile === "workspace_write" || profile === "all";
    assert.equal(tools.some(tool => tool.name === "write_text_file"), canWrite);
    assert.equal(tools.some(tool => tool.name === "edit_text_file"), canWrite);
    assert.equal(tools.length, { safe: 2, network: 3, workspace: 8, workspace_write: 10, all: 20 }[profile]);
    if (profile === "all") {
      assert.equal((await setup.client.callTool({ name: mutations[0].name, arguments: mutations[0].arguments })).isError, undefined);
    }
  });
}

test("Workspace confirmation — rootless server fails safely without a prompt", async (t) => {
  let prompts = 0;
  const setup = await fixture(t, { confirmation: true, rootless: true, onElicit: () => { prompts++; return { action: "accept", content: { confirm: true } }; } });
  const result = await setup.client.callTool({ name: mutations[0].name, arguments: mutations[0].arguments });
  assert.equal(result.isError, true);
  assert.equal(prompts, 0);
});

test("Workspace confirmation — response validation and argument-bound keys", () => {
  const input = { operation: "create" as const, rootId: "root-1", path: "new.txt", approvalKeyMaterial: { content: "original" } };
  const first = requireWorkspaceWriteConfirmation(input);
  assert.ok(first && isInputRequiredResult(first));
  const key = Object.keys(first.inputRequests!)[0];
  const approval = { [key]: { action: "accept", content: { confirm: true } } };
  assert.equal(requireWorkspaceWriteConfirmation(input, approval), undefined);
  for (const changed of [
    { ...input, operation: "overwrite" as const },
    { ...input, rootId: "root-2" },
    { ...input, path: "other.txt" },
    { ...input, approvalKeyMaterial: { content: "changed" } },
  ]) {
    const retried = requireWorkspaceWriteConfirmation(changed, approval);
    assert.ok(retried && isInputRequiredResult(retried));
    assert.notEqual(Object.keys(retried.inputRequests!)[0], key);
  }
  for (const response of [
    { action: "accept", content: { confirm: "true" } },
    { action: "accept", content: { confirm: 1 } },
    { action: "accept", content: {} },
    { action: "accept", content: { confirm: true, extra: "untrusted" } },
    { roots: [] },
  ]) {
    const result = requireWorkspaceWriteConfirmation(input, { [key]: response });
    assert.ok(result && !isInputRequiredResult(result));
    assert.equal(result.isError, true);
  }
  const missing = requireWorkspaceWriteConfirmation(input, {});
  assert.ok(missing && isInputRequiredResult(missing));
});

test("Workspace confirmation — safe complete target display, no silent truncation", () => {
  const message = createWorkspaceWriteConfirmationMessage({ operation: "edit", rootId: "root-1", path: 'docs/hello\n\u202e<unsafe>`\u007f.txt' });
  assert.ok(message.includes('\\n'));
  assert.ok(message.includes('\\u202e'));
  assert.ok(!/[\n\u202e<`\u007f]/.test(message));
  const longPath = `${"a".repeat(200)}.important.txt`;
  assert.ok(createWorkspaceWriteConfirmationMessage({ operation: "edit", path: longPath }).includes(longPath));
  assert.throws(() => createWorkspaceWriteConfirmationMessage({ operation: "edit", path: "a".repeat(4097) }), /too long/);
});

test("Workspace confirmation — createParents=true approve creates parents and file", async (t) => {
  let prompts = 0;
  let elicitedMessage = "";
  const setup = await fixture(t, {
    confirmation: true,
    onElicit: (req) => {
      prompts++;
      elicitedMessage = (req as any).params?.message ?? "";
      return { action: "accept", content: { confirm: true } };
    },
  });

  const result = await setup.client.callTool({
    name: "write_text_file",
    arguments: {
      mode: "create",
      path: "nested/sub/dir/new.txt",
      content: "Confirmed nested content",
      createParents: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(prompts, 1);
  assert.ok(elicitedMessage.includes("may create missing parent directories"));
  assert.ok(!elicitedMessage.includes(setup.rootDir));
  assert.ok(!elicitedMessage.includes("Confirmed nested content"));

  const onDisk = await fs.readFile(path.join(setup.rootDir, "nested", "sub", "dir", "new.txt"), "utf8");
  assert.equal(onDisk, "Confirmed nested content");
});

test("Workspace confirmation — createParents=true decline causes zero mutation", async (t) => {
  let prompts = 0;
  const setup = await fixture(t, {
    confirmation: true,
    onElicit: () => {
      prompts++;
      return { action: "decline" };
    },
  });

  const result = await setup.client.callTool({
    name: "write_text_file",
    arguments: {
      mode: "create",
      path: "decline_nested/sub/new.txt",
      content: "Declined content",
      createParents: true,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(prompts, 1);
  const entries = await fs.readdir(setup.rootDir);
  assert.deepEqual(entries, ["existing.txt"]);
});

test("Workspace confirmation — createParents=true cancel causes zero mutation", async (t) => {
  let prompts = 0;
  const setup = await fixture(t, {
    confirmation: true,
    onElicit: () => {
      prompts++;
      return { action: "cancel" };
    },
  });

  const result = await setup.client.callTool({
    name: "write_text_file",
    arguments: {
      mode: "create",
      path: "cancel_nested/sub/new.txt",
      content: "Cancelled content",
      createParents: true,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(prompts, 1);
  const entries = await fs.readdir(setup.rootDir);
  assert.deepEqual(entries, ["existing.txt"]);
});

test("Workspace confirmation — createParents=true malformed elicitation response causes zero mutation", async (t) => {
  let prompts = 0;
  const setup = await fixture(t, {
    confirmation: true,
    onElicit: () => {
      prompts++;
      return { action: "accept", content: { confirm: false } } as any;
    },
  });

  const result = await setup.client.callTool({
    name: "write_text_file",
    arguments: {
      mode: "create",
      path: "malformed_nested/sub/new.txt",
      content: "Malformed content",
      createParents: true,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(prompts, 1);
  const entries = await fs.readdir(setup.rootDir);
  assert.deepEqual(entries, ["existing.txt"]);
});

test("Workspace confirmation — createParents message formatting and privacy", () => {
  const msgWithout = createWorkspaceWriteConfirmationMessage({
    operation: "create",
    rootId: "root-1",
    path: "dir/test.txt",
  });
  assert.ok(!msgWithout.includes("may create missing parent directories"));

  const msgWith = createWorkspaceWriteConfirmationMessage({
    operation: "create",
    rootId: "root-1",
    path: "dir/test.txt",
    createParents: true,
  });
  assert.ok(msgWith.includes("may create missing parent directories"));
  assert.ok(msgWith.includes('rootId="root-1"'));
  assert.ok(msgWith.includes('path="dir/test.txt"'));
});

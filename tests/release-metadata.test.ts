import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

test("Release Metadata Invariants — package.json and server.json synchronization", () => {
  const packageJsonPath = path.join(rootDir, "package.json");
  const serverJsonPath = path.join(rootDir, "server.json");

  assert.ok(fs.existsSync(packageJsonPath), "package.json must exist");
  assert.ok(fs.existsSync(serverJsonPath), "server.json must exist");

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, "utf-8"));

  // 1. Version matches
  assert.equal(
    packageJson.version,
    serverJson.version,
    "package.json version must match server.json version"
  );
  assert.equal(packageJson.version, "0.4.0");

  // 2. Package identifier matches
  assert.ok(
    Array.isArray(serverJson.packages) && serverJson.packages.length > 0,
    "server.json must contain at least one package definition"
  );
  assert.equal(
    packageJson.name,
    serverJson.packages[0].identifier,
    "package.json name must match server.json package identifier"
  );
  assert.equal(packageJson.name, "high-performance-mcp-server");

  // 3. Package version matches
  assert.equal(
    packageJson.version,
    serverJson.packages[0].version,
    "package.json version must match server.json package version"
  );

  // 4. mcpName matches server.json name
  assert.equal(
    packageJson.mcpName,
    serverJson.name,
    "package.json mcpName must match server.json name"
  );
  assert.equal(
    packageJson.mcpName,
    "io.github.AnIayana/high-performance-mcp-server",
    "mcpName must match expected verified GitHub namespace"
  );

  // 5. Repository URL and source
  assert.equal(
    serverJson.repository?.url,
    "https://github.com/AnIayana/high-performance-mcp-server",
    "server.json repository URL must match expected GitHub repository"
  );
  assert.equal(
    serverJson.repository?.source,
    "github",
    "server.json repository source must be github"
  );

  // 6. Schema check (2025-12-11 official schema)
  assert.equal(
    serverJson.$schema,
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    "server.json must use official 2025-12-11 schema"
  );

  // 7. Transport type
  assert.equal(
    serverJson.packages[0].transport?.type,
    "stdio",
    "server.json package transport type must be stdio"
  );

  // 8. Package registry type
  assert.equal(
    serverJson.packages[0].registryType,
    "npm",
    "server.json package registryType must be npm"
  );
});

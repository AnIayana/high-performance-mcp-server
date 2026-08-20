import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildMetaContent } from "./generate-build-meta.js";
import { computeToolRegistryContent } from "./generate-tool-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

async function checkGeneratedFiles(): Promise<void> {
  console.log("[Generated Check] Verifying auto-generated files are up to date...");

  const toolRegistryPath = path.join(rootDir, "src", "tools", "generated-registry.ts");
  const buildMetaPath = path.join(rootDir, "src", "generated", "build-meta.ts");

  let existingToolRegistry = "";
  let existingBuildMeta = "";

  try {
    existingToolRegistry = await fs.readFile(toolRegistryPath, "utf-8");
  } catch {
    throw new Error(
      `Generated file missing: src/tools/generated-registry.ts. Run npm run generate and commit the result.`
    );
  }

  try {
    existingBuildMeta = await fs.readFile(buildMetaPath, "utf-8");
  } catch {
    throw new Error(
      `Generated file missing: src/generated/build-meta.ts. Run npm run generate and commit the result.`
    );
  }

  const expectedToolRegistry = await computeToolRegistryContent();
  const expectedBuildMeta = await computeBuildMetaContent();

  const isToolRegistryMatch = normalize(existingToolRegistry) === normalize(expectedToolRegistry);
  const isBuildMetaMatch = normalize(existingBuildMeta) === normalize(expectedBuildMeta);

  if (!isToolRegistryMatch || !isBuildMetaMatch) {
    const staleFiles: string[] = [];
    if (!isToolRegistryMatch) staleFiles.push("src/tools/generated-registry.ts");
    if (!isBuildMetaMatch) staleFiles.push("src/generated/build-meta.ts");

    throw new Error(
      `Generated files are stale (${staleFiles.join(", ")}). Run npm run generate and commit the result.`
    );
  }

  console.log("[Generated Check] All auto-generated files are clean and up to date!");
}

checkGeneratedFiles().catch((error) => {
  console.error(
    `[Generated Check Failed] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

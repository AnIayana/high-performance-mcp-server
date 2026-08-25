import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PublishAttemptResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface PublishWithRetryOptions {
  readonly runAttempt: () => Promise<PublishAttemptResult>;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly onAttempt?: (attempt: number, result: PublishAttemptResult) => void;
}

export interface PublishWithRetryResult {
  readonly attempts: number;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 10_000;

export function isTransientNpmPropagationFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  const referencesNpmVersion = normalized.includes("npm package") && normalized.includes("version");
  const reportsMissingVersion =
    normalized.includes("was not found") || normalized.includes("version not found");
  const reportsPropagationDelay =
    normalized.includes("status: 404") ||
    normalized.includes("newly published release can take a moment");

  return referencesNpmVersion && reportsMissingVersion && reportsPropagationDelay;
}

export async function publishMcpWithRetry(
  options: PublishWithRetryOptions
): Promise<PublishWithRetryResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("delayMs must be a non-negative integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await options.runAttempt();
    options.onAttempt?.(attempt, result);

    if (result.exitCode === 0) {
      return { attempts: attempt };
    }

    if (!isTransientNpmPropagationFailure(result.output)) {
      throw new Error(`MCP Registry publish failed with exit code ${result.exitCode}`);
    }

    if (attempt === maxAttempts) {
      throw new Error(
        `MCP Registry publish still could not observe the npm version after ${maxAttempts} attempts`
      );
    }

    await wait(delayMs);
  }

  throw new Error("MCP Registry publish retry loop ended unexpectedly");
}

export async function runPublisherCommand(
  publisherPath: string,
  manifestPath: string
): Promise<PublishAttemptResult> {
  return await new Promise<PublishAttemptResult>((resolve, reject) => {
    const child = spawn(publisherPath, ["publish", manifestPath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

function parseIntegerOption(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const args = process.argv.slice(2);
  let publisherPath = ".tools/mcp-publisher";
  let manifestPath = "server.json";
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let delayMs = DEFAULT_DELAY_MS;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--publisher") {
      publisherPath = args[++index] ?? "";
    } else if (arg === "--manifest") {
      manifestPath = args[++index] ?? "";
    } else if (arg === "--max-attempts") {
      maxAttempts = parseIntegerOption(args[++index], "--max-attempts");
    } else if (arg === "--delay-ms") {
      delayMs = parseIntegerOption(args[++index], "--delay-ms");
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!publisherPath || !manifestPath || maxAttempts < 1) {
    console.error("Publisher path, manifest path, and a positive max-attempts value are required");
    process.exit(1);
  }

  try {
    const result = await publishMcpWithRetry({
      maxAttempts,
      delayMs,
      runAttempt: () => runPublisherCommand(publisherPath, manifestPath),
      onAttempt: (attempt, attemptResult) => {
        if (attemptResult.output) {
          process.stdout.write(attemptResult.output);
          if (!attemptResult.output.endsWith("\n")) process.stdout.write("\n");
        }
        if (
          attempt < maxAttempts &&
          attemptResult.exitCode !== 0 &&
          isTransientNpmPropagationFailure(attemptResult.output)
        ) {
          console.warn(
            `npm version is not yet visible to MCP Registry; retrying in ${delayMs}ms ` +
              `(attempt ${attempt}/${maxAttempts})`
          );
        }
      },
    });
    console.log(`MCP Registry publish completed after ${result.attempts} attempt(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

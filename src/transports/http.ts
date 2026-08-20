import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { DEFAULT_TOOL_PROFILE, type ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";
import { createServer } from "../server.js";
import { closeWorkerPool } from "../workers/pool.js";

export interface HttpTransportServerInstance {
  readonly server: HttpServer;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Creates and starts a Streamable HTTP transport server without registering global process signal handlers.
 * Useful for both integration tests (e.g. binding port 0) and production runtime wrapping.
 */
export async function createHttpTransportServer(
  port: number,
  profile: ToolProfile = DEFAULT_TOOL_PROFILE,
  workspaceConfig?: WorkspaceConfig
): Promise<HttpTransportServerInstance> {
  const handler = createMcpHandler(() => createServer({ profile, workspaceConfig }));
  const nodeHandler = toNodeHandler(handler);

  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  let assignedPort = port;

  const httpServer: HttpServer = createHttpServer((req, res) => {
    // 1. Host & Origin Header Guards for DNS Rebinding / CSRF Protection
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    // 2. Strict endpoint path routing: only /mcp is serviced
    const hostHeader = req.headers.host ?? `127.0.0.1:${assignedPort}`;
    const parsedUrl = new URL(req.url ?? "/", `http://${hostHeader}`);

    if (parsedUrl.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found", message: "MCP server is hosted at /mcp" }));
      return;
    }

    // 3. Delegate valid requests to MCP Node handler
    void nodeHandler(req, res);
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await closeWorkerPool();
    await handler.close();
  };

  return new Promise((resolve, reject) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") {
        assignedPort = addr.port;
      }
      resolve({
        server: httpServer,
        port: assignedPort,
        close,
      });
    });

    httpServer.on("error", (error) => {
      reject(error);
    });
  });
}

/**
 * Starts the Model Context Protocol (MCP) server over Streamable HTTP (Node.js http) with process signal listeners.
 * Binds exclusively to 127.0.0.1 for local security and mounts the MCP handler at /mcp.
 */
export async function startHttpTransport(
  port: number,
  profile: ToolProfile = DEFAULT_TOOL_PROFILE,
  workspaceConfig?: WorkspaceConfig
): Promise<void> {
  const instance = await createHttpTransportServer(port, profile, workspaceConfig);
  console.error(`[MCP HTTP] Listening on http://127.0.0.1:${instance.port}/mcp (profile: ${profile})`);

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`\n[MCP HTTP] Received ${signal}, closing server gracefully...`);

    try {
      await instance.close();
      console.error("[MCP HTTP] Server and Worker Pool closed cleanly.");
      process.exit(0);
    } catch (err) {
      console.error(`[MCP HTTP] Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerContext } from "../core/server-context.js";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import { fetchUrlService } from "../network/fetch-service.js";
import {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_MAX_BYTES,
  MAX_FETCH_TIMEOUT_MS,
  MAX_URL_LENGTH,
} from "../network/policy.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "fetch_url",
  category: "network",
  description:
    "Performs an SSRF-hardened, read-only HTTP/HTTPS GET request to public web resources with bounded UTF-8 text decoding",
};

/**
 * Registers the 'fetch_url' tool on the provided MCP server instance.
 */
export default function registerFetchUrlTool(
  server: McpServer,
  context?: ServerContext
): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "Fetch URL",
      description: toolMeta.description,
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .max(MAX_URL_LENGTH)
          .describe("The public HTTP or HTTPS URL to fetch (max 2048 characters)"),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_FETCH_MAX_BYTES)
          .optional()
          .default(DEFAULT_FETCH_MAX_BYTES)
          .describe(
            `Maximum response bytes to read (1..${MAX_FETCH_MAX_BYTES}, default: ${DEFAULT_FETCH_MAX_BYTES})`
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(MAX_FETCH_TIMEOUT_MS)
          .optional()
          .default(DEFAULT_FETCH_TIMEOUT_MS)
          .describe(
            `Overall request timeout in milliseconds (1000..${MAX_FETCH_TIMEOUT_MS}, default: ${DEFAULT_FETCH_TIMEOUT_MS})`
          ),
      }),
      outputSchema: z.object({
        requestedUrl: z.string(),
        finalUrl: z.string(),
        status: z.number(),
        statusText: z.string(),
        contentType: z.string().optional(),
        contentLength: z.number().optional(),
        body: z.string().optional(),
        bytesRead: z.number(),
        truncated: z.boolean(),
        redirectCount: z.number(),
        cacheStatus: z.enum([
          "disabled",
          "miss",
          "stored",
          "revalidated",
          "updated",
          "uncacheable",
        ]),
        revalidationStatus: z.number().optional(),
      }),
    },
    withToolMetrics(toolMeta.name, async (args, extra?: any) => {
      const signal = extra?.signal;
      const result = await fetchUrlService({
        url: args.url,
        maxBytes: args.maxBytes,
        timeoutMs: args.timeoutMs,
        signal,
        operatorPolicy: context?.networkPolicy,
        networkCache: context?.networkCache,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result,
      };
    },
    context)
  );
}

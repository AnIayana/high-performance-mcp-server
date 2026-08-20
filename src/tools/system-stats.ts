import os from "node:os";
import process from "node:process";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { withToolMetrics } from "../core/tool-instrumentation.js";
import type { ToolMetadata } from "./types.js";

export const toolMeta: ToolMetadata = {
  name: "system_stats",
  category: "diagnostics",
  description: "Returns basic host system information and resource statistics",
};

/**
 * Registers the 'system_stats' tool on the provided MCP server instance.
 */
export default function registerSystemStatsTool(server: McpServer): void {
  server.registerTool(
    toolMeta.name,
    {
      title: "System Statistics",
      description: toolMeta.description,
      outputSchema: z.object({
        hostname: z.string().describe("Host machine name"),
        platform: z.string().describe("Operating system platform"),
        architecture: z.string().describe("CPU architecture"),
        cpuModel: z.string().describe("CPU model name"),
        logicalCpuCores: z.number().describe("Number of logical CPU cores"),
        totalMemoryGB: z.number().describe("Total physical memory in GB"),
        freeMemoryGB: z.number().describe("Available free memory in GB"),
        usedMemoryGB: z.number().describe("Used memory in GB"),
        memoryUsagePercent: z.number().describe("Memory utilization percentage"),
        systemUptimeSeconds: z.number().describe("System uptime in seconds"),
        processUptimeSeconds: z.number().describe("Node.js process uptime in seconds"),
        nodeVersion: z.string().describe("Node.js runtime version"),
      }),
    },
    withToolMetrics("system_stats", async () => {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      const totalMemoryGB = Number((totalMem / (1024 ** 3)).toFixed(2));
      const freeMemoryGB = Number((freeMem / (1024 ** 3)).toFixed(2));
      const usedMemoryGB = Number((usedMem / (1024 ** 3)).toFixed(2));
      const memoryUsagePercent = Number(((usedMem / totalMem) * 100).toFixed(2));

      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model ?? "Unknown";
      const logicalCpuCores = cpus.length;

      const systemUptimeSeconds = Math.floor(os.uptime());
      const processUptimeSeconds = Number(process.uptime().toFixed(2));

      const stats = {
        hostname: os.hostname(),
        platform: os.platform(),
        architecture: os.arch(),
        cpuModel,
        logicalCpuCores,
        totalMemoryGB,
        freeMemoryGB,
        usedMemoryGB,
        memoryUsagePercent,
        systemUptimeSeconds,
        processUptimeSeconds,
        nodeVersion: process.version,
      };

      const textSummary = [
        "=== System Statistics ===",
        `Hostname: ${stats.hostname}`,
        `Platform: ${stats.platform} (${stats.architecture})`,
        `CPU: ${stats.cpuModel} (${stats.logicalCpuCores} logical cores)`,
        `Memory: ${stats.usedMemoryGB} GB / ${stats.totalMemoryGB} GB (${stats.memoryUsagePercent}% used, ${stats.freeMemoryGB} GB free)`,
        `System Uptime: ${stats.systemUptimeSeconds}s`,
        `Process Uptime: ${stats.processUptimeSeconds}s`,
        `Node.js: ${stats.nodeVersion}`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: textSummary,
          },
        ],
        structuredContent: stats,
      };
    })
  );
}

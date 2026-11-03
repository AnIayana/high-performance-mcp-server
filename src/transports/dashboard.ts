import process from "node:process";
import type { ToolProfile } from "../config/tool-profile.js";
import type { WorkspaceConfig } from "../config/workspace.js";
import { getCacheStats, type CacheStats } from "../core/cache.js";
import { getMetricsSnapshot, type ServerMetricsSnapshot } from "../core/metrics.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../generated/build-meta.js";
import {
  DEFAULT_NETWORK_CACHE_POLICY,
  type NetworkCachePolicy,
} from "../network/conditional-cache.js";
import {
  DEFAULT_NETWORK_OPERATOR_POLICY,
  type NetworkOperatorPolicy,
} from "../network/operator-policy.js";
import { getToolsForProfile } from "../tools/index.js";
import type { ToolCategory } from "../tools/types.js";
import { getWorkerPoolStats, type WorkerPoolStats } from "../workers/pool.js";
import {
  DEFAULT_WORKSPACE_OPERATOR_POLICY,
  type WorkspaceOperatorPolicy,
} from "../workspace/write-service.js";

export interface DashboardOptions {
  readonly port: number;
  readonly profile: ToolProfile;
  readonly workspaceConfig?: WorkspaceConfig;
  readonly workspacePolicy?: WorkspaceOperatorPolicy;
  readonly networkPolicy?: NetworkOperatorPolicy;
  readonly networkCachePolicy?: NetworkCachePolicy;
}

export interface DashboardStatsSnapshot {
  readonly timestamp: string;
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly profile: ToolProfile;
    readonly transport: "http";
    readonly port: number;
    readonly endpoints: {
      readonly mcp: "/mcp";
      readonly healthz: "/healthz";
      readonly dashboard: "/dashboard";
    };
  };
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly category: ToolCategory;
    readonly description: string;
  }>;
  readonly workspace: {
    readonly roots: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
    }>;
    readonly maxWriteBytes: number;
    readonly maxResourceBytes: number;
    readonly requireWriteConfirmation: boolean;
  };
  readonly network: {
    readonly httpsOnly: boolean;
    readonly allowHostsCount: number;
    readonly denyHostsCount: number;
    readonly maxResponseBytes: number;
    readonly maxTimeoutMs: number;
    readonly cacheEnabled: boolean;
  };
  readonly metrics: ServerMetricsSnapshot;
  readonly cache: CacheStats;
  readonly workerPool: WorkerPoolStats;
  readonly memory: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
    readonly externalBytes: number;
  };
}

/**
 * Builds a sanitized, host-privacy-preserving observability snapshot for the loopback dashboard.
 * Never exposes physical host paths or raw hostname allow/deny patterns.
 */
export function buildDashboardStatsSnapshot(options: DashboardOptions): DashboardStatsSnapshot {
  const wsPolicy = options.workspacePolicy ?? DEFAULT_WORKSPACE_OPERATOR_POLICY;
  const netPolicy = options.networkPolicy ?? DEFAULT_NETWORK_OPERATOR_POLICY;
  const netCachePolicy = options.networkCachePolicy ?? DEFAULT_NETWORK_CACHE_POLICY;
  const mem = process.memoryUsage();
  const activeTools = getToolsForProfile(options.profile).map((t) => ({
    name: t.meta.name,
    category: t.meta.category,
    description: t.meta.description,
  }));

  const logicalRoots = (options.workspaceConfig?.roots ?? []).map((r) => ({
    id: r.id,
    name: r.name,
  }));

  return {
    timestamp: new Date().toISOString(),
    server: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      profile: options.profile,
      transport: "http",
      port: options.port,
      endpoints: {
        mcp: "/mcp",
        healthz: "/healthz",
        dashboard: "/dashboard",
      },
    },
    tools: activeTools,
    workspace: {
      roots: logicalRoots,
      maxWriteBytes: wsPolicy.maxWriteBytes,
      maxResourceBytes: wsPolicy.maxResourceBytes,
      requireWriteConfirmation: wsPolicy.requireWriteConfirmation,
    },
    network: {
      httpsOnly: netPolicy.httpsOnly,
      allowHostsCount: netPolicy.allowHosts.length,
      denyHostsCount: netPolicy.denyHosts.length,
      maxResponseBytes: netPolicy.maxResponseBytes,
      maxTimeoutMs: netPolicy.maxTimeoutMs,
      cacheEnabled: netCachePolicy.enabled,
    },
    metrics: getMetricsSnapshot(),
    cache: getCacheStats(),
    workerPool: getWorkerPoolStats(),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    },
  };
}

/**
 * Returns the self-contained, zero-dependency HTML observability dashboard page.
 */
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>High-Performance MCP Server — Observability Dashboard</title>
  <style>
    :root {
      --bg: #0b0f19;
      --panel: #111827;
      --panel-alt: #1e293b;
      --border: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #38bdf8;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
      --indigo: #818cf8;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.5;
      padding: 24px;
      max-width: 1360px;
      margin: 0 auto;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 22px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 10px var(--emerald);
    }
    .status-dot.error { background: var(--rose); box-shadow: 0 0 10px var(--rose); }
    h1 { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.01em; }
    .badge {
      font-family: var(--mono);
      font-size: 0.75rem;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--panel-alt);
      border: 1px solid #334155;
      color: var(--accent);
    }
    .badge.profile { color: var(--emerald); border-color: rgba(16, 185, 129, 0.35); }
    .controls { display: flex; align-items: center; gap: 10px; font-size: 0.82rem; color: var(--muted); }
    button, select {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    button:hover, select:hover { border-color: var(--accent); }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
    }
    .card-title {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .metric-big {
      font-family: var(--mono);
      font-size: 1.65rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 6px;
    }
    .metric-sub {
      font-family: var(--mono);
      font-size: 0.78rem;
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.84rem;
      margin-top: 8px;
    }
    th, td {
      text-align: left;
      padding: 9px 10px;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--muted);
      font-weight: 500;
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    td.num, th.num { text-align: right; font-family: var(--mono); }
    .pill-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .tool-pill {
      font-family: var(--mono);
      font-size: 0.75rem;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--panel-alt);
      border: 1px solid #334155;
    }
    .kv-list { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; font-size: 0.84rem; margin-top: 8px; }
    .kv-key { color: var(--muted); }
    .kv-val { font-family: var(--mono); color: var(--text); text-align: right; }
    footer {
      text-align: center;
      font-size: 0.76rem;
      color: var(--muted);
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span id="statusDot" class="status-dot" title="Loopback live telemetry"></span>
      <h1 id="serverTitle">High-Performance MCP Server</h1>
      <span id="versionBadge" class="badge">v0.6.0</span>
      <span id="profileBadge" class="badge profile">profile: safe</span>
    </div>
    <div class="controls">
      <span id="lastUpdated">Connecting...</span>
      <select id="refreshSelect" aria-label="Refresh interval">
        <option value="2000" selected>Auto: 2s</option>
        <option value="5000">Auto: 5s</option>
        <option value="0">Paused</option>
      </select>
      <button id="refreshBtn" type="button">Refresh Now</button>
    </div>
  </header>

  <section class="grid-4">
    <div class="card">
      <div class="card-title"><span>Uptime &amp; Memory</span><span>PROCESS</span></div>
      <div id="uptimeVal" class="metric-big">--</div>
      <div id="memorySub" class="metric-sub">Heap: -- MB / RSS: -- MB</div>
    </div>
    <div class="card">
      <div class="card-title"><span>Event Loop Delay</span><span>LATENCY</span></div>
      <div id="loopLagVal" class="metric-big">-- ms</div>
      <div id="loopLagSub" class="metric-sub">p50: --ms | p95: --ms | max: --ms</div>
    </div>
    <div class="card">
      <div class="card-title"><span>MCP Tool Calls</span><span>TRAFFIC</span></div>
      <div id="toolCallsVal" class="metric-big">0</div>
      <div id="toolCallsSub" class="metric-sub">Errors: 0 (100% ok)</div>
    </div>
    <div class="card">
      <div class="card-title"><span>LRU Cache &amp; Workers</span><span>ENGINE</span></div>
      <div id="cacheHitVal" class="metric-big">0%</div>
      <div id="workerSub" class="metric-sub">Cache: 0/0 | Workers: 0 busy / 0 idle</div>
    </div>
  </section>

  <section class="grid-2">
    <div class="card">
      <div class="card-title"><span>Tool Execution Telemetry</span><span>CUMULATIVE</span></div>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th class="num">Calls</th>
            <th class="num">Errors</th>
            <th class="num">Avg (ms)</th>
            <th class="num">Max (ms)</th>
            <th class="num">Last (ms)</th>
          </tr>
        </thead>
        <tbody id="metricsTableBody">
          <tr><td colspan="6" style="color: var(--muted); text-align: center;">No tool invocations recorded yet</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title"><span>Security Profile &amp; Operator Policy</span><span>BOUNDARIES</span></div>
      <div class="kv-list" id="policyList"></div>
      <div class="card-title" style="margin-top: 18px;"><span>Allowlisted Logical Roots (Host-Path Private)</span></div>
      <div id="rootsContainer" class="pill-list"></div>
      <div class="card-title" style="margin-top: 18px;"><span>Registered Profile Tools</span><span id="toolCountLabel">0 tools</span></div>
      <div id="toolsContainer" class="pill-list"></div>
    </div>
  </section>

  <footer>
    Loopback-only read-only observability interface (127.0.0.1) &bull; Zero host filesystem paths exposed &bull; MCP Endpoint: <code>/mcp</code> &bull; Health Probe: <code>/healthz</code>
  </footer>

  <script>
    const $ = (id) => document.getElementById(id);
    let timer = null;

    function fmtUptime(sec) {
      const s = Math.floor(sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const rem = s % 60;
      return (h > 0 ? h + "h " : "") + (m > 0 || h > 0 ? m + "m " : "") + rem + "s";
    }

    function fmtMB(bytes) {
      return (bytes / (1024 * 1024)).toFixed(1);
    }

    function clearAndAppendTextPills(container, items, emptyText) {
      container.replaceChildren();
      if (!items.length) {
        const span = document.createElement("span");
        span.style.color = "var(--muted)";
        span.style.fontSize = "0.8rem";
        span.textContent = emptyText;
        container.appendChild(span);
        return;
      }
      for (const text of items) {
        const pill = document.createElement("span");
        pill.className = "tool-pill";
        pill.textContent = text;
        container.appendChild(pill);
      }
    }

    async function refresh() {
      try {
        const res = await fetch("/dashboard/api/stats", { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        $("statusDot").className = "status-dot";
        $("serverTitle").textContent = data.server.name;
        $("versionBadge").textContent = "v" + data.server.version;
        $("profileBadge").textContent = "profile: " + data.server.profile;
        $("lastUpdated").textContent = "Updated " + new Date(data.timestamp).toLocaleTimeString();

        $("uptimeVal").textContent = fmtUptime(data.metrics.processUptimeSeconds);
        $("memorySub").textContent =
          "Heap: " + fmtMB(data.memory.heapUsedBytes) + " MB / RSS: " + fmtMB(data.memory.rssBytes) + " MB";

        const lag = data.metrics.eventLoopDelayMs;
        $("loopLagVal").textContent = lag.p99.toFixed(2) + " ms (p99)";
        $("loopLagSub").textContent =
          "p50: " + lag.p50.toFixed(2) + "ms | p95: " + lag.p95.toFixed(2) + "ms | max: " + lag.max.toFixed(2) + "ms";

        const calls = data.metrics.totalToolCalls;
        const errs = data.metrics.totalToolErrors;
        const okRate = calls > 0 ? (((calls - errs) / calls) * 100).toFixed(1) : "100.0";
        $("toolCallsVal").textContent = String(calls);
        $("toolCallsSub").textContent = "Errors: " + errs + " (" + okRate + "% ok)";

        $("cacheHitVal").textContent = data.cache.hitRatePercent + "% hit";
        $("workerSub").textContent =
          "LRU: " + data.cache.size + "/" + data.cache.maxEntries +
          " | Workers: " + data.workerPool.busyWorkers + " busy / " + data.workerPool.idleWorkers + " idle";

        const tbody = $("metricsTableBody");
        tbody.replaceChildren();
        const entries = Object.entries(data.metrics.tools);
        if (entries.length === 0) {
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 6;
          td.style.color = "var(--muted)";
          td.style.textAlign = "center";
          td.textContent = "No tool invocations recorded yet";
          tr.appendChild(td);
          tbody.appendChild(tr);
        } else {
          for (const [name, m] of entries) {
            const tr = document.createElement("tr");
            const cols = [name, m.calls, m.errors, m.averageDurationMs, m.maxDurationMs, m.lastDurationMs];
            cols.forEach((val, idx) => {
              const td = document.createElement("td");
              if (idx > 0) td.className = "num";
              td.textContent = String(val);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          }
        }

        const policyList = $("policyList");
        policyList.replaceChildren();
        const policies = [
          ["Write Confirmation Required", String(data.workspace.requireWriteConfirmation)],
          ["Max Write Payload", fmtMB(data.workspace.maxWriteBytes) + " MiB"],
          ["Max Resource Payload", fmtMB(data.workspace.maxResourceBytes) + " MiB"],
          ["Network HTTPS-Only", String(data.network.httpsOnly)],
          ["Network Egress Rules", data.network.allowHostsCount + " allow / " + data.network.denyHostsCount + " deny"],
          ["Network Conditional Cache", data.network.cacheEnabled ? "enabled" : "disabled"],
        ];
        for (const [k, v] of policies) {
          const kEl = document.createElement("div");
          kEl.className = "kv-key";
          kEl.textContent = k;
          const vEl = document.createElement("div");
          vEl.className = "kv-val";
          vEl.textContent = v;
          policyList.appendChild(kEl);
          policyList.appendChild(vEl);
        }

        clearAndAppendTextPills(
          $("rootsContainer"),
          data.workspace.roots.map((r) => r.id + " (" + r.name + ")"),
          "No workspace roots configured"
        );

        $("toolCountLabel").textContent = data.tools.length + " tools";
        clearAndAppendTextPills(
          $("toolsContainer"),
          data.tools.map((t) => t.name),
          "No tools exposed"
        );
      } catch (err) {
        $("statusDot").className = "status-dot error";
        $("lastUpdated").textContent = "Disconnected";
      }
    }

    function scheduleTimer() {
      if (timer) clearInterval(timer);
      const ms = Number($("refreshSelect").value);
      if (ms > 0) timer = setInterval(refresh, ms);
    }

    $("refreshSelect").addEventListener("change", scheduleTimer);
    $("refreshBtn").addEventListener("click", refresh);
    refresh();
    scheduleTimer();
  </script>
</body>
</html>`;
}

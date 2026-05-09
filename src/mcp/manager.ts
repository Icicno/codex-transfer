/**
 * MCP Manager — manages connections to multiple MCP servers.
 * Lazy initialization on first request, tool caching, connection lifecycle.
 */

import { McpClient } from "./client.js";
import type { McpServerConfig, McpTool, McpToolResult } from "./types.js";

/** Record of an executed MCP tool call (for building mcp_call output items). */
export interface McpCallRecord {
  name: string;
  serverLabel: string;
  toolName: string;
  arguments: string;
  output: string;
  error: string | null;
}

export class McpManager {
  private configs: Record<string, McpServerConfig>;
  private clients = new Map<string, McpClient>();
  private toolCache = new Map<string, McpTool[]>();
  private initializing = false;
  private initPromise: Promise<void> | null = null;
  private insecure: boolean;

  constructor(configs: Record<string, McpServerConfig>, insecure = false) {
    this.configs = configs;
    this.insecure = insecure;
  }

  /** Whether any MCP servers are configured. */
  hasServers(): boolean {
    return Object.keys(this.configs).length > 0;
  }

  /** Lazily connect all configured MCP servers (idempotent). */
  async ensureConnected(): Promise<void> {
    if (!this.hasServers()) return;
    if (this.clients.size === Object.keys(this.configs).length) return; // all connected

    // Prevent concurrent initialization
    if (this.initializing) {
      await this.initPromise;
      return;
    }

    this.initializing = true;
    this.initPromise = this.doConnect();
    try {
      await this.initPromise;
    } finally {
      this.initializing = false;
      this.initPromise = null;
    }
  }

  /**
   * Convert all cached MCP tools into Chat Completions nested function definitions.
   * Tool names are prefixed: __mcp_{server_label}_{original_name}
   * Output format: { type: "function", function: { name, description, parameters } }
   */
  getFunctionTools(): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [];
    for (const [label, mcpTools] of this.toolCache) {
      for (const tool of mcpTools) {
        tools.push({
          type: "function",
          function: {
            name: prefixedName(label, tool.name),
            description: tool.description ?? `[MCP:${label}] ${tool.name}`,
            parameters: tool.inputSchema,
          },
        });
      }
    }
    return tools;
  }

  /**
   * Parse a prefixed tool name back into server label and original tool name.
   * Format: __mcp_{server_label}::{tool_name}
   * Returns null if the name doesn't have the MCP prefix.
   */
  parseMcpToolName(
    name: string
  ): { serverLabel: string; toolName: string } | null {
    const PREFIX = "__mcp_";
    if (!name.startsWith(PREFIX)) return null;
    const rest = name.slice(PREFIX.length);
    const sepIdx = rest.indexOf("::");
    if (sepIdx < 0) return null;
    return {
      serverLabel: rest.slice(0, sepIdx),
      toolName: rest.slice(sepIdx + 2),
    };
  }

  /** Call an MCP tool by its server label and original name. */
  async callTool(
    serverLabel: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const client = this.clients.get(serverLabel);
    if (!client) {
      throw new Error(`MCP server "${serverLabel}" not connected`);
    }
    return client.callTool(toolName, args);
  }

  /** Close all connections (sends close notifications to MCP servers). */
  async close(): Promise<void> {
    const disconnects = [...this.clients.values()].map((c) =>
      c.disconnect().catch(() => {})
    );
    await Promise.allSettled(disconnects);
    this.clients.clear();
    this.toolCache.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async doConnect(): Promise<void> {
    const labels = Object.keys(this.configs);
    const results = await Promise.allSettled(
      labels.map(async (label) => {
        const config = this.configs[label];
        if (!config.url) {
          console.warn(
            `[mcp] "${label}": skipped (only HTTP URL supported in v1)`
          );
          return;
        }
        const client = new McpClient(label, config, this.insecure);
        try {
          await client.connect();
          const tools = await client.listTools();
          this.clients.set(label, client);
          this.toolCache.set(label, tools);
          console.log(
            `[mcp] "${label}": connected — ${tools.length} tool(s)`
          );
        } catch (e) {
          console.error(
            `[mcp] "${label}": failed to connect:`,
            e instanceof Error ? e.message : e
          );
        }
      })
    );

    // Log summary
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    if (fail > 0) {
      console.warn(
        `[mcp] ${ok}/${labels.length} server(s) connected, ${fail} failed`
      );
    }
  }
}

/**
 * Build prefixed tool name: __mcp_{server_label}::{tool_name}
 * Uses "::" as separator to avoid ambiguity when server label contains underscores.
 */
function prefixedName(serverLabel: string, toolName: string): string {
  return `__mcp_${serverLabel}::${toolName}`;
}

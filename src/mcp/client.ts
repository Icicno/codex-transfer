/**
 * MCP Client — communicates with MCP servers over Streamable HTTP transport.
 * Hand-written JSON-RPC 2.0, zero external dependencies.
 */

import type {
  McpServerConfig,
  McpInitializeResult,
  McpTool,
  McpToolResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

const PROTOCOL_VERSION = "2025-03-26";

/** Maximum SSE buffer size (10 MB) — prevents memory exhaustion from malformed upstream. */
const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024;

export class McpClient {
  private config: McpServerConfig;
  private serverLabel: string;
  private requestId = 0;
  private sessionId?: string;
  private connected = false;
  private insecure: boolean;

  constructor(serverLabel: string, config: McpServerConfig, insecure = false) {
    this.serverLabel = serverLabel;
    this.config = config;
    this.insecure = insecure;
  }

  /** Connect to the MCP server and complete the initialize handshake. */
  async connect(): Promise<McpInitializeResult> {
    if (this.config.url) {
      return this.connectHttp();
    }
    // stdio not supported in v1
    throw new Error(
      `MCP server "${this.serverLabel}": HTTP URL required (stdio not supported in v1)`
    );
  }

  /** Get the list of tools from the server (with pagination). */
  async listTools(): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.sendRequest("tools/list", {
        ...(cursor ? { cursor } : {}),
      })) as { tools: McpTool[]; nextCursor?: string };
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return allTools;
  }

  /** Call a tool on the server. */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    return (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
  }

  /** Whether the client has successfully connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Disconnect from the MCP server (send close notification, clear state). */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.sendNotification("notifications/closed");
    } catch {
      // Best-effort: server may already be unreachable
    }
    this.sessionId = undefined;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async connectHttp(): Promise<McpInitializeResult> {
    const result = (await this.sendRequest("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codex-transfer", version: "0.4.0" },
    })) as McpInitializeResult;

    // Send initialized notification (no id, no response expected)
    await this.sendNotification("notifications/initialized");
    this.connected = true;
    return result;
  }

  private async sendRequest(
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const id = ++this.requestId;
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };

    const headers: Record<string, string> = {
      ...this.config.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const resp = await fetch(this.config.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    // Capture session ID if provided
    const newSessionId = resp.headers.get("mcp-session-id");
    if (newSessionId) this.sessionId = newSessionId;

    const contentType = resp.headers.get("content-type") ?? "";

    // JSON response
    if (contentType.includes("application/json")) {
      const data = (await resp.json()) as JsonRpcResponse;
      if (data.error) {
        throw new Error(
          `MCP "${this.serverLabel}" error ${data.error.code}: ${data.error.message}`
        );
      }
      return data.result;
    }

    // SSE response — read until we get the JSON-RPC result
    if (contentType.includes("text/event-stream")) {
      return this.parseSSEResponse(resp);
    }

    // Fallback: try to parse as JSON
    const text = await resp.text();
    try {
      const data = JSON.parse(text) as JsonRpcResponse;
      if (data.error) {
        throw new Error(
          `MCP "${this.serverLabel}" error ${data.error.code}: ${data.error.message}`
        );
      }
      return data.result;
    } catch {
      throw new Error(
        `MCP "${this.serverLabel}": unexpected response (${resp.status}): ${text.slice(0, 200)}`
      );
    }
  }

  private async sendNotification(
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    const body = {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    };

    const headers: Record<string, string> = {
      ...this.config.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const resp = await fetch(this.config.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    // Consume body to release the TCP connection back to the pool
    await resp.body?.cancel().catch(() => {});
  }

  private async parseSSEResponse(resp: Response): Promise<unknown> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: unknown = undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Guard against unbounded buffer growth from malformed upstream
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          throw new Error(
            `MCP "${this.serverLabel}": SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes — aborting`
          );
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if ("result" in data || "error" in data) {
                if (data.error) {
                  throw new Error(
                    `MCP "${this.serverLabel}" error ${data.error.code}: ${data.error.message}`
                  );
                }
                result = data.result;
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue; // not JSON, skip
              throw e;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      try { await resp.body?.cancel(); } catch {}
    }

    if (result === undefined) {
      throw new Error(
        `MCP "${this.serverLabel}": no result found in SSE stream`
      );
    }
    return result;
  }
}

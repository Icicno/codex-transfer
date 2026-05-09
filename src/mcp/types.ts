/**
 * MCP (Model Context Protocol) type definitions.
 * Based on MCP spec 2025-11-25.
 * Only HTTP Streamable transport is supported in v1.
 */

// ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP Server Configuration ─────────────────────────────────────────────────

export interface McpServerConfig {
  /** HTTP mode: remote MCP server URL (Streamable HTTP) */
  url?: string;
  /** Custom HTTP headers sent with every request (e.g. Authorization, API keys) */
  headers?: Record<string, string>;
  /** stdio mode: spawn command */
  command?: string;
  /** stdio mode: command arguments */
  args?: string[];
  /** stdio mode: environment variables injected into the child process */
  env?: Record<string, string>;
}

// ── MCP Initialize ───────────────────────────────────────────────────────────

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

export interface McpInitializeResult {
  protocolVersion?: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

// ── MCP Tools ────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolListResult {
  tools: McpTool[];
  nextCursor?: string;
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpContentBlock {
  type: "text" | "image" | "audio" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

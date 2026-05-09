import { Hono } from "hono";
import { stream } from "hono/streaming";
import { SessionStore } from "./session.js";
import { toChatRequest, fromChatResponse } from "./translate.js";
import { translateStream } from "./stream.js";
import { loadConfig, type Config } from "./config.js";
import { McpManager } from "./mcp/manager.js";
import { callUpstream, mcpAgenticLoop } from "./mcp/loop.js";
import { mcpResultToSSE } from "./mcp/serialize.js";
import type {
  ResponsesRequest,
  ResponsesOutputItem,
  ChatRequest,
  ChatResponse,
} from "./types.js";

export interface TransferOptions {
  /** Skip TLS certificate verification (for corporate proxies with MITM) */
  disableTlsVerify?: boolean;
  /** Path to config file (JSON format) */
  configPath?: string;
  /** Override port (highest priority) */
  port?: number;
  /** Override upstream (highest priority) */
  upstream?: string;
  /** Override apiKey (highest priority) */
  apiKey?: string;
  /** Override model name (highest priority, supersedes modelMap) */
  modelOverride?: string;
}

export function createTransfer(options: TransferOptions = {}) {
  // Load config: CLI options > env vars > config file > defaults
  const fileConfig = loadConfig(options.configPath);

  const port = options.port ?? fileConfig.port;
  // TLS verification skip
  const insecure = options.disableTlsVerify || fileConfig.insecure;
  if (insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("[transfer] TLS certificate verification disabled (--insecure)");
  }

  const upstream = (options.upstream ?? fileConfig.upstream).replace(
    /\/+$/,
    ""
  );
  const apiKey = options.apiKey ?? fileConfig.apiKey;
  const modelOverride = options.modelOverride;

  const sessions = new SessionStore();
  const app = new Hono();

  // ── MCP Manager ────────────────────────────────────────────────────────────
  const mcpManager = new McpManager(fileConfig.mcpServers, insecure);

  // ── P2: Graceful shutdown — close MCP connections on exit ──────────────────
  const shutdownMcp = () => {
    mcpManager.close().catch(() => {});
  };
  process.on("SIGTERM", shutdownMcp);
  process.on("SIGINT", shutdownMcp);

  // ── GET /health — diagnostic endpoint ──────────────────────────────────────
  app.get("/health", async (c) => {
    const result: Record<string, unknown> = {
      upstream,
      apiKeySet: !!apiKey,
      apiKeyPrefix: apiKey ? `${apiKey.slice(0, 6)}...` : "(empty)",
    };
    // Test upstream connectivity
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const resp = await fetch(`${upstream}/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      result.upstreamStatus = resp.status;
      result.upstreamOk = resp.ok;
      await resp.body?.cancel().catch(() => {});
    } catch (e) {
      result.upstreamError = e instanceof Error ? e.message : String(e);
      result.upstreamCause =
        e instanceof Error && e.cause ? String(e.cause) : null;
    }
    // MCP status
    if (mcpManager.hasServers()) {
      await mcpManager.ensureConnected();
      result.mcpServers = true;
    }
    return c.json(result);
  });

  // ── GET /v1/models ────────────────────────────────────────────────────────
  app.get("/v1/models", async (c) => {
    let resp: Response | undefined;
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      resp = await fetch(`${upstream}/models`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return c.json({ object: "list", data: [] });
      }
      const body = await resp.json();
      return c.json(body);
    } catch {
      return c.json({ object: "list", data: [] });
    }
  });

  // ── POST /v1/responses ────────────────────────────────────────────────────
  app.post("/v1/responses", async (c) => {
    let req: ResponsesRequest;
    try {
      req = await c.req.json<ResponsesRequest>();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[transfer] JSON parse error: ${msg}`);
      return c.text(msg, 422);
    }

    const inputLen = typeof req.input === "string" ? 1 : (req.input as unknown[])?.length ?? 0;
    const model = modelOverride ?? resolveModel(req.model, fileConfig.modelMap);
    console.log(`[transfer] ← POST /v1/responses model=${req.model}${model !== req.model ? ` → ${model}` : ""} stream=${req.stream} input_items=${inputLen} tools=${req.tools?.length ?? 0} prev=${req.previous_response_id ?? "none"}`);

    const history = req.previous_response_id
      ? sessions.getHistory(req.previous_response_id)
      : [];

    // ── MCP: connect and inject MCP tools if configured ──────────────────────
    let mcpFunctionTools: Record<string, unknown>[] = [];
    if (mcpManager.hasServers()) {
      try {
        await mcpManager.ensureConnected();
        mcpFunctionTools = mcpManager.getFunctionTools();
        if (mcpFunctionTools.length > 0) {
          console.log(`[mcp] injecting ${mcpFunctionTools.length} MCP tool(s)`);
        }
      } catch (e) {
        console.error("[mcp] failed to initialize:", e instanceof Error ? e.message : e);
      }
    }

    const chatReq = toChatRequest(req, history, sessions);
    // Override model AFTER toChatRequest — translate uses req.model internally
    chatReq.model = model;
    // Strip reasoning_effort if disabled in config (thinking toggle is always sent)
    if (!fileConfig.reasoningEffort) {
      delete chatReq.reasoning_effort;
    }

    // Inject MCP function tools alongside regular tools
    if (mcpFunctionTools.length > 0) {
      chatReq.tools = [...(chatReq.tools ?? []), ...mcpFunctionTools];
    }

    const url = `${upstream}/chat/completions`;

    if (req.stream) {
      // ── Streaming path ──────────────────────────────────────────────────
      const responseId = sessions.newId();
      const requestMessages = [...chatReq.messages];

      return stream(c, async (streamWriter) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const signal = c.req.raw.signal;

        if (mcpFunctionTools.length > 0) {
          // ── MCP streaming: internal non-streaming agentic loop → SSE ────
          const mcpReq = { ...chatReq, stream: false };
          const { response: mcpResp, history: mcpHistory } = await mcpAgenticLoop(url, apiKey, mcpReq, mcpManager, model, signal);

          // Save session so previous_response_id works
          if (mcpHistory.length > 0) {
            sessions.saveWithId(responseId, mcpHistory);
            console.log(`[transfer]   Session saved: ${responseId} (${mcpHistory.length} messages)`);
          }

          // Convert MCP result to streaming SSE events
          const sseEvents = mcpResultToSSE(mcpResp, responseId, model);
          for (const event of sseEvents) {
            if (signal.aborted) break;
            await streamWriter.write(event);
          }
        } else {
          // ── Standard streaming (no MCP) ────────────────────────────────
          const sseStream = translateStream({
            url,
            apiKey,
            chatReq,
            responseId,
            sessions,
            priorMessages: history,
            requestMessages,
            model,
          }, signal);

          try {
            for await (const event of sseStream) {
              if (signal.aborted) break;
              await streamWriter.write(event);
            }
          } catch (e) {
            if (!signal.aborted) {
              console.error("Stream write error:", e);
            }
          }
        }
      });
    } else {
      // ── Non-streaming path ─────────────────────────────────────────────
      chatReq.stream = false;

      if (mcpFunctionTools.length > 0) {
        // ── P1: Non-streaming MCP path with AbortSignal.timeout() fallback ──
        const nonStreamingSignal = AbortSignal.timeout(120_000); // 2 min timeout
        const { response: mcpResp, history: mcpHistory } = await mcpAgenticLoop(url, apiKey, chatReq, mcpManager, model, nonStreamingSignal);

        // Save session so previous_response_id works
        if (mcpHistory.length > 0) {
          const mcpResponseId = sessions.save(mcpHistory);
          mcpResp.id = mcpResponseId;
          console.log(`[transfer]   Session saved: ${mcpResponseId} (${mcpHistory.length} messages)`);
        }

        // Log MCP response summary
        const mcpOutput = (mcpResp.output ?? []) as ResponsesOutputItem[];
        const mcpOutputTypes = mcpOutput.map((o) => o.type).join(", ");
        const mcpUsage = mcpResp.usage as Record<string, number> | undefined;
        console.log(
          `[transfer] ✓ Response completed (MCP): output=[${mcpOutputTypes}], ` +
          `usage: ${mcpUsage?.input_tokens ?? 0}→${mcpUsage?.output_tokens ?? 0} tokens`
        );

        return c.json(mcpResp);
      }

      // Standard non-streaming (no MCP)
      const chatResp = await callUpstream(url, apiKey, chatReq);
      if (!chatResp) {
        return c.text("upstream error", 502);
      }

      const assistantMsg = chatResp.choices?.[0]?.message ?? {
        role: "assistant",
        content: "",
      };
      const fullHistory = [...chatReq.messages, assistantMsg];
      const responseId = sessions.save(fullHistory);
      const { response } = fromChatResponse(responseId, model, chatResp);

      // Log session save
      console.log(`[transfer]   Session saved: ${responseId} (${fullHistory.length} messages)`);

      return c.json(response);
    }
  });

  // ── Fallback ──────────────────────────────────────────────────────────────
  app.all("*", (c) => {
    console.warn(`unhandled ${c.req.method} ${c.req.path}`);
    return c.text("not found", 404);
  });

  return { app, port };
}

// Re-export for standalone usage
export { SessionStore } from "./session.js";
export { toChatRequest, fromChatResponse } from "./translate.js";
export { translateStream } from "./stream.js";
export * from "./types.js";

// ── Helper functions ────────────────────────────────────────────────────────

/**
 * Resolve model name using modelMap.
 * Lookup order: exact key match → wildcard "*" → original name.
 */
function resolveModel(
  model: string,
  modelMap: Record<string, string>
): string {
  if (modelMap[model]) return modelMap[model];
  if (modelMap["*"]) return modelMap["*"];
  return model;
}

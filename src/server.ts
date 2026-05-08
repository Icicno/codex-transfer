import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { SessionStore } from "./session.js";
import { toChatRequest, fromChatResponse } from "./translate.js";
import { translateStream } from "./stream.js";
import { loadConfig, type Config } from "./config.js";
import type {
  ResponsesRequest,
  ChatRequest,
  ChatMessage,
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

  // ── GET /health — diagnostic endpoint ────────────────────────────────────────
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
    } catch (e) {
      result.upstreamError = e instanceof Error ? e.message : String(e);
      result.upstreamCause =
        e instanceof Error && e.cause ? String(e.cause) : null;
    }
    return c.json(result);
  });

  // ── GET /v1/models ──────────────────────────────────────────────────────────
  app.get("/v1/models", async (c) => {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const resp = await fetch(`${upstream}/models`, { headers });
      if (!resp.ok) {
        return c.json({ object: "list", data: [] });
      }
      const body = await resp.json();
      return c.json(body);
    } catch {
      return c.json({ object: "list", data: [] });
    }
  });

  // ── POST /v1/responses ──────────────────────────────────────────────────────
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
    const chatReq = toChatRequest(req, history, sessions);
    // Override model AFTER toChatRequest — translate uses req.model internally
    chatReq.model = model;
    const url = `${upstream}/chat/completions`;

    if (req.stream) {
      const responseId = sessions.newId();
      chatReq.stream = true;
      const requestMessages = [...chatReq.messages];

      return stream(c, async (streamWriter) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const signal = c.req.raw.signal;

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
      });
    } else {
      // Non-streaming (blocking) path
      chatReq.stream = false;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(chatReq),
        });

        // Approach C: if upstream rejects reasoning_effort (400), retry without it
        if (!resp.ok && resp.status === 400 && chatReq.reasoning_effort) {
          const errBody = await resp.text().catch(() => "");
          console.warn(`[transfer] upstream rejected reasoning_effort, retrying without it: ${errBody.slice(0, 200)}`);
          const { reasoning_effort: _, ...stripped } = chatReq;
          resp = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(stripped),
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`upstream error: ${msg}`);
        return c.text(msg, 502);
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error(`upstream ${resp.status}: ${body}`);
        return c.text(body, resp.status as ContentfulStatusCode);
      }

      const chatResp = (await resp.json()) as ChatResponse;
      const assistantMsg = chatResp.choices?.[0]?.message ?? {
        role: "assistant",
        content: "",
      };

      const fullHistory = [...chatReq.messages, assistantMsg];
      const responseId = sessions.save(fullHistory);

      const { response } = fromChatResponse(responseId, model, chatResp);
      return c.json(response);
    }
  });

  // ── Fallback ────────────────────────────────────────────────────────────────
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

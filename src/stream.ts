import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRequest, ChatStreamChunk, ChatUsage } from "./types.js";
import type { SessionStore } from "./session.js";
import { mapUsage } from "./translate.js";

export interface StreamArgs {
  url: string;
  apiKey: string;
  chatReq: ChatRequest;
  responseId: string;
  sessions: SessionStore;
  priorMessages: ChatMessage[];
  /** The fully translated request messages (including replayed history). */
  requestMessages: ChatMessage[];
  model: string;
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Translate an upstream Chat Completions SSE stream into a Responses API SSE stream.
 *
 * Text response event sequence:
 *   response.created → response.output_item.added (message) → response.output_text.delta*
 *   → response.output_item.done → response.completed
 *
 * Tool call response event sequence:
 *   response.created → [accumulate deltas] → response.output_item.added (function_call)
 *   → response.function_call_arguments.delta → response.output_item.done → response.completed
 */
export async function* translateStream(
  args: StreamArgs,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const {
    url,
    apiKey,
    chatReq,
    responseId,
    sessions,
    priorMessages,
    requestMessages,
    model,
  } = args;

  // Wrap everything in a top-level try to prevent unhandled exceptions
  // from killing the stream without response.completed
  try {
    const msgItemId = `msg_${randomUUID().replace(/-/g, "")}`;
    const createdAt = Math.floor(Date.now() / 1000);

    // Yield response.created
    yield formatSSE("response.created", {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model,
        output: [],
        usage: null,
      },
    });

    // Open upstream connection
    let upstream: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      console.log(`[transfer] POST ${url} model=${chatReq.model} stream=${chatReq.stream} key=${apiKey ? `${apiKey.slice(0, 6)}...` : "(empty)"}`);

      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(chatReq),
        signal,
      });
  } catch (e) {
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    // Node.js native fetch wraps the real error in e.cause
    const cause = e instanceof Error && e.cause ? ` | cause: ${e.cause}` : "";
    console.error(`[transfer] fetch failed: ${msg}${cause}`);
      yield sseFailed(responseId, model, "connection_error", msg);
      return;
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      console.error(`[transfer] upstream ${upstream.status}: ${body.slice(0, 500)}`);
      yield sseFailed(responseId, model, String(upstream.status), body);
      return;
    }

    if (!upstream.body) {
      yield sseFailed(responseId, model, "no_body", "upstream returned no body");
      return;
    }

    // Parse SSE stream from upstream
    let accumulatedText = "";
    let accumulatedReasoning = "";
    const toolCalls = new Map<number, ToolCallAccum>();
    let emittedMessageItem = false;
    let done = false;
    let streamUsage: ChatUsage | undefined;

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!done) {
        if (signal?.aborted) break;

        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (e) {
          if (signal?.aborted) break;
          console.error(`[transfer] stream read error:`, e);
          break;
        }

        if (readResult.done) break;
        buffer += decoder.decode(readResult.value, { stream: true });

        // Parse complete lines from buffer (handle both \n and \r\n)
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? ""; // Keep incomplete last line

        let currentData = "";
        for (const line of lines) {
          // Skip comments (lines starting with :)
          if (line.startsWith(":")) continue;

          // Handle data: lines (with or without space after colon)
          if (line.startsWith("data:")) {
            const value = line.slice(5);
            // SSE spec: strip optional leading space
            const data = value.startsWith(" ") ? value.slice(1) : value;

            if (data === "[DONE]") {
              done = true;
              break;
            }

            // Multi-line data: concatenate with newline
            if (currentData) {
              currentData += "\n" + data;
            } else {
              currentData = data;
            }
          } else if (line.trim() === "" && currentData) {
            // Empty line = end of event, process the data
            try {
              const chunk: ChatStreamChunk = JSON.parse(currentData);

              // Check for error in chunk
              const err = (chunk as unknown as Record<string, unknown>).error;
              if (err) {
                console.error(`[transfer] upstream error in stream:`, err);
              }

              // Capture usage from upstream (usually in the final chunk)
              if (chunk.usage) {
                streamUsage = chunk.usage;
              }

              for (const choice of chunk.choices ?? []) {
                // Reasoning/thinking content (DeepSeek, kimi-k2.6, etc.)
                const rc = choice.delta?.reasoning_content;
                if (rc) {
                  accumulatedReasoning += rc;
                }

                // Text content
                const content = choice.delta?.content ?? "";
                if (content) {
                  if (!emittedMessageItem) {
                    yield formatSSE("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: 0,
                      item: {
                        type: "message",
                        id: msgItemId,
                        role: "assistant",
                        status: "in_progress",
                        content: [],
                      },
                    });
                    emittedMessageItem = true;
                  }
                  accumulatedText += content;
                  yield formatSSE("response.output_text.delta", {
                    type: "response.output_text.delta",
                    item_id: msgItemId,
                    output_index: 0,
                    content_index: 0,
                    delta: content,
                  });
                }

                // Tool call deltas — accumulate by index
                const deltaCalls = choice.delta?.tool_calls;
                if (deltaCalls) {
                  for (const dc of deltaCalls) {
                    let entry = toolCalls.get(dc.index);
                    if (!entry) {
                      entry = { id: "", name: "", arguments: "" };
                      toolCalls.set(dc.index, entry);
                    }
                    if (dc.id) entry.id = dc.id;
                    if (dc.function?.name) entry.name += dc.function.name;
                    if (dc.function?.arguments)
                      entry.arguments += dc.function.arguments;
                  }
                }

                // Check finish_reason
                if (choice.finish_reason) {
                  // Don't break - continue reading until [DONE] or stream end
                }
              }
            } catch (parseErr) {
              console.warn(`[transfer] SSE chunk parse error: ${parseErr} — data: ${currentData.slice(0, 200)}`);
            }
            currentData = "";
          }
          // Ignore other field types (event:, id:, retry:, etc.)
        }
      }
    } finally {
      reader.releaseLock();
      try {
        await upstream.body?.cancel();
      } catch {}
    }

    // Close message item if one was opened
    if (emittedMessageItem) {
      yield formatSSE("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: msgItemId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: accumulatedText }],
        },
      });
    }

    // Emit function_call items for each accumulated tool call
    const baseIndex = emittedMessageItem ? 1 : 0;
    const fcItems: Record<string, unknown>[] = [];

    let relIdx = 0;
    for (const [, tc] of toolCalls) {
      const fcItemId = `fc_${randomUUID().replace(/-/g, "")}`;
      const outputIndex = baseIndex + relIdx;

      yield formatSSE("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: fcItemId,
          call_id: tc.id,
          name: tc.name,
          arguments: "",
          status: "in_progress",
        },
      });

      if (tc.arguments) {
        yield formatSSE("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: fcItemId,
          output_index: outputIndex,
          delta: tc.arguments,
        });
      }

      yield formatSSE("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: fcItemId,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: "completed",
        },
      });

      fcItems.push({
        type: "function_call",
        id: fcItemId,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed",
      });

      relIdx++;
    }

    // Persist turn to session store
    for (const tc of toolCalls.values()) {
      if (tc.id) {
        sessions.storeReasoning(tc.id, accumulatedReasoning);
      }
    }

    const assistantToolCalls =
      toolCalls.size > 0
        ? [...toolCalls.values()].map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }))
        : null;

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: accumulatedText || null,
      reasoning_content: accumulatedReasoning || null,
      tool_calls: assistantToolCalls,
    };

    // Index reasoning by turn fingerprint
    if (accumulatedReasoning) {
      sessions.storeTurnReasoning(requestMessages, assistantMsg, accumulatedReasoning);
    }

    const messages = [...priorMessages, assistantMsg];
    sessions.saveWithId(responseId, messages);

    // Build output array for response.completed
    const outputItems: Record<string, unknown>[] = [];
    if (emittedMessageItem) {
      outputItems.push({
        type: "message",
        id: msgItemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: accumulatedText }],
      });
    }
    outputItems.push(...fcItems);

    yield formatSSE("response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        created_at: createdAt,
        status: "completed",
        model,
        output: outputItems,
        usage: streamUsage
          ? mapUsage(streamUsage)
          : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });

    console.log(`[transfer] stream completed: ${accumulatedText.length} chars, ${toolCalls.size} tool calls`);
  } catch (e) {
    // Top-level catch: prevent unhandled exceptions from killing the stream silently
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[transfer] unhandled stream error: ${msg}`);
    yield sseFailed(args.responseId, args.model, "internal_error", msg);
  }
}

/** Build a response.failed SSE event. */
function sseFailed(
  responseId: string,
  model: string,
  code: string,
  message: string
): string {
  return formatSSE("response.failed", {
    type: "response.failed",
    response: {
      id: responseId,
      status: "failed",
      model,
      error: { code, message },
    },
  });
}

/** Format a data payload as an SSE event string. */
function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

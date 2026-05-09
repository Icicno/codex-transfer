/**
 * MCP → SSE serialization.
 * Converts MCP agentic loop results into Responses API SSE event streams.
 * Also provides the shared formatSSE utility used by stream.ts and server.ts.
 */

import { randomUUID } from "node:crypto";
import type { ResponsesOutputItem } from "../types.js";

/** Format a data payload as an SSE event string. */
export function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Convert an MCP agentic loop result (Responses API JSON) into streaming SSE events.
 * Used when MCP tools are configured in streaming mode — the agentic loop runs
 * non-streaming internally, then this function converts the result to SSE for Codex CLI.
 *
 * Yields events incrementally to avoid allocating a large events array in memory.
 */
export function* mcpResultToSSE(
  result: Record<string, unknown>,
  responseId: string,
  model: string
): Generator<string> {
  const createdAt = Math.floor(Date.now() / 1000);
  const output = (result.output ?? []) as ResponsesOutputItem[];

  // response.created
  yield formatSSE("response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status: "in_progress",
      model,
      output: [],
      usage: result.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
  });

  // Process each output item
  let outputIndex = 0;
  for (const item of output) {
    if (item.type === "mcp_call") {
      // MCP call — emit as a single item
      yield formatSSE("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "mcp_call",
          id: item.id,
          server_label: item.server_label,
        },
      });
      yield formatSSE("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
    } else if (item.type === "message") {
      // Message — emit text as delta
      const itemId = `msg_${randomUUID().replace(/-/g, "")}`;
      yield formatSSE("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });

      const textParts = (item.content ?? []).filter(
        (p) => p.type === "output_text"
      );
      let contentIndex = 0;
      for (const part of textParts) {
        yield formatSSE("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: part.text ?? "",
        });
        contentIndex++;
      }

      yield formatSSE("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "completed",
          content: item.content,
        },
      });
    } else if (item.type === "function_call") {
      // Regular function call (from mixed MCP+normal scenario)
      yield formatSSE("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: item.id,
          call_id: item.call_id,
          name: item.name,
          arguments: "",
          status: "in_progress",
        },
      });
      yield formatSSE("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      yield formatSSE("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
    }
    outputIndex++;
  }

  // response.completed
  yield formatSSE("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status: "completed",
      model,
      output,
      usage: result.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
  });
}

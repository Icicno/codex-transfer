import type {
  ResponsesRequest,
  ResponsesInputItem,
  ChatRequest,
  ChatMessage,
  ChatResponse,
  ResponsesResponse,
  ResponsesOutputItem,
  ContentPart,
  ResponsesUsage,
  ChatUsage,
} from "./types.js";
import type { SessionStore } from "./session.js";

/**
 * Convert a Responses API request + prior history into a Chat Completions request.
 */
export function toChatRequest(
  req: ResponsesRequest,
  history: ChatMessage[],
  sessions: SessionStore
): ChatRequest {
  const messages: ChatMessage[] = [...history];

  // Prefer `instructions` (Codex CLI) over `system` (other clients).
  const systemText = req.instructions ?? req.system;
  if (systemText) {
    if (messages.length === 0 || messages[0].role !== "system") {
      messages.unshift({
        role: "system",
        content: systemText,
      });
    }
  }

  // Append new input, mapping Responses API roles to Chat Completions roles.
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else {
    const items = req.input as ResponsesInputItem[];
    let i = 0;
    while (i < items.length) {
      const item = items[i];
      const itemType = item.type ?? "";

      if (itemType === "function_call") {
        // Collect this and all immediately following function_call items
        // into one assistant message with multiple tool_calls entries.
        const grouped: Record<string, unknown>[] = [];
        let reasoningContent: string | undefined;

        while (i < items.length) {
          const cur = items[i];
          if ((cur.type ?? "") !== "function_call") break;

          const callId = cur.call_id ?? "";
          const name = cur.name ?? "";
          const args = cur.arguments ?? "{}";

          if (!reasoningContent) {
            reasoningContent = sessions.getReasoning(callId);
          }

          grouped.push({
            id: callId,
            type: "function",
            function: { name, arguments: args },
          });
          i++;
        }

        const msg: ChatMessage = {
          role: "assistant",
          content: null,
          reasoning_content: reasoningContent ?? null,
          tool_calls: grouped,
        };

        // Fallback: try turn-level fingerprint if call_id lookup missed
        if (!msg.reasoning_content) {
          msg.reasoning_content =
            sessions.getTurnReasoning(messages, msg) ?? null;
        }

        messages.push(msg);
      } else if (itemType === "function_call_output") {
        const callId = item.call_id ?? "";
        const output = item.output ?? "";
        messages.push({
          role: "tool",
          content: output,
          tool_call_id: callId,
        });
        i++;
      } else {
        // Regular user/assistant/developer message
        let role = item.role ?? "user";
        if (role === "developer") role = "system";

        const content = valueToText(item.content);
        const msg: ChatMessage = { role, content };

        // For assistant messages, try to recover reasoning_content
        if (role === "assistant") {
          msg.reasoning_content =
            sessions.getTurnReasoning(messages, msg) ?? null;
        }

        messages.push(msg);
        i++;
      }
    }
  }

  // Keep only `function` tools; providers like DeepSeek don't accept
  // OpenAI-proprietary built-ins (web_search, computer, file_search, …).
  // Skip empty arrays — Rust version uses skip_serializing_if = "Vec::is_empty".
  const filteredTools = (req.tools ?? [])
    .filter((t) => t.type === "function")
    .map(convertTool);

  // Post-process: ensure every assistant(tool_calls) is immediately followed
  // by its corresponding tool messages. Codex may interleave other messages
  // (user/assistant text) between function_call and function_call_output items,
  // which violates Chat Completions strict ordering requirement.
  const reordered = reorderForToolCalls(messages);

  return {
    model: req.model,
    messages: reordered,
    ...(filteredTools.length > 0 ? { tools: filteredTools } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.max_output_tokens != null ? { max_tokens: req.max_output_tokens } : {}),
    stream: req.stream ?? false,
  };
}

/**
 * Responses API tool format → Chat Completions tool format.
 *
 * Responses API (flat):
 *   {"type":"function","name":"foo","description":"...","parameters":{...},"strict":false}
 *
 * Chat Completions (nested):
 *   {"type":"function","function":{"name":"foo","description":"...","parameters":{...}}}
 */
function convertTool(tool: Record<string, unknown>): Record<string, unknown> {
  // Already in Chat Completions format if it has a "function" sub-object.
  if ("function" in tool) return tool;

  // Convert from Responses API flat format.
  if (tool.type === "function") {
    const func: Record<string, unknown> = {};
    if ("name" in tool) func.name = tool.name;
    if ("description" in tool) func.description = tool.description;
    if ("parameters" in tool) func.parameters = tool.parameters;
    if ("strict" in tool) func.strict = tool.strict;
    return { type: "function", function: func };
  }

  return tool;
}

/**
 * Convert a Chat Completions response into a Responses API response.
 */
export function fromChatResponse(
  id: string,
  model: string,
  chat: ChatResponse
): { response: ResponsesResponse; assistantMessage: ChatMessage } {
  const choice = chat.choices?.[0] ?? {
    message: { role: "assistant", content: "" },
  };

  const text = choice.message.content ?? "";
  const usage = chat.usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  const output: ResponsesOutputItem[] = [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ];

  const respUsage = mapUsage(usage);

  const response: ResponsesResponse = {
    id,
    object: "response",
    model,
    output,
    usage: respUsage,
  };

  return { response, assistantMessage: choice.message };
}

/**
 * Map upstream Chat Completions usage to Responses API usage.
 *
 * Handles two upstream formats:
 * - OpenAI standard: `prompt_tokens_details.cached_tokens`
 * - DeepSeek:        `prompt_cache_hit_tokens` (top-level)
 *
 * `reasoning_tokens` uses the same nested path in both formats.
 */
export function mapUsage(usage: ChatUsage): ResponsesUsage {
  const cachedTokens =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens;

  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;

  const result: ResponsesUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };

  if (cachedTokens != null) {
    result.input_tokens_details = { cached_tokens: cachedTokens };
  }
  if (reasoningTokens != null) {
    result.output_tokens_details = { reasoning_tokens: reasoningTokens };
  }

  return result;
}

/**
 * Collapse a Responses API content value (string or parts array) to plain text.
 */
function valueToText(
  v: string | ContentPart[] | undefined | null
): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => p.text ?? "")
      .join("");
  }
  return String(v);
}

/**
 * Reorder messages so that every assistant message with tool_calls is
 * immediately followed by all its corresponding tool messages.
 *
 * Codex replays the full conversation as Responses API input[] items, where
 * function_call and function_call_output may be interleaved with other messages.
 * Chat Completions providers (DeepSeek, etc.) enforce strict ordering:
 *   assistant(tool_calls) → tool(call_1) → tool(call_2) → assistant/tool_calls → ...
 */
function reorderForToolCalls(messages: ChatMessage[]): ChatMessage[] {
  // Quick check: if no tool_calls at all, skip reordering.
  const hasToolCalls = messages.some(
    (m) => m.role === "assistant" && m.tool_calls?.length
  );
  if (!hasToolCalls) return messages;

  // Build a lookup map: tool_call_id → tool message
  const toolMsgMap = new Map<string, ChatMessage>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      // If duplicate tool_call_id exists, last one wins (consistent with providers)
      toolMsgMap.set(msg.tool_call_id, msg);
    }
  }

  // Rebuild: for each non-tool message, push it, then if it's an assistant
  // with tool_calls, immediately insert the matching tool messages.
  const result: ChatMessage[] = [];
  const consumedToolIds = new Set<string>();

  for (const msg of messages) {
    // Skip tool messages — they'll be re-inserted after their assistant message.
    if (msg.role === "tool" && msg.tool_call_id) {
      continue;
    }

    result.push(msg);

    // After an assistant with tool_calls, insert tool messages inline.
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const callId = (tc as Record<string, unknown>).id as string | undefined;
        if (callId) {
          const toolMsg = toolMsgMap.get(callId);
          if (toolMsg) {
            result.push(toolMsg);
            consumedToolIds.add(callId);
          } else {
            // No matching tool output — synthesise an empty one so the provider
            // doesn't reject the request for missing tool messages.
            result.push({
              role: "tool",
              content: "(no output)",
              tool_call_id: callId,
            });
            consumedToolIds.add(callId);
          }
        }
      }
    }
  }

  // Append any orphan tool messages that weren't matched to an assistant.
  for (const [callId, msg] of toolMsgMap) {
    if (!consumedToolIds.has(callId)) {
      result.push(msg);
    }
  }

  return result;
}

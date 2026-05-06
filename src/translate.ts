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

  return {
    model: req.model,
    messages,
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

  const respUsage: ResponsesUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };

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

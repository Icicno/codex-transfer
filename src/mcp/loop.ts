/**
 * MCP Agentic Loop — iteratively execute MCP tool calls until the LLM
 * returns a plain text response or a non-MCP tool call.
 *
 * Flow:
 *   1. Call LLM
 *   2. If LLM returns tool_calls, separate MCP vs regular
 *   3. Execute MCP tools, append results to messages, loop back to 1
 *   4. If no tool_calls or only regular tool_calls, return final response
 */

import { randomUUID } from "node:crypto";
import { McpManager, type McpCallRecord } from "./manager.js";
import type {
  ChatRequest,
  ChatMessage,
  ChatResponse,
  ResponsesOutputItem,
} from "../types.js";

/** Maximum iterations for the MCP agentic loop. */
const MAX_MCP_ITERATIONS = 10;

/** Call the upstream LLM (non-streaming). Returns ChatResponse or null on failure. */
export async function callUpstream(
  url: string,
  apiKey: string,
  chatReq: ChatRequest,
  signal?: AbortSignal
): Promise<ChatResponse | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  console.log(
    `[transfer] POST ${url} model=${chatReq.model} stream=false key=${
      apiKey ? `${apiKey.slice(0, 6)}...` : "(empty)"
    }`
  );

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[transfer] upstream error: ${msg}`);
    return null;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`[transfer] upstream ${resp.status}: ${body}`);
    return null;
  }

  return (await resp.json()) as ChatResponse;
}

export async function mcpAgenticLoop(
  url: string,
  apiKey: string,
  chatReq: ChatRequest,
  mcpManager: McpManager,
  model: string,
  signal?: AbortSignal
): Promise<{ response: Record<string, unknown>; history: ChatMessage[] }> {
  const mcpCallRecords: McpCallRecord[] = [];
  const currentReq = { ...chatReq, messages: [...chatReq.messages] };
  let lastChatResp: ChatResponse | undefined;

  for (let i = 0; i < MAX_MCP_ITERATIONS; i++) {
    if (signal?.aborted) {
      return { response: { error: "aborted", status: 499 }, history: [] };
    }
    lastChatResp = undefined;

    // 1. Call LLM
    const result = await callUpstream(url, apiKey, currentReq, signal);
    if (!result) {
      return {
        response: { error: "upstream error", status: 502 },
        history: [],
      };
    }
    lastChatResp = result;

    const choice = lastChatResp.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;

    // 2. No tool calls → done
    if (!toolCalls || toolCalls.length === 0) {
      console.log(
        `[mcp] Loop ${i + 1}/${MAX_MCP_ITERATIONS}: LLM returned text only → done`
      );
      break;
    }

    // 3. Classify tool calls: MCP vs regular
    const mcpCalls: {
      tc: Record<string, unknown>;
      parsed: { serverLabel: string; toolName: string };
    }[] = [];
    const normalCalls: Record<string, unknown>[] = [];

    for (const tc of toolCalls) {
      const tcRec = tc as Record<string, unknown>;
      const func = tcRec.function as Record<string, unknown>;
      const parsed = mcpManager.parseMcpToolName(func.name as string);
      if (parsed) {
        mcpCalls.push({ tc: tcRec, parsed });
      } else {
        normalCalls.push(tcRec);
      }
    }

    const mcpNames = mcpCalls.map(
      (c) => `${c.parsed.serverLabel}/${c.parsed.toolName}`
    );
    const normalNames = normalCalls.map(
      (c) =>
        ((c.function as Record<string, unknown>)?.name as string) ?? "?"
    );
    console.log(
      `[mcp] Loop ${i + 1}/${MAX_MCP_ITERATIONS}: LLM returned ${
        toolCalls.length
      } tool_call(s) ` +
        `(MCP=${mcpCalls.length}${
          mcpNames.length > 0 ? ` [${mcpNames.join(", ")}]` : ""
        }, ` +
        `normal=${normalCalls.length}${
          normalNames.length > 0 ? ` [${normalNames.join(", ")}]` : ""
        })`
    );

    // 4. Has regular tool calls → exit loop (Codex will handle them)
    if (normalCalls.length > 0) {
      // If mixed: execute MCP first, then exit
      if (mcpCalls.length > 0) {
        await executeMcpCalls(
          mcpCalls,
          mcpCallRecords,
          mcpManager,
          currentReq
        );
        // One more LLM call to get the final response after MCP results
        const finalResult = await callUpstream(url, apiKey, currentReq, signal);
        if (finalResult) {
          lastChatResp = finalResult;
        }
      }
      break;
    }

    // 5. Only MCP calls → execute and loop
    await executeMcpCalls(mcpCalls, mcpCallRecords, mcpManager, currentReq);
  }

  // Build final response
  if (!lastChatResp) {
    return {
      response: {
        error: "MCP agentic loop: no response from LLM",
        status: 500,
      },
      history: [],
    };
  }

  const assistantMsg = lastChatResp.choices?.[0]?.message ?? {
    role: "assistant",
    content: "",
  };

  const fullHistory = [
    ...chatReq.messages,
    ...currentReq.messages.slice(chatReq.messages.length),
    assistantMsg,
  ];

  // Log agentic loop summary
  const finalText = assistantMsg.content ?? "";
  const finalToolCalls = assistantMsg.tool_calls?.length ?? 0;
  console.log(
    `[mcp] ✓ Agentic loop completed: ${mcpCallRecords.length} MCP call(s) executed, ` +
      `final response: text=${finalText.length} chars, tool_calls=${finalToolCalls}`
  );

  // Build output with MCP call records
  const output: ResponsesOutputItem[] = [];

  // MCP call records → mcp_call output items
  for (const record of mcpCallRecords) {
    output.push({
      type: "mcp_call",
      id: `mcp_${randomUUID().replace(/-/g, "")}`,
      name: record.toolName,
      server_label: record.serverLabel,
      arguments: record.arguments,
      output: record.output,
      error: record.error,
    });
  }

  // Final LLM response
  const text = assistantMsg.content ?? "";
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }

  // If there are regular tool_calls (exited loop with mixed calls)
  if (assistantMsg.tool_calls) {
    for (const tc of assistantMsg.tool_calls) {
      const tcRec = tc as Record<string, unknown>;
      const func = tcRec.function as Record<string, unknown>;
      output.push({
        type: "function_call",
        id: `fc_${randomUUID().replace(/-/g, "")}`,
        call_id: (tcRec.id as string) ?? "",
        name: (func?.name as string) ?? "",
        arguments: (func?.arguments as string) ?? "{}",
        status: "completed",
      });
    }
  }

  // Fallback: empty output
  if (output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
    });
  }

  return {
    response: {
      id: `resp_${randomUUID().replace(/-/g, "")}`,
      object: "response",
      model,
      output,
      usage: lastChatResp.usage
        ? {
            input_tokens: lastChatResp.usage.prompt_tokens,
            output_tokens: lastChatResp.usage.completion_tokens,
            total_tokens: lastChatResp.usage.total_tokens,
            input_tokens_details: {
              cached_tokens:
                lastChatResp.usage.prompt_tokens_details?.cached_tokens ??
                lastChatResp.usage.prompt_cache_hit_tokens ??
                0,
            },
            output_tokens_details: {
              reasoning_tokens:
                lastChatResp.usage.completion_tokens_details?.reasoning_tokens ??
                0,
            },
          }
        : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    history: fullHistory,
  };
}

/** Execute MCP tool calls, append results to currentReq.messages. */
async function executeMcpCalls(
  mcpCalls: {
    tc: Record<string, unknown>;
    parsed: { serverLabel: string; toolName: string };
  }[],
  records: McpCallRecord[],
  mcpManager: McpManager,
  currentReq: ChatRequest
): Promise<void> {
  // Add assistant message with tool_calls to messages
  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: mcpCalls.map(({ tc }) => tc),
  };
  currentReq.messages.push(assistantMsg);

  // Execute each MCP call
  for (const { tc, parsed } of mcpCalls) {
    const func = tc.function as Record<string, unknown>;
    const argsStr = (func.arguments as string) ?? "{}";
    const callId = (tc.id as string) ?? "";

    let output: string;
    let error: string | null = null;

    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;
      const result = await mcpManager.callTool(
        parsed.serverLabel,
        parsed.toolName,
        args
      );
      output = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (result.isError) error = output;
    } catch (e) {
      output = e instanceof Error ? e.message : String(e);
      error = output;
    }

    records.push({
      name: parsed.toolName,
      serverLabel: parsed.serverLabel,
      toolName: parsed.toolName,
      arguments: argsStr,
      output,
      error,
    });

    // Add tool result message
    currentReq.messages.push({
      role: "tool",
      content: output,
      tool_call_id: callId,
    });

    if (error) {
      console.error(
        `[mcp] ${parsed.serverLabel}/${parsed.toolName}: ERROR — ${output}`
      );
    } else {
      console.log(
        `[mcp] ${parsed.serverLabel}/${parsed.toolName}: OK (${output.length} chars)`
      );
    }
  }
}

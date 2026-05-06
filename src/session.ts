import { randomUUID, createHash } from "node:crypto";
import type { ChatMessage } from "./types.js";

/**
 * Maps response_id → accumulated message history for that session.
 * Codex uses `previous_response_id` to continue a conversation; we maintain
 * the full messages[] here so each Chat Completions call is self-contained.
 *
 * Also maintains call_id → reasoning_content so that thinking-capable models
 * (e.g. DeepSeek, kimi-k2.6) can have their reasoning_content round-tripped
 * back when Codex replays tool-call history in subsequent requests.
 *
 * For assistant messages without tool calls (pure text), reasoning_content
 * is indexed by a fingerprint of the assistant content, so it can be recovered
 * when Codex replays the full conversation in `input` without using
 * `previous_response_id`.
 */
export class SessionStore {
  /** response_id → message history */
  private history = new Map<string, ChatMessage[]>();
  /** call_id → reasoning_content */
  private reasoning = new Map<string, string>();
  /** content-hash → reasoning_content (turn-level fallback) */
  private turnReasoning = new Map<string, string>();

  // ── Reasoning by call_id ────────────────────────────────────────────────────

  /** Store reasoning_content keyed by the tool call_id. */
  storeReasoning(callId: string, reasoning: string): void {
    if (reasoning) {
      this.reasoning.set(callId, reasoning);
    }
  }

  /** Look up stored reasoning_content for a call_id. */
  getReasoning(callId: string): string | undefined {
    return this.reasoning.get(callId);
  }

  // ── Reasoning by turn content (fallback) ────────────────────────────────────

  /** Store reasoning_content for an assistant turn, keyed by content hash. */
  storeTurnReasoning(
    _prior: ChatMessage[],
    assistant: ChatMessage,
    reasoning: string
  ): void {
    if (!reasoning) return;

    const content = assistant.content ?? "";
    if (content) {
      this.turnReasoning.set(this.contentKey(content), reasoning);
    }

    // Also store under each tool call_id (existing mechanism).
    if (assistant.tool_calls) {
      for (const tc of assistant.tool_calls) {
        const id = (tc as Record<string, unknown>).id as string | undefined;
        if (id) {
          this.storeReasoning(id, reasoning);
        }
      }
    }
  }

  /** Look up reasoning_content for an assistant turn by its text content. */
  getTurnReasoning(
    _prior: ChatMessage[],
    assistant: ChatMessage
  ): string | undefined {
    const content = assistant.content ?? "";
    if (!content) return undefined;
    return this.turnReasoning.get(this.contentKey(content));
  }

  /** Hash assistant message content for turn-level reasoning lookup. */
  private contentKey(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  // ── History storage ─────────────────────────────────────────────────────────

  /** Retrieve history for a prior response_id, or empty array if not found. */
  getHistory(responseId: string): ChatMessage[] {
    return this.history.get(responseId) ?? [];
  }

  /** Allocate a fresh response_id. */
  newId(): string {
    return `resp_${randomUUID().replace(/-/g, "")}`;
  }

  /** Store under a pre-allocated response_id (streaming path). */
  saveWithId(id: string, messages: ChatMessage[]): void {
    this.history.set(id, messages);
  }

  /** Allocate an id and store atomically (non-streaming path). */
  save(messages: ChatMessage[]): string {
    const id = this.newId();
    this.history.set(id, messages);
    return id;
  }
}

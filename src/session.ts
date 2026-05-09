import { randomUUID, createHash } from "node:crypto";
import type { ChatMessage } from "./types.js";

/** Wrapper that tracks insertion time for TTL-based eviction. */
interface TimedEntry<T> {
  value: T;
  createdAt: number;
}

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
 *
 * Memory management:
 * - All maps use timed entries with TTL-based expiration (default 30 min).
 * - history is capped at MAX_HISTORY entries (oldest evicted first).
 * - reasoning/turnReasoning are capped at MAX_REASONING entries.
 * - A periodic cleanup timer runs every 5 minutes (unref'd, won't block exit).
 */
export class SessionStore {
  // ── Configuration ─────────────────────────────────────────────────────────

  /** Maximum number of history sessions to retain. */
  static readonly MAX_HISTORY = 1000;
  /** Maximum number of reasoning entries (per map). */
  static readonly MAX_REASONING = 5000;
  /** Time-to-live in milliseconds (default: 30 minutes). */
  static readonly TTL_MS = 30 * 60 * 1000;
  /** Cleanup interval in milliseconds (default: 5 minutes). */
  static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  // ── Storage ───────────────────────────────────────────────────────────────

  /** response_id → message history */
  private history = new Map<string, TimedEntry<ChatMessage[]>>();
  /** call_id → reasoning_content */
  private reasoning = new Map<string, TimedEntry<string>>();
  /** content-hash → reasoning_content (turn-level fallback) */
  private turnReasoning = new Map<string, TimedEntry<string>>();

  /** Periodic cleanup timer — unref'd so it won't prevent process exit. */
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      SessionStore.CLEANUP_INTERVAL_MS
    );
    // Don't block Node.js process exit.
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  // ── Reasoning by call_id ──────────────────────────────────────────────────

  /** Store reasoning_content keyed by the tool call_id. */
  storeReasoning(callId: string, reasoning: string): void {
    if (reasoning) {
      this.reasoning.set(callId, { value: reasoning, createdAt: Date.now() });
      this.evictIfOverCapacity(this.reasoning, SessionStore.MAX_REASONING);
    }
  }

  /** Look up stored reasoning_content for a call_id. Returns undefined if expired/missing. */
  getReasoning(callId: string): string | undefined {
    const entry = this.reasoning.get(callId);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > SessionStore.TTL_MS) {
      this.reasoning.delete(callId);
      return undefined;
    }
    return entry.value;
  }

  // ── Reasoning by turn content (fallback) ──────────────────────────────────

  /** Store reasoning_content for an assistant turn, keyed by content hash. */
  storeTurnReasoning(
    _prior: ChatMessage[],
    assistant: ChatMessage,
    reasoning: string
  ): void {
    if (!reasoning) return;

    const content = assistant.content ?? "";
    if (content) {
      this.turnReasoning.set(this.contentKey(content), {
        value: reasoning,
        createdAt: Date.now(),
      });
      this.evictIfOverCapacity(
        this.turnReasoning,
        SessionStore.MAX_REASONING
      );
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
    const key = this.contentKey(content);
    const entry = this.turnReasoning.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > SessionStore.TTL_MS) {
      this.turnReasoning.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Hash assistant message content for turn-level reasoning lookup. */
  private contentKey(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  // ── History storage ───────────────────────────────────────────────────────

  /** Retrieve history for a prior response_id, or empty array if not found/expired. */
  getHistory(responseId: string): ChatMessage[] {
    const entry = this.history.get(responseId);
    if (!entry) return [];
    if (Date.now() - entry.createdAt > SessionStore.TTL_MS) {
      this.history.delete(responseId);
      return [];
    }
    return entry.value;
  }

  /** Allocate a fresh response_id. */
  newId(): string {
    return `resp_${randomUUID().replace(/-/g, "")}`;
  }

  /** Store under a pre-allocated response_id (streaming path). */
  saveWithId(id: string, messages: ChatMessage[]): void {
    this.history.set(id, { value: messages, createdAt: Date.now() });
    this.evictIfOverCapacity(this.history, SessionStore.MAX_HISTORY);
  }

  /** Allocate an id and store atomically (non-streaming path). */
  save(messages: ChatMessage[]): string {
    const id = this.newId();
    this.history.set(id, { value: messages, createdAt: Date.now() });
    this.evictIfOverCapacity(this.history, SessionStore.MAX_HISTORY);
    return id;
  }

  // ── Eviction helpers ──────────────────────────────────────────────────────

  /**
   * Evict oldest entries when map exceeds capacity.
   * Map insertion order reflects creation time (oldest first in JS Maps).
   */
  private evictIfOverCapacity<T>(
    map: Map<string, TimedEntry<T>>,
    maxSize: number
  ): void {
    if (map.size <= maxSize) return;
    const toRemove = map.size - maxSize;
    const keys = map.keys();
    for (let i = 0; i < toRemove; i++) {
      const k = keys.next().value;
      if (k !== undefined) map.delete(k);
    }
  }

  /**
   * Remove all expired entries from all maps.
   * Called periodically by the cleanup timer.
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.history) {
      if (now - entry.createdAt > SessionStore.TTL_MS) {
        this.history.delete(key);
        removed++;
      }
    }
    for (const [key, entry] of this.reasoning) {
      if (now - entry.createdAt > SessionStore.TTL_MS) {
        this.reasoning.delete(key);
        removed++;
      }
    }
    for (const [key, entry] of this.turnReasoning) {
      if (now - entry.createdAt > SessionStore.TTL_MS) {
        this.turnReasoning.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(
        `[session] cleanup: removed ${removed} expired entries ` +
          `(history=${this.history.size}, reasoning=${this.reasoning.size}, turnReasoning=${this.turnReasoning.size})`
      );
    }
  }
}

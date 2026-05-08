// ── Responses API (inbound from Codex CLI) ──────────────────────────────────

export interface ResponsesRequest {
  model: string;
  input: ResponsesInput;
  previous_response_id?: string;
  tools?: Record<string, unknown>[];
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  /** Responses API system prompt field (some clients use `system`, others `instructions`) */
  system?: string;
  instructions?: string;
}

export type ResponsesInput = string | ResponsesInputItem[];

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  [key: string]: unknown;
}

export interface ContentPart {
  type: string;
  text?: string;
}

export interface ResponsesResponse {
  id: string;
  object: "response";
  model: string;
  output: ResponsesOutputItem[];
  usage: ResponsesUsage;
}

export interface ResponsesOutputItem {
  type: string;
  role: string;
  content: ContentPart[];
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

// ── Chat Completions (outbound to provider) ──────────────────────────────────

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Record<string, unknown>[];
  temperature?: number;
  max_tokens?: number;
  stream: boolean;
}

export interface ChatMessage {
  role: string;
  content?: string | null;
  /** Reasoning/thinking content emitted by models like kimi-k2.6 / DeepSeek.
   *  Must be round-tripped back when replaying tool call history. */
  reasoning_content?: string | null;
  tool_calls?: Record<string, unknown>[] | null;
  tool_call_id?: string | null;
  name?: string | null;
}

export interface ChatResponse {
  choices: ChatChoice[];
  usage?: ChatUsage;
}

export interface ChatChoice {
  message: ChatMessage;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** OpenAI standard format: nested detail fields */
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek format: top-level cache fields */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

// ── SSE streaming types ───────────────────────────────────────────────────────

export interface ChatStreamChunk {
  choices: ChatStreamChoice[];
  usage?: ChatUsage;
}

export interface ChatStreamChoice {
  delta: ChatDelta;
  finish_reason?: string | null;
}

export interface ChatDelta {
  role?: string | null;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeltaToolCall[] | null;
}

export interface DeltaToolCall {
  index: number;
  id?: string | null;
  function?: DeltaFunction | null;
}

export interface DeltaFunction {
  name?: string | null;
  arguments?: string | null;
}

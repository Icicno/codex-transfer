# codex-transfer

**English** | [中文](./README.md)

> Responses API ↔ Chat Completions translation bridge — use DeepSeek, Kimi, Qwen, and other OpenAI-compatible providers with Codex CLI.

## Overview

Codex CLI communicates using OpenAI's **Responses API**, while most third-party LLM providers (DeepSeek, Moonshot, Qwen, etc.) only implement the earlier **Chat Completions API**. These two APIs differ significantly in request format, response structure, streaming event sequences, and tool call representation.

`codex-transfer` runs a local HTTP proxy that transparently translates Responses API requests from Codex CLI into Chat Completions API requests, and reverse-translates upstream responses back into Responses API format — so Codex CLI never notices the difference.

```
Codex CLI (Responses API)  →  codex-transfer (:4444)  →  Third-party Provider (Chat Completions API)
```

- **Zero runtime dependencies**: esbuild bundles everything into a single `dist/codex-transfer.mjs` file — run via `npx` instantly
- **Stateless by design**: in-process session management, no external database required
- **~1500 lines of TypeScript**: lightweight and auditable

---

## Quick Start

```bash
# One-shot run (no install needed)
npx @classicicn/codex-transfer -k

# Specify upstream provider
npx @classicicn/codex-transfer -k -u https://api.deepseek.com/v1 --api-key sk-xxx

# Global install
npm install -g @classicicn/codex-transfer
codex-transfer -k
```

---

## CLI Options

```
codex-transfer [options]

Options:
  -p, --port PORT        Listen port (default: 4444)
  -u, --upstream URL     Upstream Chat Completions base URL
      --api-key KEY      API key for upstream
  -m, --model MODEL      Force override model name (highest priority)
  -c, --config PATH      Path to config file (JSON)
  -k, --insecure         Skip TLS certificate verification
      --reasoning-effort   Send reasoning effort to upstream (default: off)
  -d, --daemon           Run in background, logs to logs/ directory
  -h, --help             Show this help
```

### Daemon Mode

```bash
codex-transfer -d -k -u https://api.deepseek.com/v1 --api-key sk-xxx

# Output:
# codex-transfer started in background (PID: 12345)
# Log file: ~/.codex-transfer/logs/codex-transfer-20260507-143022.log
# PID file: ~/.codex-transfer/logs/codex-transfer.pid
# Stop:   kill $(cat ~/.codex-transfer/logs/codex-transfer.pid)
```

In daemon mode, all `console` output is redirected to timestamped log files. Logs auto-rotate when a single file exceeds **10MB**, keeping up to **5 historical files**.

---

## Configuration

### Priority

```
CLI args > environment variables > config file > defaults
```

### Config File

Create a JSON config file at one of these locations (searched in order):

1. Explicit `--config` path or `CODEX_TRANSFER_CONFIG` env var
2. `./codex-transfer.json` (current directory)
3. `~/.codex-transfer/config.json` (user home)

```json
{
  "port": 4446,
  "upstream": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-key-here",
  "insecure": false,
  "reasoningEffort": false,
  "modelMap": {
    "*": "deepseek-v4-pro",
    "codex-auto-review": "deepseek-v4-pro"
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_TRANSFER_PORT` | `4444` | Listen port |
| `CODEX_TRANSFER_UPSTREAM` | `https://openrouter.ai/api/v1` | Upstream Chat Completions base URL |
| `CODEX_TRANSFER_API_KEY` | _(empty)_ | API key forwarded to upstream |
| `CODEX_TRANSFER_CONFIG` | _(auto)_ | Path to config file |
| `CODEX_TRANSFER_INSECURE` | `false` | Set to `"1"` or `"true"` to skip TLS verification |
| `CODEX_TRANSFER_REASONING_EFFORT` | `false` | Set to `"1"` or `"true"` to enable sending reasoning_effort |

### Model Name Mapping

Codex CLI may send non-standard model names (e.g. `codex-auto-review`) that upstream providers don't recognize. Use `modelMap` to translate them:

```json
{
  "modelMap": {
    "*": "deepseek-v4-pro",
    "codex-auto-review": "deepseek-v4-pro"
  }
}
```

**Lookup order**: exact key match → wildcard `"*"` → original name passthrough.

The `--model` / `-m` flag takes precedence over `modelMap`, overriding all model names.

---

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check — tests upstream `/models` connectivity, returns diagnostics |
| `GET` | `/v1/models` | Model catalog proxy — transparently forwards upstream model list |
| `POST` | `/v1/responses` | **Core endpoint** — receives Responses API requests, translates and forwards upstream |

### `/v1/responses` Request Flow

```
Codex request arrives
  → JSON parse & validate
  → resolveModel() model name mapping
  → Load message history (via previous_response_id)
  → toChatRequest() protocol translation
  → Branch:
     ├─ stream=true  → translateStream() SSE generator → text/event-stream
     └─ stream=false → fetch upstream → fromChatResponse() → JSON
```

---

## Features in Detail

### Protocol Translation

Full bidirectional translation between Responses API and Chat Completions API:

- **Request translation**: `input` array (`function_call` / `function_call_output` / regular messages) → Chat Completions `messages[]` array
- **Response translation**: Chat Completions `choices[0].message` → Responses API `output[]` structure
- **System prompt**: `instructions` (Codex CLI field) → Chat Completions `system` role
- **Role mapping**: `developer` → `system`

### Streaming Translation (SSE)

Upstream Chat Completions SSE delta stream is translated chunk-by-chunk into the standard Responses API event sequence:

```
response.created
  → response.output_item.added (message)
  → response.output_text.delta × N
  → response.output_item.done
  → [if tool calls present]
     response.output_item.added (function_call)
     → response.function_call_arguments.delta
     → response.output_item.done
  → response.completed
```

**Design notes**:
- Text deltas are forwarded in real time; tool call deltas are batched after stream completion (Chat Completions scatters tool calls across multiple chunks by index)
- Top-level error fallback: even if upstream disconnects unexpectedly, a `response.failed` event is emitted, preventing Codex CLI from hanging

### Token Usage Details

Codex CLI relies on the usage fields in Responses API to calculate context window utilization. `codex-transfer` automatically extracts token usage from upstream responses and maps them to the Responses API format, handling differences between OpenAI and DeepSeek upstream formats:

| Responses API Output | OpenAI Upstream Field | DeepSeek Upstream Field |
|---|---|---|
| `input_tokens` | `prompt_tokens` | `prompt_tokens` |
| `output_tokens` | `completion_tokens` | `completion_tokens` |
| `total_tokens` | `total_tokens` | `total_tokens` |
| `input_tokens_details.cached_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` |
| `output_tokens_details.reasoning_tokens` | `completion_tokens_details.reasoning_tokens` | `completion_tokens_details.reasoning_tokens` |

**Auto-detection**: The upstream format is automatically detected based on which fields are present in the response — no configuration needed. `cached_tokens` prefers the OpenAI nested field, falling back to the DeepSeek top-level field; `reasoning_tokens` uses the same path in both formats. Detail objects are omitted when the corresponding fields are absent.

Both non-streaming and streaming paths share the same mapping logic.

### Reasoning Effort Mapping

Codex CLI controls model reasoning intensity via `reasoning.effort` (none/low/medium/high/xhigh), but providers implement this differently. `codex-transfer` automatically maps the Responses API reasoning effort to provider-specific parameters:

| Codex Level | Responses API Value | DeepSeek | MiMo / Kimi / GLM |
|---|---|---|---|
| Minimal | `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` |
| Low | `low` | `thinking: {type: "enabled"}, reasoning_effort: "high"` | `thinking: {type: "enabled"}` |
| Medium | `medium` | `thinking: {type: "enabled"}, reasoning_effort: "high"` | `thinking: {type: "enabled"}` |
| High | `high` | `thinking: {type: "enabled"}, reasoning_effort: "high"` | `thinking: {type: "enabled"}` |
| Ultra | `xhigh` | `thinking: {type: "enabled"}, reasoning_effort: "max"` | `thinking: {type: "enabled"}` |

**Compatibility strategy**: The `thinking` toggle is always sent (supported by all providers). `reasoning_effort` is not sent by default (to avoid 400 errors from incompatible providers); to enable it, use the `--reasoning-effort` CLI flag or `"reasoningEffort": true` in the config file.

### Session Management

Codex CLI uses `previous_response_id` for multi-turn conversations. `SessionStore` maintains the full message history for each session in memory, making every Chat Completions call **self-contained** (no dependency on upstream context caching).

```
┌─────────────────────────────────┐
│  SessionStore (in-memory)        │
│                                 │
│  history:  Map<response_id,     │
│                 ChatMessage[]>   │
│                                 │
│  reasoning: Map<call_id,        │
│                 reasoning_text>  │
│                                 │
│  turnReasoning: Map<            │
│    SHA256(content),              │
│    reasoning_text>               │
│  )                              │
└─────────────────────────────────┘
```

### Reasoning Model Support (DeepSeek-R1 / Kimi-K2.6)

Reasoning models produce `reasoning_content` (chain of thought) that must be **round-tripped verbatim** across turns — otherwise the model may reject the request or behave incorrectly.

`codex-transfer` uses a **dual-index cache** to recover reasoning content:

| Index method | Use case | Implementation |
|-------------|----------|----------------|
| **call_id exact match** | Codex uses `previous_response_id` + tool call replay | `Map<call_id, reasoning>` |
| **Content SHA256 fingerprint** | Codex replays full `input[]` without `previous_response_id` | `Map<SHA256(content), reasoning>` |

The two mechanisms complement each other, covering both conversation replay modes of Codex CLI.

### Tool Call Handling

- **Tool filtering**: Automatically filters OpenAI-proprietary built-in tools (`web_search`, `file_search`, `computer`, etc.), keeping only `type: "function"` custom tools to prevent upstream rejection
- **Format conversion**: Responses API flat format `{type, name, description, parameters}` ↔ Chat Completions nested format `{type, function: {name, description, parameters}}`
- **Parallel tool calls**: Consecutive `function_call` input items are merged into a single assistant message with multiple `tool_calls` entries
- **Message reordering**: Codex may interleave other messages between `function_call` and `function_call_output` items, but providers like DeepSeek strictly require `assistant(tool_calls)` immediately followed by matching `tool` messages. `reorderForToolCalls()` handles this automatically, synthesizing empty output for orphaned tool calls

### Health Check

```
GET /health → 200 OK
{
  "upstream": "https://api.deepseek.com/v1",
  "apiKeySet": true,
  "apiKeyPrefix": "sk-abc…",
  "upstreamStatus": 200,
  "upstreamOk": true
}
```

---

## Supported Providers

Any provider implementing the OpenAI Chat Completions API format is supported.

| Provider | Base URL |
|----------|----------|
| DeepSeek | `https://api.deepseek.com/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/v1` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

> Any OpenAI API-compatible provider should work in principle. If you find a working provider not listed here, PRs are welcome.

---

## Codex CLI Configuration

Add to `~/.codex/config.toml`:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek-transfer"

[model_providers.deepseek-transfer]
name = "DeepSeek"
base_url = "http://127.0.0.1:4446/v1"
wire_api = "responses"
```

> **Note**: The `base_url` port must match the `codex-transfer` listen port, and `wire_api` must be `"responses"`.

---

## Project Structure

```
src/
├── cli.ts         CLI entry — argument parsing, daemon process management, log rotation
├── server.ts      HTTP server — Hono route registration, request dispatch, proxy instance creation
├── config.ts      Configuration — multi-source merging, priority control, config file discovery
├── session.ts     Session state — message history storage, dual-index reasoning cache
├── translate.ts   Protocol translation — Responses ↔ Chat Completions bidirectional conversion
├── stream.ts      SSE translation — streaming chunk parsing, event sequence generation, error fallback
└── types.ts       Type definitions — complete TypeScript types for both APIs
build.mjs          Build script — esbuild single-file bundling
```

### Dependency Graph

```
cli.ts → server.ts → translate.ts + stream.ts → session.ts + types.ts
                  → config.ts
```

### Data Flow

```
                    ┌─────────────┐
                    │   Config    │ ◄── CLI / ENV / File
                    └──────┬──────┘
                           │
  Codex ──POST──► Server ──┼──► toChatRequest() ──► fetch ──► Upstream
    ▲              │       │                                    │
    │              │   SessionStore                             │
    └──SSE/JSON────┘   (history +                               │
                        reasoning)  ◄── translateStream() ──────┘
                                    ◄── fromChatResponse()
```

---

## Build

```bash
git clone https://github.com/Icicno/codex-transfer.git
cd codex-transfer
npm install
npm run build        # esbuild bundle + tsc type check
node dist/codex-transfer.mjs -k

# Or link as a global command
npm link
codex-transfer -k
```

---

## Programmatic Usage

```typescript
import { createTransfer } from "./src/server.js";

const { app, port } = createTransfer({
  configPath: "./codex-transfer.json",
  port: 4446,
  upstream: "https://api.deepseek.com/v1",
  apiKey: "sk-...",
  disableTlsVerify: true,
});
```

---

## Changelog

### v0.3.3 (2026-05-09)

- **Non-streaming tool call support**: `fromChatResponse()` now correctly handles `tool_calls`, generating `function_call` output items (previously the non-streaming path ignored tool calls entirely)
- **Streaming arguments incremental delivery**: `response.output_item.added` and `response.function_call_arguments.delta` events are now emitted in real time during streaming, instead of being sent in batch after stream completion

### v0.3.0 (2026-05-08)

- **Token usage**: Extract usage from upstream streaming responses — Codex now correctly displays context utilization (fixes 0% display issue)
- **Usage details**: Auto-map `cached_tokens` and `reasoning_tokens`, compatible with both OpenAI and DeepSeek upstream formats
- **Reasoning effort**: Map `reasoning.effort` to DeepSeek `thinking`/`reasoning_effort` and MiMo/Kimi/GLM `thinking` toggle
- **Config-driven control**: `reasoning_effort` is off by default; enable via `--reasoning-effort` or `reasoningEffort` config option

### v0.2.0 (2026-05-07)

- First npm release
- Responses API ↔ Chat Completions bidirectional protocol translation
- Streaming SSE event generation, session management, reasoning model support
- Model name mapping, daemon mode, log rotation
- TLS certificate bypass, config file support

---

## License

MIT

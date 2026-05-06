# codex-transfer

Responses API ↔ Chat Completions translation bridge for Codex CLI (TypeScript implementation)

## Overview

A lightweight proxy that translates the OpenAI **Responses API** (used by Codex CLI) into the **Chat Completions API**, letting Codex work with any OpenAI-compatible provider — DeepSeek, Kimi, Qwen, Mistral, Groq, xAI, OpenRouter, and more.

```
Codex CLI (Responses API) → codex-transfer → DeepSeek (Chat Completions API)
```

## Quick Start

```bash
# Install and build
npm install
npm run build

# Run
node dist/codex-transfer.mjs -k
```

## CLI Options

```
codex-transfer [options]

Options:
  -p, --port PORT        Listen port (default: 4444)
  -u, --upstream URL     Upstream Chat Completions base URL
      --api-key KEY      API key for upstream
  -c, --config PATH      Path to config file (JSON)
  -k, --insecure         Skip TLS certificate verification
  -h, --help             Show this help
```

## Configuration

Priority: CLI args > environment variables > config file > defaults

### Config File

Create a JSON config file at one of these locations:
- `./codex-transfer.json` (current directory)
- `~/.codex-transfer/config.json` (user home)
- Custom path via `--config` or `CODEX_TRANSFER_CONFIG`

```json
{
  "port": 4446,
  "upstream": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-key-here",
  "insecure": false
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_TRANSFER_PORT` | `4444` | Listen port |
| `CODEX_TRANSFER_UPSTREAM` | `https://openrouter.ai/api/v1` | Upstream Chat Completions base URL |
| `CODEX_TRANSFER_API_KEY` | _(empty)_ | API key forwarded to upstream |
| `CODEX_TRANSFER_CONFIG` | _(auto)_ | Path to config file |
| `CODEX_TRANSFER_INSECURE` | `false` | Skip TLS certificate verification |

## Usage

### Method 1: Direct execution

```bash
node dist/codex-transfer.mjs -k -p 4446 -u https://api.deepseek.com/v1
```

### Method 2: npm link (global command)

```bash
npm link
# Then run directly
codex-transfer -k
```

### Method 3: npx

```bash
npx codex-transfer -k
```

### Method 4: As a library

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

## Codex Configuration

Add to `~/.codex/config.toml`:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek-transfer"

[model_providers.deepseek-transfer]
name = "DeepSeek"
base_url = "http://127.0.0.1:4446/v1"
wire_api = "responses"
```

## Supported Providers

| Provider | Base URL |
|----------|----------|
| DeepSeek | `https://api.deepseek.com/v1` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| xAI | `https://api.x.ai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

## Features

- **Single-file bundle** — `dist/codex-transfer.mjs` has zero runtime dependencies
- **Streaming** — full SSE streaming with correct event sequencing
- **Tool calls** — accumulates streaming deltas and emits structured function_call items
- **Parallel tool calls** — consecutive function_call input items merged into one assistant message
- **Reasoning models** — preserves `reasoning_content` across turns (DeepSeek, kimi-k2.6)
- **Model catalog** — proxies `/v1/models` from the upstream provider
- **Health check** — `GET /health` diagnostic endpoint
- **TLS skip** — supports corporate proxy / self-signed certificate scenarios

## Project Structure

| File | Description |
|------|-------------|
| `src/types.ts` | Responses/Chat Completions API type definitions |
| `src/config.ts` | Configuration loading (file + env vars) |
| `src/session.ts` | Session store and reasoning content cache |
| `src/translate.ts` | Request/response translation logic |
| `src/stream.ts` | SSE stream translation |
| `src/server.ts` | HTTP server (Hono) |
| `src/cli.ts` | CLI entry point |
| `build.mjs` | esbuild bundler script |

## License

MIT

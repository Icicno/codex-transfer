# codex-transfer

Responses API ↔ Chat Completions 转换桥（TypeScript 实现）

## 概述

一个轻量级代理，用于将 OpenAI **Responses API**（Codex CLI 使用）转换为 **Chat Completions API**，让 Codex 能够与任何 OpenAI 兼容的提供商配合使用——DeepSeek、Kimi、Qwen、Mistral、Groq、xAI、OpenRouter 等。

```
Codex CLI (Responses API) → codex-transfer → DeepSeek (Chat Completions API)
```

## 快速开始

```bash
# 安装依赖并打包
npm install
npm run build

# 启动
node dist/codex-transfer.mjs -k
```

## 命令行参数

```
codex-transfer [options]

Options:
  -p, --port PORT        监听端口（默认 4444）
  -u, --upstream URL     上游 Chat Completions 地址
      --api-key KEY      上游 API 密钥
  -m, --model MODEL      强制覆盖模型名（最高优先级）
  -c, --config PATH      配置文件路径（JSON）
  -k, --insecure         跳过 TLS 证书验证
  -d, --daemon           后台运行，日志输出到 logs/ 目录
  -h, --help             显示帮助
```

## 配置

配置优先级：CLI 参数 > 环境变量 > 配置文件 > 默认值

### 配置文件

在以下位置之一创建 JSON 配置文件：
- `./codex-transfer.json`（当前目录）
- `~/.codex-transfer/config.json`（用户主目录）
- 通过 `--config` 或 `CODEX_TRANSFER_CONFIG` 指定

```json
{
  "port": 4446,
  "upstream": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-key-here",
  "insecure": false,
  "modelMap": {
    "*": "deepseek-v4-pro"
  }
}
```

### 模型名映射

Codex CLI 可能发送上游不识别的模型名（如 `codex-auto-review`）。使用 `modelMap` 进行转换：

```json
{
  "modelMap": {
    "*": "deepseek-v4-pro",
    "codex-auto-review": "deepseek-v4-pro"
  }
}
```

查找顺序：精确匹配 key → 通配符 `"*"` → 原始模型名（直接透传）。

也可使用 `--model` CLI 参数强制覆盖所有模型名：

```bash
codex-transfer --model deepseek-v4-pro -k
```

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `CODEX_TRANSFER_PORT` | `4444` | 监听端口 |
| `CODEX_TRANSFER_UPSTREAM` | `https://openrouter.ai/api/v1` | 上游 Chat Completions 地址 |
| `CODEX_TRANSFER_API_KEY` | _(空)_ | 上游 API 密钥 |
| `CODEX_TRANSFER_CONFIG` | _(自动)_ | 配置文件路径 |
| `CODEX_TRANSFER_INSECURE` | `false` | 跳过 TLS 验证 |

## 使用方式

### 方式一：直接运行打包产物

```bash
node dist/codex-transfer.mjs -k -p 4446 -u https://api.deepseek.com/v1
```

### 方式二：npm link（全局命令）

```bash
npm link
# 之后可直接执行
codex-transfer -k
```

### 方式三：npx

```bash
npx codex-transfer -k
```

### 方式四：后台运行

```bash
# 启动后台进程（日志输出到配置文件同级 logs/ 目录）
node dist/codex-transfer.mjs -d -k

# 输出示例：
# codex-transfer started in background (PID: 12345)
# Log file: ~/.codex-transfer/logs/codex-transfer.log
# PID file: ~/.codex-transfer/logs/codex-transfer.pid
# Stop:   kill $(cat ~/.codex-transfer/logs/codex-transfer.pid)

# 查看日志
tail -f ~/.codex-transfer/logs/codex-transfer.log

# 停止
kill $(cat ~/.codex-transfer/logs/codex-transfer.pid)
```

### 方式五：作为库使用

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

## Codex 配置

在 `~/.codex/config.toml` 中添加：

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek-transfer"

[model_providers.deepseek-transfer]
name = "DeepSeek"
base_url = "http://127.0.0.1:4446/v1"
wire_api = "responses"
```

## 支持的提供商

| 提供商 | 基础 URL |
|--------|----------|
| DeepSeek | `https://api.deepseek.com/v1` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| xAI | `https://api.x.ai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

## 功能特性

- **单文件打包** — `dist/codex-transfer.mjs` 无外部依赖，拷贝即用
- **流式传输** — 完整的 SSE 流式传输，正确的事件排序
- **工具调用** — 累积流式增量并发出结构化的 function_call 项目
- **并行工具调用** — 连续的 function_call 输入项目合并为单个 assistant 消息
- **工具调用消息排序** — 自动重排消息，确保 `assistant(tool_calls)` 后紧跟对应的 `tool` 消息（DeepSeek 等严格提供商要求）
- **模型名映射** — 将 Codex 非标准模型名（如 `codex-auto-review`）映射到上游提供商模型，支持 `modelMap` 配置或 `--model` 参数
- **推理模型** — 跨轮次保留 `reasoning_content`（DeepSeek、kimi-k2.6）
- **模型目录** — 代理上游的 `/v1/models` 端点
- **健康检查** — `GET /health` 诊断上游连接状态
- **TLS 跳过** — 支持企业代理/自签名证书场景
- **后台运行** — `--daemon` 后台运行，日志输出到配置文件同级 `logs/` 目录

## 项目架构

| 文件 | 说明 |
|------|------|
| `src/types.ts` | Responses/Chat Completions API 类型定义 |
| `src/config.ts` | 配置加载（配置文件 + 环境变量） |
| `src/session.ts` | 会话存储与推理内容缓存 |
| `src/translate.ts` | 请求/响应转换逻辑 |
| `src/stream.ts` | SSE 流式转换 |
| `src/server.ts` | HTTP 服务（Hono） |
| `src/cli.ts` | CLI 入口 |
| `build.mjs` | esbuild 打包脚本 |

## 许可证

MIT

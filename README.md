# codex-transfer

[English](./README.en.md) | **中文**

> Responses API ↔ Chat Completions 协议翻译桥接 — 让 Codex CLI 无缝对接 DeepSeek、Kimi、Qwen 等任意 OpenAI 兼容厂商。

## 概述

Codex CLI 使用 OpenAI 的 **Responses API** 作为通信协议，而市面上大多数第三方大模型厂商（DeepSeek、Moonshot、Qwen 等）仅实现了早期的 **Chat Completions API**。这两种 API 在请求格式、响应结构、流式事件序列、工具调用表达等方面存在显著差异。

`codex-transfer` 在本地启动一个 HTTP 代理服务，透明地将 Codex CLI 发出的 Responses API 请求翻译为 Chat Completions API 请求，并将上游响应逆向翻译回 Responses API 格式，使 Codex CLI"察觉不到"协议差异。

```
Codex CLI (Responses API)  →  codex-transfer (:4444)  →  第三方厂商 (Chat Completions API)
```

- **零运行时依赖**：esbuild 打包为单文件 `dist/codex-transfer.mjs`，`npx` 一键运行
- **无状态**：进程内维护会话，无需外部数据库
- **约 1500 行 TypeScript**：轻量、可审计

---

## 快速开始

```bash
# 一键运行（无需安装）
npx @classicicn/codex-transfer -k

# 指定上游厂商
npx @classicicn/codex-transfer -k -u https://api.deepseek.com/v1 --api-key sk-xxx

# 全局安装后使用
npm install -g @classicicn/codex-transfer
codex-transfer -k
```

---

## CLI 选项

```
codex-transfer [options]

选项：
  -p, --port PORT        监听端口（默认：4444）
  -u, --upstream URL     上游 Chat Completions 基础 URL
      --api-key KEY      上游 API Key
  -m, --model MODEL      强制覆盖模型名称（最高优先级）
  -c, --config PATH      配置文件路径（JSON 格式）
  -k, --insecure         跳过 TLS 证书验证（企业代理/自签证书场景）
      --no-reasoning-effort  不向上传递 reasoning_effort 参数
  -d, --daemon           后台运行，日志写入 logs/ 目录
  -h, --help             显示帮助信息
```

### 后台运行（Daemon 模式）

```bash
codex-transfer -d -k -u https://api.deepseek.com/v1 --api-key sk-xxx

# 输出：
# codex-transfer started in background (PID: 12345)
# Log file: ~/.codex-transfer/logs/codex-transfer-20260507-143022.log
# PID file: ~/.codex-transfer/logs/codex-transfer.pid
# Stop:   kill $(cat ~/.codex-transfer/logs/codex-transfer.pid)
```

Daemon 模式自动将 `console` 输出重定向到带时间戳的日志文件，单文件超过 **10MB** 自动轮转，最多保留 **5 个历史文件**。

---

## 配置

### 优先级

```
CLI 参数 > 环境变量 > 配置文件 > 默认值
```

### 配置文件

创建一个 JSON 配置文件，放置在以下任一位置（按搜索顺序）：

1. `--config` 显式路径 或 `CODEX_TRANSFER_CONFIG` 环境变量
2. `./codex-transfer.json`（当前目录）
3. `~/.codex-transfer/config.json`（用户主目录）

```json
{
  "port": 4446,
  "upstream": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-key-here",
  "insecure": false,
  "reasoningEffort": true,
  "modelMap": {
    "*": "deepseek-v4-pro",
    "codex-auto-review": "deepseek-v4-pro"
  }
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_TRANSFER_PORT` | `4444` | 监听端口 |
| `CODEX_TRANSFER_UPSTREAM` | `https://openrouter.ai/api/v1` | 上游 Chat Completions 基础 URL |
| `CODEX_TRANSFER_API_KEY` | _(空)_ | 转发给上游的 API Key |
| `CODEX_TRANSFER_CONFIG` | _(自动)_ | 配置文件路径 |
| `CODEX_TRANSFER_INSECURE` | `false` | 设为 `"1"` 或 `"true"` 跳过 TLS 验证 |
| `CODEX_TRANSFER_REASONING_EFFORT` | `true` | 设为 `"0"` 或 `"false"` 关闭 reasoning_effort 传递 |

### 模型名称映射

Codex CLI 可能发送非标准模型名（如 `codex-auto-review`），上游厂商无法识别。使用 `modelMap` 进行翻译：

```json
{
  "modelMap": {
    "*": "deepseek-v4-pro",
    "codex-auto-review": "deepseek-v4-pro"
  }
}
```

**查找顺序**：精确键匹配 → 通配符 `"*"` → 原名称透传。

`--model` / `-m` 参数优先级高于 `modelMap`，可强制覆盖所有模型名。

---

## API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| `GET` | `/health` | 健康检查 — 测试上游 `/models` 连通性，返回诊断信息 |
| `GET` | `/v1/models` | 模型列表代理 — 透明转发上游模型目录 |
| `POST` | `/v1/responses` | **核心端点** — 接收 Responses API 请求，翻译后转发上游 |

### `/v1/responses` 处理流程

```
Codex 请求到达
  → JSON 解析 & 校验
  → resolveModel() 模型名映射
  → 加载历史消息（通过 previous_response_id）
  → toChatRequest() 协议翻译
  → 分流：
     ├─ stream=true  → translateStream() SSE 生成器 → text/event-stream
     └─ stream=false → fetch 上游 → fromChatResponse() → JSON
```

---

## 功能详解

### 协议翻译

完整实现 Responses API 与 Chat Completions API 之间的双向转换：

- **请求翻译**：`input` 数组（`function_call` / `function_call_output` / 普通消息）→ Chat Completions `messages[]` 数组
- **响应翻译**：Chat Completions `choices[0].message` → Responses API `output[]` 结构
- **系统提示**：`instructions`（Codex CLI 字段）→ Chat Completions `system` 角色
- **角色映射**：`developer` → `system`

### 流式翻译（SSE）

上游 Chat Completions 的 SSE 增量流被逐 chunk 翻译为 Responses API 标准事件序列：

```
response.created
  → response.output_item.added (message)
  → response.output_text.delta × N
  → response.output_item.done
  → [如有工具调用]
     response.output_item.added (function_call)
     → response.function_call_arguments.delta
     → response.output_item.done
  → response.completed
```

**设计要点**：
- 文本 delta 实时透传，工具调用 delta 在流结束后批量封装（因 Chat Completions 的 tool call 按 index 散落在多个 chunk 中）
- 顶层异常兜底：即使上游异常断开，也会产出 `response.failed` 事件，确保 Codex CLI 不会挂起等待

### Token 用量详情

Codex CLI 依赖 Responses API 中的 usage 字段计算上下文占用率。`codex-transfer` 自动提取上游响应中的用量信息并映射到 Responses API 格式，同时兼容 OpenAI 和 DeepSeek 两种上游格式差异：

| Responses API 输出 | OpenAI 上游字段 | DeepSeek 上游字段 |
|---|---|---|
| `input_tokens` | `prompt_tokens` | `prompt_tokens` |
| `output_tokens` | `completion_tokens` | `completion_tokens` |
| `total_tokens` | `total_tokens` | `total_tokens` |
| `input_tokens_details.cached_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` |
| `output_tokens_details.reasoning_tokens` | `completion_tokens_details.reasoning_tokens` | `completion_tokens_details.reasoning_tokens` |

**自动格式检测**：根据上游响应中实际存在的字段自动判断格式，无需配置。`cached_tokens` 优先取 OpenAI 嵌套字段，无则取 DeepSeek 顶层字段；`reasoning_tokens` 两者路径一致直接取值。字段不存在时不会输出对应的 `details` 对象。

非流式和流式路径共享同一套映射逻辑。

### 推理强度映射（Reasoning Effort）

Codex CLI 通过 `reasoning.effort` 控制模型推理强度（极低/低/中/高/超高），但各厂商的实现方式不同。`codex-transfer` 自动将 Responses API 的推理强度映射为各厂商可识别的参数：

| Codex 等级 | Responses API 值 | DeepSeek | MiMo / Kimi / GLM |
|---|---|---|---|
| 极低 | `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` |
| 低 | `low` | `thinking: {type: "enabled"}, reasoning_effort: "high"` | `thinking: {type: "enabled"}` |
| 中 | `medium` | `thinking: {type: "enabled"}, reasoning_effort: "high"` | `thinking: {type: "enabled"}` |
| 高 | `high` | `thinking: {type: "enabled"}, reasoning_effort: "high"` | `thinking: {type: "enabled"}` |
| 超高 | `xhigh` | `thinking: {type: "enabled"}, reasoning_effort: "max"` | `thinking: {type: "enabled"}` |

**兼容策略**：`thinking` 参数始终发送（所有厂商支持）。`reasoning_effort` 默认发送（DeepSeek 原生支持）；如果上游不支持该字段，可通过 `--no-reasoning-effort` CLI 参数或配置文件 `"reasoningEffort": false` 关闭。

### 会话管理

Codex CLI 通过 `previous_response_id` 实现多轮对话。`SessionStore` 在内存中维护每个会话的完整消息历史，使得每次 Chat Completions 调用都是**自包含**的（无需依赖上游的上下文缓存）。

```
┌─────────────────────────────────┐
│  SessionStore (内存)             │
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

### 推理模型支持（DeepSeek-R1 / Kimi-K2.6）

推理模型会产出 `reasoning_content`（思考过程），该字段需要在多轮对话中**原样回传**，否则模型会拒绝或行为异常。

`codex-transfer` 使用**双索引缓存**来恢复推理内容：

| 索引方式 | 适用场景 | 实现 |
|----------|---------|------|
| **call_id 精确匹配** | Codex 使用 `previous_response_id` + tool call 重放 | `Map<call_id, reasoning>` |
| **内容 SHA256 指纹** | Codex 完整重放 `input[]` 而不使用 `previous_response_id` | `Map<SHA256(content), reasoning>` |

两种机制互为补充，覆盖 Codex CLI 的两种对话重放模式。

### 工具调用处理

- **工具过滤**：自动过滤 `web_search`、`file_search`、`computer` 等 OpenAI 专有内置工具，仅保留 `type: "function"` 的自定义工具，避免第三方厂商拒绝请求
- **格式转换**：Responses API 扁平格式 `{type, name, description, parameters}` ↔ Chat Completions 嵌套格式 `{type, function: {name, description, parameters}}`
- **并行工具调用**：连续多个 `function_call` 输入项合并为一条 assistant 消息中的多个 `tool_calls` 条目
- **消息重排序**：Codex 可能在 `function_call` 和 `function_call_output` 之间插入其他消息，但 DeepSeek 等厂商严格要求 `assistant(tool_calls)` 后紧跟匹配的 `tool` 消息。`reorderForToolCalls()` 自动重排，孤立的 tool call 自动合成空输出

### 健康检查

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

## 支持的厂商

任意实现 OpenAI Chat Completions API 格式的厂商均可使用。

| 厂商 | 基础 URL |
|------|----------|
| DeepSeek | `https://api.deepseek.com/v1` |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| Qwen (通义千问) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

> 任何 OpenAI API 兼容的厂商理论上均可正常工作。如果发现未列出的可用厂商，欢迎提交 PR。

---

## Codex CLI 配置

在 `~/.codex/config.toml` 中添加：

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek-transfer"

[model_providers.deepseek-transfer]
name = "DeepSeek"
base_url = "http://127.0.0.1:4446/v1"
wire_api = "responses"
```

> **注意**：`base_url` 端口需与 `codex-transfer` 监听端口一致，`wire_api` 必须为 `"responses"`。

---

## 项目结构

```
src/
├── cli.ts         CLI 入口 — 参数解析、daemon 进程管理、日志轮转
├── server.ts      HTTP 服务 — Hono 路由注册、请求调度、创建代理实例
├── config.ts      配置管理 — 多来源合并、优先级控制、配置文件搜索
├── session.ts     会话状态 — 消息历史存储、推理内容双索引缓存
├── translate.ts   协议翻译 — Responses ↔ Chat Completions 双向转换
├── stream.ts      SSE 翻译 — 流式 chunk 解析、事件序列生成、错误兜底
└── types.ts       类型定义 — 两套 API 的完整 TypeScript 类型
build.mjs          构建脚本 — esbuild 打包为单文件
```

### 依赖关系

```
cli.ts → server.ts → translate.ts + stream.ts → session.ts + types.ts
                  → config.ts
```

### 数据流

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

## 构建

```bash
git clone https://github.com/Icicno/codex-transfer.git
cd codex-transfer
npm install
npm run build        # esbuild 打包 + tsc 类型检查
node dist/codex-transfer.mjs -k

# 或链接为全局命令
npm link
codex-transfer -k
```

---

## 程序化使用

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

## 更新日志

### v0.3.0 (2026-05-08)

- **Token 用量**：从上游流式响应中提取 usage，Codex 可正确显示上下文占用率（修复 0% 问题）
- **用量详情**：自动映射 `cached_tokens` 和 `reasoning_tokens`，兼容 OpenAI 和 DeepSeek 两种上游格式
- **推理强度**：映射 `reasoning.effort` 到 DeepSeek `thinking`/`reasoning_effort`、MiMo/Kimi/GLM `thinking` 开关
- **配置化控制**：新增 `--no-reasoning-effort` / `reasoningEffort` 配置项，按需剥离推理强度参数

### v0.2.0 (2026-05-07)

- 首次 npm 发布
- Responses API ↔ Chat Completions 双向协议翻译
- 流式 SSE 事件序列生成、会话管理、推理模型支持
- 模型名称映射、Daemon 模式、日志轮转
- TLS 证书跳过、配置文件支持

---

## License

MIT

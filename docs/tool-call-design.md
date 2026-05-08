# 工具调用增强设计方案

> 状态：设计阶段  
> 日期：2026-05-09  
> 涉及功能：非流式 tool_calls 支持、arguments 流式增量、MCP Client 代理实现

---

## 目录

1. [背景与现状](#1-背景与现状)
2. [功能一：非流式 tool_calls 支持](#2-功能一非流式-tool_calls-支持)
3. [功能二：arguments 流式增量](#3-功能二arguments-流式增量)
4. [功能三：MCP Client 代理实现](#4-功能三mcp-client-代理实现)
5. [实施计划与优先级](#5-实施计划与优先级)

---

## 1. 背景与现状

### 1.1 当前可转换能力

| 能力 | 流式 | 非流式 | 说明 |
|------|:----:|:------:|------|
| 文本对话 | ✅ | ✅ | |
| 自定义函数调用 | ✅ | ❌ | 非流式路径完全忽略 tool_calls |
| arguments 增量推送 | ❌ | — | 流式路径累积后一次性发送 |
| MCP 工具 | ❌ | ❌ | type: "mcp" 工具被直接过滤 |
| 推理强度映射 | ✅ | ✅ | |
| Token usage 映射 | ✅ | ✅ | |

### 1.2 关键代码路径

| 路径 | 文件:行号 | 现状 |
|------|-----------|------|
| 工具过滤 | `translate.ts:118-120` | 仅保留 `type: "function"`，过滤 MCP 等 |
| 扁平↔嵌套转换 | `translate.ts:203-218` | `convertTool()` 格式互转 |
| 非流式响应 | `translate.ts:239-245` | `fromChatResponse()` **只提取文本，忽略 tool_calls** |
| 流式 delta 累积 | `stream.ts:214-228` | 按 index 累积到 Map，**流结束后一次性发送** |
| 流式 tool_call 输出 | `stream.ts:266-318` | `response.output_item.added` + delta + done 一次性发出 |
| 流式 response.completed | `stream.ts:352-363` | output 包含 function_call items |

### 1.3 Responses API 工具输出格式参考

**function_call 输出项**（非流式响应中）：

```json
{
  "type": "function_call",
  "id": "fc_abc123",
  "call_id": "call_xyz789",
  "name": "get_weather",
  "arguments": "{\"location\":\"SF\"}",
  "status": "completed"
}
```

**function_call 流式事件序列**：

```
response.output_item.added     → { type: "function_call", id, call_id, name, arguments: "", status: "in_progress" }
response.function_call_arguments.delta → { item_id, delta: "{\"loc" }
response.function_call_arguments.delta → { item_id, delta: "ation\":\"SF\"}" }
response.output_item.done      → { type: "function_call", id, call_id, name, arguments: "{\"location\":\"SF\"}", status: "completed" }
```

**mcp_call 输出项**（MCP 工具执行结果）：

```json
{
  "type": "mcp_call",
  "id": "mcp_abc123",
  "name": "search_docs",
  "server_label": "filesystem",
  "arguments": "{\"query\":\"test\"}",
  "output": "found 3 results...",
  "error": null
}
```

---

## 2. 功能一：非流式 tool_calls 支持

### 2.1 问题描述

`translate.ts:fromChatResponse()` 当前实现：

```typescript
const text = choice.message.content ?? "";
const output: ResponsesOutputItem[] = [
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  },
];
```

**完全忽略了 `choice.message.tool_calls`**。当 DeepSeek 等模型通过非流式路径返回函数调用时，Codex CLI 无法获取工具调用信息。

### 2.2 类型定义修改

**`src/types.ts`**：扩展 `ResponsesOutputItem` 以支持 function_call 类型。

```typescript
// 现有：仅支持 message 类型
export interface ResponsesOutputItem {
  type: string;
  role: string;
  content: ContentPart[];
}

// 改为：联合类型
export type ResponsesOutputItem = ResponsesMessageOutput | ResponsesFunctionCallOutput;

export interface ResponsesMessageOutput {
  type: "message";
  role: string;
  content: ContentPart[];
  status?: string;
}

export interface ResponsesFunctionCallOutput {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress";
}
```

### 2.3 `fromChatResponse()` 改造

```typescript
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

  const output: ResponsesOutputItem[] = [];

  // 1. 文本内容（如果有）
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
      status: "completed",
    });
  }

  // 2. 工具调用（如果有）
  for (const tc of choice.message.tool_calls ?? []) {
    const tcRecord = tc as Record<string, unknown>;
    const func = tcRecord.function as Record<string, unknown> | undefined;
    output.push({
      type: "function_call",
      id: `fc_${randomUUID().replace(/-/g, "")}`,
      call_id: (tcRecord.id as string) ?? "",
      name: (func?.name as string) ?? "",
      arguments: (func?.arguments as string) ?? "{}",
      status: "completed",
    });
  }

  // 3. 兜底：如果既无文本也无工具调用，添加空 message
  if (output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
      status: "completed",
    });
  }

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
```

### 2.4 Session 存储

非流式路径的 session 存储逻辑（`server.ts:191-192`）已包含完整的 `assistantMsg`（含 `tool_calls`），无需额外改动。

`server.ts` 中需确保 `assistantMsg` 包含 tool_calls 信息：

```typescript
// server.ts:186-189 现有代码
const assistantMsg = chatResp.choices?.[0]?.message ?? {
  role: "assistant",
  content: "",
};
// assistantMsg 已包含 tool_calls（如果上游返回了的话）
const fullHistory = [...chatReq.messages, assistantMsg];
const responseId = sessions.save(fullHistory);
```

✅ 无需改动，已有 tool_calls 会被正确保存。

### 2.5 `ResponsesResponse` 类型调整

当前 `ResponsesResponse.output` 类型为 `ResponsesOutputItem[]`，改为联合类型后需要同步更新。由于 `output` 字段类型本身就是 `ResponsesOutputItem[]`，而我们将 `ResponsesOutputItem` 改为了联合类型，所以 **`ResponsesResponse` 本身无需改动**。

### 2.6 影响评估

| 维度 | 评估 |
|------|------|
| 风险 | 🟢 低 — 纯增量改动，不影响现有文本对话路径 |
| 工作量 | 小 — 约 50 行改动 |
| 测试要点 | DeepSeek 非流式函数调用、纯文本对话、混合文本+工具调用 |

---

## 3. 功能二：arguments 流式增量

### 3.1 问题描述

当前 `stream.ts` 的工具调用处理分两个阶段：

1. **流式读取阶段**（第 214-228 行）：累积 delta 到 `toolCalls: Map<number, ToolCallAccum>`
2. **流结束后**（第 265-318 行）：一次性发送 `response.output_item.added` → `response.function_call_arguments.delta` → `response.output_item.done`

```
现状：
  上游 delta → 累积到 Map → [流结束] → 一次性 emit added + delta + done
```

**问题**：Codex CLI 在整个流式过程中看不到任何函数调用进度，只能在流结束时一次性收到所有信息。对于大参数的函数调用，这意味着长时间的等待。

### 3.2 目标数据流

```
目标：
  上游 delta → 实时 emit added(首次) + delta(每次) → [流结束] → emit done
```

```
response.created
response.output_text.delta*  (文本部分)
response.output_item.done    (文本部分完成)

→ 第一个 tool_call delta 到达：
  response.output_item.added   (function_call, status: "in_progress")
  response.function_call_arguments.delta (第一个片段)

→ 后续 tool_call delta：
  response.function_call_arguments.delta (增量片段)

→ 流结束：
  response.output_item.done    (function_call, status: "completed")

response.completed
```

### 3.3 状态机设计

每个 tool_call index 维护独立的状态机：

```
         ┌────────────────────────────┐
         │                            │
         ▼                            │
      ┌──────┐   首次 delta    ┌──────────────┐
      │ IDLE │ ───────────────> │  EMITTING    │
      └──────┘  emit added     │              │
                   + delta     │  emit delta  │──> 后续 delta
                               └──────┬───────┘
                                      │ 流结束
                                      ▼
                                ┌──────────┐
                                │   DONE   │
                                │emit done │
                                └──────────┘
```

### 3.4 `ToolCallAccum` 扩展

```typescript
interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
  // 新增：流式增量状态
  fcItemId: string;       // 预分配的 function_call item ID
  emittedAdded: boolean;  // 是否已 emit response.output_item.added
}
```

### 3.5 核心改动：stream.ts delta 处理

**原代码**（第 214-228 行）：

```typescript
// Tool call deltas — accumulate by index
const deltaCalls = choice.delta?.tool_calls;
if (deltaCalls) {
  for (const dc of deltaCalls) {
    let entry = toolCalls.get(dc.index);
    if (!entry) {
      entry = { id: "", name: "", arguments: "" };
      toolCalls.set(dc.index, entry);
    }
    if (dc.id) entry.id = dc.id;
    if (dc.function?.name) entry.name += dc.function.name;
    if (dc.function?.arguments)
      entry.arguments += dc.function.arguments;
  }
}
```

**改造后**：

```typescript
// Tool call deltas — accumulate and emit incrementally
const deltaCalls = choice.delta?.tool_calls;
if (deltaCalls) {
  for (const dc of deltaCalls) {
    let entry = toolCalls.get(dc.index);
    const isNew = !entry;

    if (isNew) {
      entry = {
        id: "",
        name: "",
        arguments: "",
        fcItemId: `fc_${randomUUID().replace(/-/g, "")}`,
        emittedAdded: false,
      };
      toolCalls.set(dc.index, entry);
    }

    // 累积
    if (dc.id) entry.id = dc.id;
    if (dc.function?.name) entry.name += dc.function.name;

    // 首次：有了 id 和 name 后 emit response.output_item.added
    if (!entry.emittedAdded && entry.id && entry.name) {
      const outputIndex = (emittedMessageItem ? 1 : 0) + dc.index;
      yield formatSSE("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: entry.fcItemId,
          call_id: entry.id,
          name: entry.name,
          arguments: "",
          status: "in_progress",
        },
      });
      entry.emittedAdded = true;
    }

    // 实时 emit arguments delta
    if (dc.function?.arguments) {
      entry.arguments += dc.function.arguments;
      if (entry.emittedAdded) {
        const outputIndex = (emittedMessageItem ? 1 : 0) + dc.index;
        yield formatSSE("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: entry.fcItemId,
          output_index: outputIndex,
          delta: dc.function.arguments,
        });
      }
    }
  }
}
```

### 3.6 核心改动：stream.ts 流结束处理

**原代码**（第 265-318 行）：一次性发送 added + delta + done。

**改造后**：只发送 `response.output_item.done`（added 和 delta 已在流中发出）。

```typescript
// Emit response.output_item.done for each accumulated tool call
const baseIndex = emittedMessageItem ? 1 : 0;
const fcItems: Record<string, unknown>[] = [];

let relIdx = 0;
for (const [, tc] of toolCalls) {
  const outputIndex = baseIndex + relIdx;

  // 如果 tool_call 没有收到任何有效 delta（极少见），补发 added
  if (!tc.emittedAdded && tc.id && tc.name) {
    yield formatSSE("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: tc.fcItemId,
        call_id: tc.id,
        name: tc.name,
        arguments: "",
        status: "in_progress",
      },
    });
    tc.emittedAdded = true;
  }

  // Emit done（仅对已 emitted 的 tool_call）
  if (tc.emittedAdded) {
    yield formatSSE("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: tc.fcItemId,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed",
      },
    });
  }

  // 为 response.completed 和 session 准备数据
  fcItems.push({
    type: "function_call",
    id: tc.fcItemId,
    call_id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
    status: "completed",
  });

  relIdx++;
}
```

### 3.7 边界情况

| 场景 | 处理方式 |
|------|----------|
| tool_call delta 中缺少 `id` 和 `name` | 不 emit added，等待后续 delta 补充 |
| 上游只有一个 tool_call 且 arguments 一次性到达 | 首次 delta 同时 emit added + delta，流结束后 emit done |
| 并行 tool_calls（多个 index） | 每个 index 独立状态机，互不干扰 |
| 流中途断开 | 顶层 catch 已有兜底（`sseFailed`），不会丢失事件 |

### 3.8 影响评估

| 维度 | 评估 |
|------|------|
| 风险 | 🟡 中 — 改变了事件发送时序，需测试 Codex CLI 兼容性 |
| 工作量 | 中 — 约 60 行改动 |
| 兼容性 | 最终输出结果与现有实现完全一致，仅事件时序不同 |
| 测试要点 | 大参数函数调用、并行工具调用、流中断恢复 |

---

## 4. 功能三：MCP Client 代理实现

### 4.1 问题描述

Responses API 支持 `type: "mcp"` 工具，由服务端（OpenAI）内置 MCP 客户端连接 MCP 服务器、发现工具、执行调用。Codex CLI 发送 MCP 工具定义后期望服务端处理一切。

当前 codex-transfer 直接过滤掉所有非 `type: "function"` 的工具（`translate.ts:118-120`），导致 MCP 工具完全不可用。

### 4.2 架构设计

```
Codex CLI
  │
  │  Responses API (type: "mcp" tools)
  ▼
┌─────────────────────────────────────────────────────┐
│                  codex-transfer                      │
│                                                      │
│  1. 拦截 mcp tools                                    │
│  2. 连接 MCP 服务器，获取 tools/list                    │
│  3. 将 MCP 工具转为 function 定义 → 注入上游请求         │
│  4. Agentic Loop:                                     │
│     ├─ LLM 返回 MCP tool_call → 执行 → 结果回 LLM     │
│     ├─ LLM 返回普通 tool_call → 交给 Codex             │
│     └─ LLM 返回纯文本 → 结束                           │
│                                                      │
└──────────┬──────────────────────┬────────────────────┘
           │                      │
           ▼                      ▼
      LLM Provider           MCP Server A (stdio)
      (Chat Completions)     MCP Server B (HTTP)
                              MCP Server C (stdio)
```

### 4.3 MCP 协议概述

MCP (Model Context Protocol) 使用 **JSON-RPC 2.0** 消息格式，支持两种传输方式：

| 传输 | 连接方式 | 适用场景 |
|------|----------|----------|
| **stdio** | Client spawn Server 子进程，通过 stdin/stdout 通信 | 本地工具（文件系统、Git、数据库 CLI） |
| **Streamable HTTP** | 单一 HTTP 端点，POST 发送请求，响应为 JSON 或 SSE | 远程工具（SaaS API、云服务） |

**核心流程**：

```
1. Client → Server: initialize (协议版本、能力声明)
2. Server → Client: InitializeResult (capabilities、serverInfo)
3. Client → Server: notifications/initialized
4. Client → Server: tools/list → 工具定义列表
5. Client → Server: tools/call { name, arguments } → { content, isError }
6. 任一方关闭连接
```

**工具定义格式**：

```json
{
  "name": "get_weather",
  "description": "Get current weather information",
  "inputSchema": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    },
    "required": ["location"]
  }
}
```

**工具调用结果格式**：

```json
{
  "content": [{ "type": "text", "text": "Temperature: 72°F" }],
  "isError": false
}
```

### 4.4 配置格式

在 `codex-transfer.json` 中新增 `mcpServers` 字段，复用标准 MCP 配置格式：

```json
{
  "upstream": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "HOME": "/Users/me" }
    },
    "remote-tools": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

| 配置字段 | 传输类型 | 说明 |
|----------|----------|------|
| `command` + `args` | stdio | spawn 子进程，`command` 为可执行文件，`args` 为参数 |
| `url` | Streamable HTTP | 远程 MCP 服务器 URL |
| `env` | stdio | 注入子进程的环境变量（可选） |

### 4.5 新增文件结构

```
src/
├── mcp/
│   ├── client.ts     # MCP 客户端（JSON-RPC 通信，stdio + HTTP 传输）
│   ├── manager.ts    # MCP 连接管理器（生命周期、工具缓存、连接池）
│   └── types.ts      # MCP 协议类型定义
├── translate.ts      # 修改：MCP 工具注入逻辑
├── server.ts         # 修改：Agentic loop 集成
└── config.ts         # 修改：新增 mcpServers 配置
```

### 4.6 核心模块设计

#### 4.6.1 `src/mcp/types.ts` — MCP 协议类型

```typescript
// JSON-RPC 2.0 基础类型
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// MCP Server 配置
export interface McpServerConfig {
  /** stdio 模式：可执行命令 */
  command?: string;
  /** stdio 模式：命令参数 */
  args?: string[];
  /** stdio 模式：注入子进程的环境变量 */
  env?: Record<string, string>;
  /** HTTP 模式：远程 MCP 服务器 URL */
  url?: string;
}

// MCP 工具定义（来自 tools/list）
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// MCP 工具调用结果（来自 tools/call）
export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpContentBlock {
  type: "text" | "image" | "audio" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

// MCP Initialize 结果
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
  instructions?: string;
}
```

#### 4.6.2 `src/mcp/client.ts` — MCP 客户端

```typescript
import { spawn, type ChildProcess } from "node:child_process";

export class McpClient {
  private config: McpServerConfig;
  private serverLabel: string;
  private requestId = 0;
  private sessionId?: string;
  // stdio 模式
  private process?: ChildProcess;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();

  constructor(serverLabel: string, config: McpServerConfig) {
    this.serverLabel = serverLabel;
    this.config = config;
  }

  /** 连接到 MCP 服务器并完成初始化握手 */
  async connect(): Promise<McpInitializeResult> {
    if (this.config.command) {
      return this.connectStdio();
    } else if (this.config.url) {
      return this.connectHttp();
    }
    throw new Error(`MCP server "${this.serverLabel}": no command or url configured`);
  }

  /** 获取工具列表（含分页） */
  async listTools(): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.sendRequest("tools/list", { cursor }) as {
        tools: McpTool[];
        nextCursor?: string;
      };
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return allTools;
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.sendRequest("tools/call", {
      name,
      arguments: args,
    }) as Promise<McpToolResult>;
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
  }

  // ── 私有方法 ──────────────────────────────────────────────

  private async connectStdio(): Promise<McpInitializeResult> {
    // spawn 子进程，设置 stdin/stdout 管道
    // 通过 stdout 读取 JSON-RPC 响应
    // 发送 initialize 请求 + initialized 通知
    // ... (实现细节省略)
  }

  private async connectHttp(): Promise<McpInitializeResult> {
    // POST initialize 请求到 url
    // 处理 JSON 或 SSE 响应
    // 保存 sessionId（如有）
    // 发送 initialized 通知
    // ... (实现细节省略)
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params && { params }) };

    if (this.config.command) {
      return this.sendStdioRequest(id, body);
    } else {
      return this.sendHttpRequest(id, body);
    }
  }
}
```

**stdio 传输实现要点**：

- `spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] })`
- 通过 `process.stdin.write(JSON.stringify(body) + "\n")` 发送请求
- 通过 `process.stdout` 逐行读取 JSON-RPC 响应
- 使用 `pendingRequests` Map 将响应路由到对应的 Promise

**HTTP 传输实现要点**：

- `POST` 到 `config.url`，Header 包含 `Content-Type: application/json`、`Accept: application/json, text/event-stream`、`MCP-Protocol-Version: 2025-11-25`
- 如果响应是 `application/json` → 直接解析
- 如果响应是 `text/event-stream` → 解析 SSE 流获取最终 JSON-RPC 响应

#### 4.6.3 `src/mcp/manager.ts` — 连接管理器

```typescript
export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolCache = new Map<string, McpTool[]>();
  private configs: Record<string, McpServerConfig>;

  constructor(configs: Record<string, McpServerConfig>) {
    this.configs = configs;
  }

  /**
   * 启动时：延迟连接所有配置的 MCP 服务器。
   * 首次请求时触发，不阻塞服务启动。
   */
  async ensureConnected(): Promise<void> {
    for (const [label, config] of Object.entries(this.configs)) {
      if (!this.clients.has(label)) {
        try {
          const client = new McpClient(label, config);
          await client.connect();
          const tools = await client.listTools();
          this.clients.set(label, client);
          this.toolCache.set(label, tools);
          console.log(`[mcp] connected to "${label}": ${tools.length} tools`);
        } catch (e) {
          console.error(`[mcp] failed to connect to "${label}":`, e);
        }
      }
    }
  }

  /**
   * 将所有 MCP 工具转换为 Responses API function 定义。
   * 工具名称加前缀以标识来源：__mcp_{server_label}_{tool_name}
   */
  getFunctionTools(): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [];
    for (const [label, mcpTools] of this.toolCache) {
      for (const tool of mcpTools) {
        tools.push({
          type: "function",
          name: `__mcp_${label}_${tool.name}`,
          description: tool.description ?? "",
          parameters: tool.inputSchema,
        });
      }
    }
    return tools;
  }

  /**
   * 识别工具名称是否为 MCP 工具，并解析出 server_label 和原始 tool_name。
   */
  parseMcpToolName(name: string): { serverLabel: string; toolName: string } | null {
    const prefix = "__mcp_";
    if (!name.startsWith(prefix)) return null;
    const rest = name.slice(prefix.length);
    const sepIdx = rest.indexOf("_");
    if (sepIdx < 0) return null;
    return {
      serverLabel: rest.slice(0, sepIdx),
      toolName: rest.slice(sepIdx + 1),
    };
  }

  /** 调用 MCP 工具 */
  async callTool(
    serverLabel: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const client = this.clients.get(serverLabel);
    if (!client) throw new Error(`MCP server "${serverLabel}" not connected`);
    return client.callTool(toolName, args);
  }

  /** 关闭所有连接 */
  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
    this.toolCache.clear();
  }

  /** 是否有配置的 MCP 服务器 */
  hasServers(): boolean {
    return Object.keys(this.configs).length > 0;
  }
}
```

### 4.7 请求处理流程

#### 4.7.1 工具注入（translate.ts 修改）

在 `toChatRequest()` 中，**不过滤** MCP 工具，而是分离处理：

```typescript
// translate.ts — toChatRequest() 修改

// 原代码（第 118-120 行）：
// const filteredTools = (req.tools ?? [])
//   .filter((t) => t.type === "function")
//   .map(convertTool);

// 新代码：
const mcpTools: Record<string, unknown>[] = [];
const filteredTools: Record<string, unknown>[] = [];

for (const tool of req.tools ?? []) {
  if (tool.type === "function") {
    filteredTools.push(convertTool(tool));
  }
  // mcp tools 由 server.ts 的 agentic loop 处理，不在此过滤
}
```

实际上 `translate.ts` 本身不需要改动 MCP 逻辑。MCP 工具的注入在 `server.ts` 层面处理：

```typescript
// server.ts — 请求处理流程修改

// 1. 分离 mcp tools
const mcpToolDefs = (req.tools ?? []).filter((t) => t.type === "mcp");

// 2. 如果有 MCP 工具，连接并获取函数定义
let mcpFunctionTools: Record<string, unknown>[] = [];
if (mcpToolDefs.length > 0 && mcpManager?.hasServers()) {
  await mcpManager.ensureConnected();
  mcpFunctionTools = mcpManager.getFunctionTools();
}

// 3. 正常翻译（此时 req.tools 中的 mcp 已被过滤）
const chatReq = toChatRequest(req, history, sessions);

// 4. 将 MCP 函数工具注入
if (mcpFunctionTools.length > 0) {
  chatReq.tools = [...(chatReq.tools ?? []), ...mcpFunctionTools];
}
```

#### 4.7.2 Agentic Loop（server.ts 新增）

```typescript
// server.ts — 非流式 Agentic Loop

interface AgenticLoopResult {
  /** 最终的 ChatResponse（可能是多次调用的最后一次结果） */
  finalResponse: ChatResponse;
  /** 所有 MCP 工具调用记录（用于生成 mcp_call 输出项） */
  mcpCallRecords: McpCallRecord[];
  /** 是否需要 Codex 继续执行普通工具 */
  hasPendingToolCalls: boolean;
  /** 待 Codex 执行的普通 tool_calls */
  pendingToolCalls?: Record<string, unknown>[];
}

interface McpCallRecord {
  name: string;
  serverLabel: string;
  arguments: string;
  output: string;
  error: string | null;
}

async function agenticLoop(
  url: string,
  apiKey: string,
  chatReq: ChatRequest,
  mcpManager: McpManager,
  maxIterations = 10
): Promise<AgenticLoopResult> {
  const mcpCallRecords: McpCallRecord[] = [];
  let currentReq = { ...chatReq };
  let lastResponse: ChatResponse;

  for (let i = 0; i < maxIterations; i++) {
    // 1. 调用 LLM
    lastResponse = await callUpstream(url, apiKey, currentReq);

    const choice = lastResponse.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;

    // 2. 无 tool_calls → 结束
    if (!toolCalls || toolCalls.length === 0) {
      return {
        finalResponse: lastResponse,
        mcpCallRecords,
        hasPendingToolCalls: false,
      };
    }

    // 3. 分类 tool_calls：MCP vs 普通
    const mcpCalls: { tc: Record<string, unknown>; parsed: { serverLabel: string; toolName: string } }[] = [];
    const normalCalls: Record<string, unknown>[] = [];

    for (const tc of toolCalls) {
      const tcRecord = tc as Record<string, unknown>;
      const func = tcRecord.function as Record<string, unknown>;
      const parsed = mcpManager.parseMcpToolName(func.name as string);
      if (parsed) {
        mcpCalls.push({ tc: tcRecord, parsed });
      } else {
        normalCalls.push(tcRecord);
      }
    }

    // 4. 有普通工具调用 → 退出 loop，交给 Codex 执行
    if (normalCalls.length > 0) {
      // 如果同时有 MCP 调用，先执行它们
      if (mcpCalls.length > 0) {
        await executeMcpCalls(mcpCalls, mcpCallRecords, mcpManager, currentReq);
        // 注意：此时混合了 MCP 结果和普通 tool_calls，需要特殊处理
        // 简化方案：先执行 MCP，再发一次 LLM 调用
        // 复杂方案：将 MCP 结果和普通 tool_calls 一起返回
        // 采用简化方案：只执行 MCP，循环回 LLM
        continue;
      }

      return {
        finalResponse: lastResponse,
        mcpCallRecords,
        hasPendingToolCalls: true,
        pendingToolCalls: normalCalls,
      };
    }

    // 5. 只有 MCP 调用 → 执行并循环
    await executeMcpCalls(mcpCalls, mcpCallRecords, mcpManager, currentReq);
  }

  // 达到最大循环次数
  return {
    finalResponse: lastResponse!,
    mcpCallRecords,
    hasPendingToolCalls: false,
  };
}

async function executeMcpCalls(
  mcpCalls: { tc: Record<string, unknown>; parsed: { serverLabel: string; toolName: string } }[],
  records: McpCallRecord[],
  mcpManager: McpManager,
  currentReq: ChatRequest
): Promise<void> {
  // 将 assistant message 加入 messages
  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: mcpCalls.map(({ tc }) => tc),
  };
  currentReq.messages.push(assistantMsg);

  // 执行每个 MCP 调用，将结果作为 tool message 加入
  for (const { tc, parsed } of mcpCalls) {
    const func = tc.function as Record<string, unknown>;
    const args = JSON.parse((func.arguments as string) ?? "{}");
    const callId = tc.id as string;

    let output: string;
    let error: string | null = null;

    try {
      const result = await mcpManager.callTool(parsed.serverLabel, parsed.toolName, args);
      output = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (result.isError) error = output;
    } catch (e) {
      output = e instanceof Error ? e.message : String(e);
      error = output;
    }

    records.push({
      name: parsed.toolName,
      serverLabel: parsed.serverLabel,
      arguments: func.arguments as string,
      output,
      error,
    });

    currentReq.messages.push({
      role: "tool",
      content: output,
      tool_call_id: callId,
    });
  }
}
```

#### 4.7.3 响应构建

Agentic loop 完成后，构建 Responses API 响应：

```typescript
// 构建最终响应
const output: ResponsesOutputItem[] = [];

// 1. MCP 调用记录 → mcp_call 输出项
for (const record of mcpCallRecords) {
  output.push({
    type: "mcp_call",
    id: `mcp_${randomUUID().replace(/-/g, "")}`,
    name: record.name,
    server_label: record.serverLabel,
    arguments: record.arguments,
    output: record.output,
    error: record.error,
  });
}

// 2. 最终 LLM 响应
if (result.hasPendingToolCalls) {
  // 有普通工具调用 → function_call 输出项
  for (const tc of result.pendingToolCalls!) {
    const func = tc.function as Record<string, unknown>;
    output.push({
      type: "function_call",
      id: `fc_${randomUUID().replace(/-/g, "")}`,
      call_id: tc.id as string,
      name: func.name as string,
      arguments: func.arguments as string,
      status: "completed",
    });
  }
} else {
  // 纯文本响应
  const text = result.finalResponse.choices?.[0]?.message?.content ?? "";
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
}
```

### 4.8 流式路径的 MCP 处理

流式路径的 MCP 处理更复杂，因为需要：

1. 先完整接收 LLM 的流式响应
2. 判断是否包含 MCP 工具调用
3. 如果有，执行 MCP 调用后重新发起流式请求

**推荐方案**：流式路径内部使用非流式调用执行 MCP loop，最终结果以流式方式推送给 Codex CLI。

```
Codex CLI ← SSE stream ← codex-transfer
                           │
                           ├─ response.created
                           ├─ [内部非流式 MCP loop]
                           ├─ mcp_list_tools output item
                           ├─ mcp_call output items
                           ├─ response.output_text.delta* (最终文本)
                           └─ response.completed
```

对于同时包含 MCP 工具和普通工具的场景，需要更复杂的处理（可能需要暂停流式推送，等待 Codex 执行完普通工具后继续）。建议 v1 版本仅支持 **纯 MCP 工具** 或 **纯普通工具** 的场景，混合场景作为后续迭代。

### 4.9 类型扩展

**`src/types.ts`** 新增 MCP 相关输出项类型：

```typescript
export interface ResponsesMcpListToolsOutput {
  type: "mcp_list_tools";
  id: string;
  server_label: string;
  tools: {
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }[];
}

export interface ResponsesMcpCallOutput {
  type: "mcp_call";
  id: string;
  name: string;
  server_label: string;
  arguments: string;
  output: string;
  error: string | null;
}
```

**`src/config.ts`** 新增 MCP 配置：

```typescript
export interface Config {
  // ... existing fields
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
}
```

### 4.10 依赖引入

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x"
  }
}
```

**替代方案**：手写 JSON-RPC + stdio 管理（约 200 行），避免引入外部依赖。

**建议**：先手写实现（仅支持 HTTP Streamable），验证可行性后再考虑引入 SDK（如需支持 stdio）。

| 方案 | 优点 | 缺点 |
|------|------|------|
| 手写 HTTP JSON-RPC | 零依赖、可控 | 需自行处理 SSE 解析、session 管理 |
| 手写 HTTP + stdio | 零依赖、支持本地工具 | stdio 消息分帧较复杂 |
| 引用 `@modelcontextprotocol/sdk` | 功能完整、维护好 | 增大 bundle 体积、可能有 native 依赖 |

**推荐**：手写 HTTP JSON-RPC 作为 v1，后续按需增加 stdio 支持。

### 4.11 生命周期管理

```
codex-transfer 启动
  ├─ 读取 mcpServers 配置
  └─ 不立即连接（延迟初始化）

首次请求到达
  ├─ 检查 mcpManager 是否已初始化
  ├─ 连接所有 MCP 服务器
  ├─ 获取 tools/list 并缓存
  └─ 继续请求处理

后续请求
  ├─ 使用缓存的工具列表
  ├─ 如果连接断开 → 自动重连
  └─ 请求处理

codex-transfer 关闭
  ├─ 关闭所有 MCP 连接
  └─ stdio 模式：kill 子进程
```

### 4.12 影响评估

| 维度 | 评估 |
|------|------|
| 复杂度 | 🔴 高 — agentic loop + MCP 客户端 + 进程管理 |
| 工作量 | 大 — 约 500+ 行新代码 |
| 依赖 | 🟡 如手写则无新依赖；如用 SDK 则需引入 |
| 兼容性 | 🟡 stdio 模式在容器/沙箱环境下可能受限 |
| 安全性 | 🟡 MCP 服务器可执行任意代码，需信任配置 |
| 可选性 | 🟢 完全可选，不配置 mcpServers 则走现有逻辑 |
| 打包影响 | 🟢 如手写实现，bundle 体积变化极小 |

---

## 5. 实施计划与优先级

| 优先级 | 功能 | 工作量 | 风险 | 依赖 |
|:------:|------|:------:|:----:|------|
| **P0** | ① 非流式 tool_calls 支持 | 小（~50 行） | 🟢 低 | 无 |
| **P1** | ② arguments 流式增量 | 中（~60 行） | 🟡 中 | 无 |
| **P2** | ③ MCP Client (HTTP) | 大（~500 行） | 🔴 高 | 无 |
| **P3** | ③ MCP Client (stdio) | 中（~200 行追加） | 🟡 中 | P2 |

### 建议实施顺序

1. **先完成 P0 + P1**（约 1 小时）：独立可发布，不影响现有用户
2. **再实施 P2**（HTTP MCP，约 1-2 天）：作为 v0.4.0 主要功能
3. **按需追加 P3**（stdio MCP）：如有本地工具需求

### 每个功能独立可发布

- P0 完成后 → 发布 `0.3.3`
- P1 完成后 → 发布 `0.3.4`
- P2 完成后 → 发布 `0.4.0`
- P3 完成后 → 发布 `0.4.1`

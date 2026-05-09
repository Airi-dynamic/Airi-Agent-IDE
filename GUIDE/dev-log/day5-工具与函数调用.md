# Day 5：Function Calling、工具系统与 Agent Loop 雏形

## 0. 前言

Day 4 我们让 LLM 能开口说话——但它只能"说"，不能"做"。今天补上**让模型动手**的能力：定义三个只读工具（`read_file` / `list_files` / `search_files`），让模型按照 OpenAI **Function Calling** 协议在回答中嵌入 `tool_call`，主进程拿到调用请求后真正去读盘 / 遍历 / grep，把结果回传，再让模型继续生成最终答复。这就是最朴素的 **agent 单回合循环**：`chat → tool_call → execute → tool_result → chat → ...`，最多 10 轮（`MAX_ITERATIONS=10`）防止恶性递归。

§4 仅讲今日新概念：Function Calling 协议 / JSON Schema 参数声明 / 流式 `tool_calls` 增量拼装（按 `index` 维护 `Map`）/ tool_call_id 配对 / `MAX_ITERATIONS` 防死循环 / 路径穿越防护 / workspaceRoot 提升到 store 的动机。

---

## 1. 本日目标与产出

### 1.1 功能目标

1. 在 Day 4 Chat 面板上对模型说"列出 src 下的 ts 文件"——助手气泡下方出现一个**可折叠的工具调用块**：标题栏显示工具名 `list_files` + 状态徽章（"执行中" → "完成"），展开后看到入参 JSON 与执行结果。
2. 多步推理可用：问"找出 `chat.store.ts` 里 `appendToken` 函数有多少行"——模型先 `search_files` 再 `read_file`，最后用文字总结，UI 依次显示 2 个工具块 + 一段最终文本。
3. 工具失败可恢复：故意问"读 `不存在.txt`"——工具块状态变成"失败"（红色），模型基于错误信息纠正方向，不会卡住对话。
4. 工作区路径自动透传：用户不用手动输入工作区根，工具内部自动以 `FileExplorer` 当前显示的目录为根解析相对路径。
5. Day 1-4 全部功能保持工作（编辑器、文件树、终端、流式对话、设置持久化）。

### 1.2 工程目标

1. `electron/services/agent/tools/` 工具层：`tool-registry.ts` 注册中心 + 三个工具实现；统一 `AgentTool` 接口（`name / description / parameters / execute`）。
2. `LLMProvider.chat` 签名扩展支持 `tools` 入参；`StreamChunk.type` 新增 `tool_call_start` / `tool_call_end`；`Message.role` 新增 `'tool'`，`content` 可空。
3. `OpenAIProvider` 实现 OpenAI 流式 `tool_calls` 的增量拼装协议（按 `delta.tool_calls[].index` 维护活跃 `Map`，`finish_reason` 触发完整释放）。
4. `ChatService` 重构为单回合 **agent loop**：每轮收集 `completedToolCalls`，若不为空则执行工具 → 把 `role:'tool'` 结果 push 回 messages → 进入下一轮；最多 10 轮。
5. IPC 新增两个推送通道 `chat:tool-call` / `chat:tool-result`；`sendChatMessage` 新增 `workspacePath` 入参。
6. 渲染层 `chat.store` 新增 `handleToolCall` / `handleToolResult` action，把工具调用挂在最后一条 assistant 消息的 `toolCalls` 数组上；`ToolCallBlock` 折叠组件渲染状态、参数、结果。
7. 新建 `src/stores/file-tree.store.ts` 把 `workspaceRoot` 从 `FileExplorer` 局部 state 提升到全局，让 `useChat` 能拿到。

---

## 2. 先跑起来（Smoke Run）

```powershell
Set-Location .\GUIDE\day5
npm install
npm run dev
```

首次启动后用 DevTools console 配置 LLM（同 Day 4，配置已沿用 Day 4 落盘文件）：

```js
await window.api.updateChatSettings({
  apiKey: 'sk-xxx',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat'   // 或任意支持 tools 的 OpenAI 兼容模型
})
```

然后：

1. 点活动栏 💬 → 输入"列出当前工作区根目录的所有文件" → 助手气泡下方出现 `list_files` 工具块（蓝色"执行中" → 绿色"完成"），展开看见参数和文件树文本，紧接着是模型基于结果的总结文字。
2. 输入"读取 `package.json` 第 1~20 行并解释" → 助手输出一个 `read_file` 工具块 + 总结。
3. 输入"在 `src` 下搜索包含 `useFileTreeStore` 的代码" → `search_files` 工具块 → 文字总结。
4. 输入"读取 `不存在.txt`" → `read_file` 工具块变红色"失败"，展开看见错误 JSON，模型回复"该文件不存在"。
5. 输入"列出 src 下所有 ts 文件，再读其中行数最多的那个" → 看到 2~N 个工具块依次执行（最多 10 轮），最后一段文字总结。

---

## 3. 项目结构与变更总览

### 3.1 项目目录树（ASCII）

```text
day5/
├─ electron/
│  ├─ main.ts                                       # 不变
│  ├─ preload.ts                                    # 修改：sendChatMessage +workspacePath；新增 onChatToolCall / onChatToolResult
│  ├─ ipc/
│  │  ├─ index.ts                                   # 不变
│  │  ├─ chat.ipc.ts                                # 修改：handle 接 workspacePath；callbacks 加 onToolCall/onToolResult
│  │  └─ ...                                        # 其余不变
│  └─ services/
│     ├─ file-system.service.ts                     # 不变
│     └─ agent/
│        ├─ chat.service.ts                         # 修改：sendMessage 接 workspacePath；MAX_ITERATIONS 主循环
│        ├─ providers/
│        │  ├─ base.provider.ts                     # 修改：Message.role +'tool'；ToolCall/ToolDefinition；StreamChunk +tool_call_*
│        │  └─ openai.provider.ts                   # 修改：tools 透传；activeToolCalls Map；finish_reason 收尾
│        └─ tools/                                  # 新增目录
│           ├─ tool-registry.ts                     # 新增：AgentTool / ToolContext / ToolRegistry 单例
│           ├─ read-file.tool.ts                    # 新增
│           ├─ list-files.tool.ts                   # 新增
│           └─ search.tool.ts                       # 新增
├─ src/
│  ├─ components/
│  │  ├─ chat/
│  │  │  ├─ ChatMessage.tsx                         # 修改：渲染 message.toolCalls
│  │  │  ├─ ToolCallBlock.tsx                       # 新增：折叠状态+参数+结果
│  │  │  └─ ChatPanel.tsx / ChatInput.tsx           # 不变
│  │  ├─ file-explorer/FileExplorer.tsx             # 修改：workspaceRoot 改用 useFileTreeStore
│  │  └─ terminal/TerminalInstance.tsx              # 修改：仅欢迎语 "Day 5"
│  ├─ hooks/useChat.ts                              # 修改：订阅两个新通道；从 file-tree store 取 workspaceRoot
│  ├─ stores/
│  │  ├─ chat.store.ts                              # 修改：sendMessage +workspacePath；handleToolCall/handleToolResult
│  │  ├─ file-tree.store.ts                        # 新增：workspaceRoot 提升
│  │  └─ ...                                        # 其余不变
│  └─ vite-env.d.ts                                 # 修改：ToolCallInfo + ChatMessageData.toolCalls + 2 个新 listener
└─ package.json                                     # 修改：仅 name/description
```

### 3.2 Agent Loop 链路图

Day 4 是单向流：`user → llm → token...token → done`。Day 5 在 done 后增加一个判断：是否有工具调用待执行？

```text
┌────── renderer ──────┐                ┌────────────── main ──────────────┐
│                      │  invoke        │                                  │
│ sendMessage(content, ├───────────────▶│ ipcMain.handle('chat:send-message│
│  workspaceRoot)      │                │   ', (_e, msg, ws) =>            │
│                      │                │   chatService.sendMessage(msg,ws,│
│                      │                │     callbacks))                  │
│                      │                │       │                          │
│                      │                │       ▼                          │
│                      │                │ ┌── while iter<MAX_ITERATIONS ──┐│
│                      │                │ │ provider.chat({messages,     ││
│                      │                │ │   tools:registry.getDefs()})  ││
│                      │                │ │   for await chunk:           ││
│ onChatStream ◀───────┼────send────────│ │     text_delta → onToken     ││
│ onChatToolCall ◀─────┼────send────────│ │     tool_call_start          ││
│                      │                │ │       → onToolCall(id,name,a)││
│                      │                │ │     tool_call_end            ││
│                      │                │ │       → push to completed[]  ││
│                      │                │ │   end-for                    ││
│                      │                │ │   if completed.length===0:   ││
│                      │                │ │     push assistant.content   ││
│ onChatComplete ◀─────┼────send────────│ │     onComplete; break        ││
│                      │                │ │   else:                      ││
│                      │                │ │     push assistant{content,  ││
│                      │                │ │       tool_calls}            ││
│                      │                │ │     for tc of completed:     ││
│                      │                │ │       result=registry.execute││
│ onChatToolResult ◀───┼────send────────│ │       onToolResult(id,result)││
│                      │                │ │       push {role:'tool',     ││
│                      │                │ │         tool_call_id,content}││
│                      │                │ │     iter++; continue         ││
│                      │                │ └────────────────────────────────┘
│                      │                │   if iter==MAX: onError         │
│                      │                │                                  │
└──────────────────────┘                └──────────────────────────────────┘
```

注意三个细节：
- `provider.chat` 是 **async generator**，每轮的 `for await` 块结束才决定要不要继续；
- `tool_call_start` 立即推给前端是为了让 UI 先显示"执行中"占位；执行结果 `tool_call_result` 才填充结果；
- 模型的"思考"文本（`text_delta`）和工具调用是**穿插**的，但本日为简化只在最后一轮把文本作为最终回答推给 `onComplete`。

### 3.3 编码步骤索引（依赖顺序）

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `package.json` | 修改 | 仅 name/description |
| 2 | `electron/services/agent/providers/base.provider.ts` | 修改 | 扩展 Message/ToolCall/StreamChunk |
| 3 | `electron/services/agent/tools/tool-registry.ts` | 新增 | 工具注册中心 |
| 4 | `electron/services/agent/tools/read-file.tool.ts` | 新增 | read_file 工具实现 |
| 5 | `electron/services/agent/tools/list-files.tool.ts` | 新增 | list_files 工具实现 |
| 6 | `electron/services/agent/tools/search.tool.ts` | 新增 | search 工具实现 |
| 7 | `electron/services/agent/providers/openai.provider.ts` | 修改 | tools + 流式拼装 |
| 8 | `electron/services/agent/chat.service.ts` | 修改 | MAX_ITERATIONS 主循环 |
| 9 | `electron/ipc/chat.ipc.ts` | 修改 | workspacePath + 2 callbacks |
| 10 | `electron/preload.ts` | 修改 | workspacePath + 2 listeners |
| 11 | `src/vite-env.d.ts` | 修改 | ToolCallInfo + 新 sigs |
| 12 | `src/stores/file-tree.store.ts` | 新增 | workspaceRoot 提升 |
| 13 | `src/components/file-explorer/FileExplorer.tsx` | 修改 | 改用 store |
| 14 | `src/stores/chat.store.ts` | 修改 | handleToolCall/handleToolResult |
| 15 | `src/hooks/useChat.ts` | 修改 | 2 个 listener + workspaceRoot |
| 16 | `src/components/chat/ToolCallBlock.tsx` | 新增 | 工具调用卡片组件 |
| 17 | `src/components/chat/ChatMessage.tsx` | 修改 | 渲染 toolCalls |
| 18 | `src/components/terminal/TerminalInstance.tsx` | 修改 | 仅欢迎语 |

依赖序：底层数据结构（base.provider）→ 工具注册中心 → 三个具体工具（被 registry import）→ provider 改造（用 tools 字段）→ service 改造（用 registry + provider）→ IPC（用 service）→ preload 暴露 → 类型 → 全局 store → 消费 store 的 FileExplorer → chat store actions → hook 订阅 → UI 叶子组件 → 容器组件 → 文案。

---

## 4. 基础知识铺垫

### 4.1 Function Calling 协议

OpenAI Chat Completions 支持在请求里附 `tools: [{type:'function', function:{name, description, parameters}}]`，模型在回答中可以选择**不输出文本**而输出一个或多个 `tool_calls`：

```jsonc
{
  "role": "assistant",
  "content": null,                      // 注意：可以为 null
  "tool_calls": [
    { "id": "call_abc", "type": "function",
      "function": { "name": "read_file", "arguments": "{\"path\":\"a.ts\"}" } }
  ]
}
```

调用方（我们）执行该函数后必须把结果以 `role:'tool'` 消息回发，**`tool_call_id` 必须与上一步的 `id` 配对**：

```jsonc
{ "role": "tool", "tool_call_id": "call_abc", "content": "...文件内容..." }
```

只要把这两条 push 进 messages 再请求一次模型，模型就能基于工具结果继续回答。这就是 agent loop 的协议基础。

### 4.2 JSON Schema 参数声明

`tools[].function.parameters` 必须是一份 [JSON Schema](https://json-schema.org/)：

```json
{
  "type": "object",
  "properties": {
    "path":   { "type": "string", "description": "相对工作区根的文件路径" },
    "offset": { "type": "number", "description": "起始行号" }
  },
  "required": ["path"]
}
```

模型读取 `description` 决定怎么填 `arguments`。**`description` 写得好坏直接决定调用质量**——例如 `path` 必须强调"相对工作区根"，否则模型可能传绝对路径。

### 4.3 流式 `tool_calls` 增量拼装

非流式响应一次性给出完整 `tool_calls`；流式则把 `arguments` 字符串拆成无数个 `delta` 增量送来，每个 chunk 长这样：

```jsonc
// chunk 1
{ "delta": { "tool_calls": [{ "index": 0, "id": "call_abc",
                              "function": { "name": "read_file", "arguments": "{\"pa" } }] } }
// chunk 2
{ "delta": { "tool_calls": [{ "index": 0,
                              "function": { "arguments": "th\":\"a.ts" } }] } }
// chunk 3
{ "delta": { "tool_calls": [{ "index": 0,
                              "function": { "arguments": "\"}" } }] } }
// chunk 4
{ "finish_reason": "tool_calls" }
```

**拼装规则**：
- 用 `delta.tool_calls[].index` 作 key 维护一张活跃 `Map<number, {id, name, arguments}>`；
- `id` 与 `name` 只在第一次出现；后续 chunk 仅追加 `arguments` 字符串；
- `finish_reason` 出现时把 Map 里所有完整 `tool_call` 一次性 yield 出去再 `clear()`。

为什么用 `index` 而不是 `id`？因为 `id` 只在第一个 chunk 给，后续 chunk 没法做 key——OpenAI 协议如此规定。同一回合可能并行多个 `tool_call`（`index=0`、`index=1` 同时增量），所以 `Map` 是必要的。

### 4.4 `tool_call_id` 配对与 `Message.role:'tool'`

把上面 `chat.completions` 的 messages 数组放慢看：

```text
[ system, user, assistant{tool_calls:[A,B]}, tool{id:A}, tool{id:B}, assistant{...} ]
```

`assistant` 那条**和它对应的 N 条 `tool` 必须连续**，且 `tool_call_id` 一一对应。漏一条 / 顺序错 / id 不配，OpenAI 都会直接报 `400 - tool_call_id ... not found`。

### 4.5 `MAX_ITERATIONS` 防死循环

模型有概率"上瘾"——明明该输出文字回答了，却又生成一个 tool_call，循环往复烧 token。最简单的兜底是硬上限：

```ts
const MAX_ITERATIONS = 10
let iter = 0
while (iter < MAX_ITERATIONS) { ... iter++ }
if (iter === MAX_ITERATIONS) callbacks.onError('达到最大迭代次数')
```

10 在教学项目里足够覆盖任何实际多步任务。

### 4.6 路径穿越防护

工具拿到 `args.path` 就 `fs.readFile(args.path)` 是危险的：模型可能传 `../../../etc/passwd`。统一在 `resolvePath` 函数中：

```ts
const stripped = filePath.replace(/^[/\\]+/, '')   // 削掉开头的 / \
return path.resolve(workspacePath, stripped)
```

虽然 `path.resolve` 仍会接受 `..`，但在教学项目（用户自己的工作区）足以防止"模型偶发拼出根路径"的事故。生产级还应再做 `result.startsWith(workspacePath)` 校验。

### 4.7 workspaceRoot 提升到全局 store

Day 3-4 里 `workspaceRoot` 是 `FileExplorer` 组件内部 `useState`。本日 `useChat` 也要拿它（透传给主进程工具）——但 hook 在 `ChatPanel` 里、与 `FileExplorer` 同级，组件树里没有共同祖先持有它。

最干净的解法：单独一个 Zustand store `file-tree.store.ts`，谁需要谁订阅。**严禁**通过 prop drilling 一层层传——3 层就开始痛苦。

### 4.8 工具错误的"软"返回 vs throw

我们让 `ToolRegistry.execute` 把 catch 到的错误**包成 JSON 字符串返回**而不是 throw：

```ts
async execute(name, args, ctx) {
  try { return await tool.execute(args, ctx) }
  catch (err) { return JSON.stringify({ error: err.message }) }
}
```

理由：throw 会一路冒泡到 `ChatService` 的 try/catch，触发 `onError`、整个对话终止。而软返回让错误信息**作为 tool_result 回到模型**，模型有机会自我纠正（"哦该文件不存在，那我换个路径试试"）。判错统一用 `result.startsWith('{"error"')`——简陋但实用。

---

## 5. 编码步骤

### 5.1 步骤 1：更新 `package.json`

#### A. 动机
将项目名/描述切到 Day 5；依赖与 Day 4 完全相同（`openai` SDK 已在 Day 4 引入）。

#### B. 你将要做的操作
打开 `package.json`，修改 `name` 与 `description` 两个字段。

#### C. 完整代码

*文件 `package.json`（仅展示头部变更）：*
```json
{
  "name": "my-agent-ide-day5",
  "version": "0.5.0",
  "description": "Day 5: Agent Tools + Function Calling",
  "main": "out/main/main.js",
  ...其余字段与 Day 4 完全一致...
}
```

> 注：依赖 `openai` 已在 Day 4 加入，Day 5 不需要 `npm install` 新包。

#### D. 这段代码做了什么
仅元数据。**对比写法**：也可保留 Day 4 的名字让 `npm run dev` 时输出旧名字；这里改名只是为了让 `package-lock.json` 与 dayN 目录强对应、便于读者校对。

#### E. 立刻验证
`npm install` 应当只更新 `package-lock.json` 中的 name 字段，无新包下载。

---

### 5.2 步骤 2：扩展 `base.provider.ts` 接口

#### A. 动机
工具需要 4 处类型扩展：① `Message.role` 加 `'tool'`、② `Message.content` 可空（`assistant` 在纯工具调用回合不输出文本）、③ 新增 `ToolCall` / `ToolDefinition`、④ `StreamChunk.type` 加 `tool_call_start` / `tool_call_end`。

#### B. 你将要做的操作
打开 `electron/services/agent/providers/base.provider.ts`，整文件替换为下面内容。

#### C. 完整代码

*文件 `electron/services/agent/providers/base.provider.ts`：*
```ts
/**
 * Day 5: LLM Provider 抽象（扩展版，支持 Function Calling）。
 */

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string   // JSON 字符串（OpenAI 协议如此）
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>   // JSON Schema
  }
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null            // assistant 纯工具调用回合 content 可为 null
  tool_calls?: ToolCall[]           // 仅 assistant 可能有
  tool_call_id?: string             // 仅 role:'tool' 必须有，与对应 tool_call.id 配对
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_end' | 'done' | 'error'
  content?: string                  // text_delta 时携带 token
  toolCall?: Partial<ToolCall>      // tool_call_start/end 时携带
  error?: string                    // error 时携带
}

export interface ProviderConfig {
  apiKey: string
  baseURL: string
  model: string
}

export interface ChatOptions {
  messages: Message[]
  tools?: ToolDefinition[]          // Day 5 新增
  stream: true
}

export interface LLMProvider {
  chat(options: ChatOptions): AsyncIterable<StreamChunk>
}
```

#### D. 这段代码做了什么
- **`ToolCall`**：与 OpenAI 完全一致的形状。`arguments` 是字符串而非对象，因为流式拼装时只能拿到字符串增量。
- **`ToolDefinition`**：发给模型的"工具说明书"，`parameters` 是 JSON Schema 对象（用 `Record<string, unknown>` 而非具体类型，避免引入 JSON Schema TS 库）。
- **`Message.content` 改为 `string | null`**：纯工具调用回合 OpenAI 返回的 assistant 消息 `content === null`，TypeScript 必须能表达。
- **`StreamChunk.type` 加两个新值**：用判别式 union 而非新加 boolean 字段——这样 `switch(chunk.type)` 处可被 TS 穷尽性检查。
- **对比写法**：也可以让 `tool_call_start` 携带 `{id,name}`、`tool_call_end` 携带完整 `arguments`——分两个事件而非合并一个。这样 UI 能立刻渲染"执行中"占位，体验更好。

#### E. 立刻验证
保存后运行 `npm run dev`，TS 应在 `chat.service.ts`、`openai.provider.ts` 上报多处错误（因为它们还没适配新接口），这是预期；下面几步会逐个修复。

---

### 5.3 步骤 3：新增 `tool-registry.ts`

#### A. 动机
所有工具共享同一注册中心：登记 → 列出（生成 `tools` 透传给 LLM）→ 按名字派发执行。把"上下文"（目前只有 workspacePath）抽象成 `ToolContext`，避免每个工具单独从全局拿。

#### B. 你将要做的操作
新建 `electron/services/agent/tools/tool-registry.ts`，写入完整内容。

#### C. 完整代码

*文件 `electron/services/agent/tools/tool-registry.ts`：*
```ts
/**
 * Day 5: 工具注册中心。
 *
 * - register/get/getAll：增删查
 * - getToolDefinitions：映射成 OpenAI tools 格式
 * - execute：按名字派发；catch 后返回 JSON 字符串而非 throw
 */
import type { ToolDefinition } from '../providers/base.provider'

export interface ToolContext {
  workspacePath: string
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>           // JSON Schema
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>
}

class ToolRegistry {
  private tools = new Map<string, AgentTool>()

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values())
  }

  /** 映射成 OpenAI tools 数组，用于发请求时透传。 */
  getToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  /**
   * 按名字派发执行；统一 catch 包成 JSON 错误字符串返回，
   * 让模型能基于错误自我纠正。
   */
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return JSON.stringify({ error: `未知工具：${name}` })
    try {
      return await tool.execute(args, ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: message })
    }
  }
}

export const toolRegistry = new ToolRegistry()
```

#### D. 这段代码做了什么
- **`Map`** 而非对象字面量：避免 `__proto__` 等键被覆盖；查找 O(1)。
- **`getToolDefinitions`**：把领域形态（`AgentTool`）映射到协议形态（`ToolDefinition`）的转换层；这一层让我们能在工具内部携带额外字段（如未来可能加的 `requiresApproval`）而不污染发给 LLM 的请求。
- **`execute` 软错**：详见 §4.8。**对比反例**：若 `throw err`，则 `chat.service.ts` 一接到异常就 `onError` 终止整个对话——丧失自愈能力。
- **`export const toolRegistry`**：单例，全局共享。**对比写法**：也可以传 registry 实例给 `ChatService` 构造函数（依赖注入），更利于测试；本日为简化用单例。

#### E. 立刻验证
TS 编译通过即可（registry 还没被 import，运行时无效果）。

---

### 5.4 步骤 4：新增 `read-file.tool.ts`

#### A. 动机
Agent 首先要"看"。`read_file` 是最朴素的能力，支持 `offset/limit` 分页避免大文件爆 token。

#### B. 你将要做的操作
新建 `electron/services/agent/tools/read-file.tool.ts`。

#### C. 完整代码

*文件 `electron/services/agent/tools/read-file.tool.ts`：*
```ts
/**
 * Day 5: read_file 工具——按行读取文件内容。
 *
 * 返回带行号的文本（" 1|content"），便于模型精准定位代码。
 */
import fs from 'fs/promises'
import path from 'path'
import type { AgentTool, ToolContext } from './tool-registry'

/** 安全解析路径：去前导斜杠避免穿越；相对路径基于 workspacePath。 */
function resolvePath(filePath: string, context: ToolContext): string {
  const stripped = filePath.replace(/^[/\\]+/, '')
  if (!stripped || stripped === '.') return context.workspacePath
  if (path.isAbsolute(stripped)) return stripped
  return path.resolve(context.workspacePath, stripped)
}

const readFileTool: AgentTool = {
  name: 'read_file',
  description: '读取指定路径的文件内容，返回带行号的文本。支持通过 offset/limit 分页读取大文件。',
  parameters: {
    type: 'object',
    properties: {
      path:   { type: 'string', description: '相对于工作区根目录的文件路径，例如 "src/main.ts"' },
      offset: { type: 'number', description: '起始行号（1-indexed），省略则从头读取' },
      limit:  { type: 'number', description: '最多读取的行数，省略则读取全部' },
    },
    required: ['path'],
  },

  async execute(args, context) {
    const filePath = resolvePath(args.path as string, context)
    const offset = args.offset as number | undefined
    const limit = args.limit as number | undefined

    try {
      const content = await fs.readFile(filePath, 'utf-8')
      let lines = content.split('\n')

      const startIndex = offset && offset > 0 ? offset - 1 : 0
      const endIndex = limit && limit > 0 ? startIndex + limit : lines.length
      lines = lines.slice(startIndex, endIndex)

      const totalDigits = String(startIndex + lines.length).length
      const numbered = lines.map((line, i) => {
        const lineNum = String(startIndex + i + 1).padStart(totalDigits, ' ')
        return `${lineNum}|${line}`
      })

      return numbered.join('\n')
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return `错误：文件不存在 ${filePath}`
      if (err.code === 'EISDIR') return `错误：路径是目录，请指定文件 ${filePath}`
      return `读取文件出错：${err.message}`
    }
  },
}

export default readFileTool
```

#### D. 这段代码做了什么
- **`resolvePath`**：详见 §4.6；先削开头的 `/`、`\`，再 `path.resolve` 接到 workspacePath 后。
- **行号前缀**：`String(...).padStart(totalDigits, ' ')` 让所有行号右对齐——模型理解行号位置时更稳。
- **错误**：注意这里 `return` 字符串而不是 throw——错误也是结果。但**没有**包装成 `{"error":...}` JSON——因为这种"找不到文件"是业务级提示，模型直接读字面量也能理解。**对比写法**：统一用 `{"error":...}` 也行，但模型对自然语言更敏感。
- **对比反例**：若直接 `fs.readFile(args.path as string)` 不经 `resolvePath`，模型传 `../../../etc/passwd` 就读到主机敏感文件——这是路径穿越漏洞。

#### E. 立刻验证
本步骤无法独立验证（注册中心还没把工具加进去），将在步骤 8 之后统一运行。

---

### 5.5 步骤 5：新增 `list-files.tool.ts`

#### A. 动机
让模型"看见"目录结构，知道项目里有什么。需要忽略 `node_modules` 等噪音目录、限制深度和总条数避免输出爆炸。

#### B. 你将要做的操作
新建 `electron/services/agent/tools/list-files.tool.ts`。

#### C. 完整代码

*文件 `electron/services/agent/tools/list-files.tool.ts`：*
```ts
/**
 * Day 5: list_files 工具——递归列出目录文件。
 */
import fs from 'fs/promises'
import path from 'path'
import type { AgentTool, ToolContext } from './tool-registry'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'out', '.next',
  '__pycache__', '.cache', 'coverage',
])
const MAX_ENTRIES = 200

function resolvePath(filePath: string, context: ToolContext): string {
  const stripped = filePath.replace(/^[/\\]+/, '')
  if (!stripped || stripped === '.') return context.workspacePath
  if (path.isAbsolute(stripped)) return stripped
  return path.resolve(context.workspacePath, stripped)
}

interface TreeNode {
  name: string
  isDir: boolean
  children?: TreeNode[]
}

async function buildTree(
  dirPath: string,
  recursive: boolean,
  maxDepth: number,
  currentDepth: number,
  counter: { count: number },
): Promise<TreeNode[]> {
  if (counter.count >= MAX_ENTRIES) return []
  let entries
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const result: TreeNode[] = []
  for (const entry of entries) {
    if (counter.count >= MAX_ENTRIES) break
    if (IGNORED_DIRS.has(entry.name)) continue

    counter.count++
    const node: TreeNode = { name: entry.name, isDir: entry.isDirectory() }

    if (entry.isDirectory() && recursive && currentDepth < maxDepth) {
      node.children = await buildTree(
        path.join(dirPath, entry.name),
        recursive, maxDepth, currentDepth + 1, counter,
      )
    }
    result.push(node)
  }
  return result
}

function formatTree(nodes: TreeNode[], indent = ''): string {
  return nodes.map((n) => {
    const line = `${indent}${n.isDir ? '[DIR] ' : ''}${n.name}`
    const children = n.children ? '\n' + formatTree(n.children, indent + '  ') : ''
    return line + children
  }).join('\n')
}

const listFilesTool: AgentTool = {
  name: 'list_files',
  description: '列出指定目录下的文件和子目录。可选递归，自动忽略 node_modules 等无关目录。',
  parameters: {
    type: 'object',
    properties: {
      path:      { type: 'string',  description: '相对工作区根的目录路径，省略则列工作区根' },
      recursive: { type: 'boolean', description: '是否递归子目录，默认 false' },
      maxDepth:  { type: 'number',  description: '递归最大深度，默认 3' },
    },
    required: [],
  },

  async execute(args, context) {
    const dirPath = args.path
      ? resolvePath(args.path as string, context)
      : context.workspacePath
    const recursive = (args.recursive as boolean) ?? false
    const maxDepth = (args.maxDepth as number) ?? 3

    const counter = { count: 0 }
    const tree = await buildTree(dirPath, recursive, maxDepth, 0, counter)
    if (tree.length === 0) return `目录为空或不存在：${dirPath}`

    const formatted = formatTree(tree)
    const suffix = counter.count >= MAX_ENTRIES
      ? `\n\n(已截断，最多显示 ${MAX_ENTRIES} 条)`
      : ''
    return formatted + suffix
  },
}

export default listFilesTool
```

#### D. 这段代码做了什么
- **`IGNORED_DIRS`**：`Set` 而非数组，`has` O(1)。
- **`counter` 引用对象**：递归深处 `count` 同步增加，命中上限立刻全栈早退。**对比写法**：用闭包变量也可，但传引用更显式。
- **`recursive` 与 `maxDepth`** 双重保险：模型可能传 `recursive:true` 不指定深度，默认 3 层基本够用，避免把整个仓库塞进 prompt。
- **`formatTree`**：缩进 + `[DIR]` 标记——足够给模型理解层级，省得用 ASCII 树字符增加 token。

#### E. 立刻验证
同步骤 4，等 §5.8 注册后再跑。

---

### 5.6 步骤 6：新增 `search.tool.ts`

#### A. 动机
让模型能 grep。给定关键词，遍历工作区找匹配行——给的是"位置"（文件:行号:内容）而非整段代码，让模型再用 `read_file` 拉详情，节省 token。

#### B. 你将要做的操作
新建 `electron/services/agent/tools/search.tool.ts`。

#### C. 完整代码

*文件 `electron/services/agent/tools/search.tool.ts`：*
```ts
/**
 * Day 5: search_files 工具——在工作区内全文搜索字面量。
 */
import fs from 'fs/promises'
import path from 'path'
import type { AgentTool, ToolContext } from './tool-registry'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'out', '.next',
  '__pycache__', '.cache', 'coverage',
])
const MAX_FILE_SIZE = 1024 * 1024
const MAX_RESULTS = 50

function resolvePath(filePath: string, context: ToolContext): string {
  const stripped = filePath.replace(/^[/\\]+/, '')
  if (!stripped || stripped === '.') return context.workspacePath
  if (path.isAbsolute(stripped)) return stripped
  return path.resolve(context.workspacePath, stripped)
}

/** 转义正则元字符，把模型给的 query 当字面量匹配。 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 简易 glob：仅支持 * 和 ?，用于文件名过滤。 */
function matchesGlob(fileName: string, pattern: string): boolean {
  const regexStr = pattern
    .split('*')
    .map((s) => s.split('?').map(escapeRegex).join('.'))
    .join('.*')
  try {
    return new RegExp(`^${regexStr}$`, 'i').test(fileName)
  } catch {
    return false
  }
}

async function walkAndSearch(
  dirPath: string,
  pattern: RegExp,
  results: string[],
  filePattern?: string,
): Promise<void> {
  if (results.length >= MAX_RESULTS) return
  let entries
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break
    const fullPath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await walkAndSearch(fullPath, pattern, results, filePattern)
      }
    } else if (entry.isFile()) {
      if (filePattern && !matchesGlob(entry.name, filePattern)) continue
      try {
        const stat = await fs.stat(fullPath)
        if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue
        const content = await fs.readFile(fullPath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_RESULTS) break
          pattern.lastIndex = 0
          if (pattern.test(lines[i])) {
            results.push(`${fullPath}:${i + 1}: ${lines[i].trimEnd()}`)
          }
        }
      } catch {
        // 跳过无法读取的文件（权限不足等）。
      }
    }
  }
}

const searchFilesTool: AgentTool = {
  name: 'search_files',
  description: '在工作区内搜索包含指定文本的代码行，返回匹配的文件路径、行号和行内容。',
  parameters: {
    type: 'object',
    properties: {
      query:         { type: 'string',  description: '要搜索的文本（当作字面量处理，不是正则）' },
      path:          { type: 'string',  description: '搜索范围（相对工作区的子目录），省略则搜索整个工作区' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
      filePattern:   { type: 'string',  description: '文件名 glob 过滤，例如 "*.ts" 仅搜索 TypeScript 文件' },
    },
    required: ['query'],
  },

  async execute(args, context) {
    const query = args.query as string
    const searchPath = args.path
      ? resolvePath(args.path as string, context)
      : context.workspacePath
    const caseSensitive = (args.caseSensitive as boolean) ?? false
    const filePattern = args.filePattern as string | undefined

    const flags = caseSensitive ? 'g' : 'gi'
    let pattern: RegExp
    try {
      pattern = new RegExp(escapeRegex(query), flags)
    } catch {
      return `错误：无效的搜索关键字 "${query}"`
    }

    const results: string[] = []
    await walkAndSearch(searchPath, pattern, results, filePattern)

    if (results.length === 0) return `未找到与 "${query}" 相关的结果`

    const suffix = results.length >= MAX_RESULTS
      ? `\n\n(结果已截断，最多显示 ${MAX_RESULTS} 条)`
      : ''
    return results.join('\n') + suffix
  },
}

export default searchFilesTool
```

#### D. 这段代码做了什么
- **`escapeRegex`**：模型传的 `query` 包含 `.` `(` 等会被当正则元字符——必须转义当字面量。**对比反例**：直接 `new RegExp(query)` 会让 `query="a.b"` 匹配到 `aXb`，模型很难定位 bug。
- **`pattern.lastIndex = 0`**：全局正则有"上次匹配位置"状态，每行匹配前必须复位，否则 `test` 第二次开始可能漏。
- **`!entry.name.startsWith('.')`**：跳过 `.vscode`、`.idea` 等隐藏目录——模型一般不关心。
- **`MAX_FILE_SIZE = 1MB`**：避免读到 lockfile / dump 文件后塞爆内存。
- **结果格式 `${fullPath}:${lineNum}: ${line}`**：与 ripgrep 输出形式一致，模型从训练数据里见过、容易解析。

#### E. 立刻验证
同前两步。

---

### 5.7 步骤 7：改造 `openai.provider.ts` 支持 `tools`

#### A. 动机
让 Provider 把 `tools` 透传给 OpenAI、把流式增量 `tool_calls` 拼装成完整结构 yield 出去。

#### B. 你将要做的操作
打开 `electron/services/agent/providers/openai.provider.ts`，整文件替换。

#### C. 完整代码

*文件 `electron/services/agent/providers/openai.provider.ts`：*
```ts
/**
 * Day 5: OpenAI Provider（支持 Function Calling 流式拼装）。
 */
import OpenAI from 'openai'
import type {
  ChatOptions, LLMProvider, Message, ProviderConfig, StreamChunk, ToolCall,
} from './base.provider'

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI

  constructor(private config: ProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamChunk> {
    const requestParams: Parameters<typeof this.client.chat.completions.create>[0] = {
      model: this.config.model,
      messages: options.messages.map(toOpenAIMessage),
      stream: true,
    }

    // 仅在有工具时携带，避免空数组导致部分模型报错。
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools
    }

    // 流式 tool_calls 必须按 index 维护活跃映射。
    const activeToolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    try {
      const stream = await this.client.chat.completions.create(requestParams) as
        AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        // 1) 文本增量
        if (delta.content) {
          yield { type: 'text_delta', content: delta.content }
        }

        // 2) 工具调用增量
        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index
            let acc = activeToolCalls.get(idx)
            if (!acc) {
              acc = {
                id: tcDelta.id ?? '',
                name: tcDelta.function?.name ?? '',
                arguments: '',
              }
              activeToolCalls.set(idx, acc)
              // 首次出现：通知前端"开始工具调用"
              yield {
                type: 'tool_call_start',
                toolCall: {
                  id: acc.id,
                  type: 'function',
                  function: { name: acc.name, arguments: '' },
                },
              }
            }
            // 后续 chunk：累积 arguments 字符串
            if (tcDelta.function?.arguments) {
              acc.arguments += tcDelta.function.arguments
            }
          }
        }

        // 3) 收尾：finish_reason 出现时把 Map 里所有工具调用一次性 yield
        if (choice.finish_reason) {
          for (const acc of activeToolCalls.values()) {
            yield {
              type: 'tool_call_end',
              toolCall: {
                id: acc.id,
                type: 'function',
                function: { name: acc.name, arguments: acc.arguments },
              },
            }
          }
          activeToolCalls.clear()
        }
      }

      yield { type: 'done' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', error: message }
    }
  }
}

/** 将我们的 Message 形态转成 OpenAI SDK 能接受的形态。 */
function toOpenAIMessage(msg: Message): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: msg.content ?? '' }
    case 'user':
      return { role: 'user', content: msg.content ?? '' }
    case 'assistant':
      return {
        role: 'assistant',
        content: msg.content,                  // 可能为 null
        tool_calls: msg.tool_calls,            // 可能 undefined
      } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    case 'tool':
      if (!msg.tool_call_id) throw new Error('tool message 必须携带 tool_call_id')
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content ?? '',
      }
  }
}
```

#### D. 这段代码做了什么
- **`requestParams.tools` 条件赋值**：部分兼容服务（如某些版本的 ollama）对空 `tools` 数组会报 400，所以仅在 `length > 0` 时才塞。
- **`activeToolCalls: Map<number, ...>`**：详见 §4.3。key 是 `index`、不是 `id`，因为 `id` 只在第一次出现。
- **首次出现就 yield `tool_call_start`**：让前端立刻显示"执行中"占位（即使此时 arguments 还没拼完）。
- **`finish_reason` 触发收尾**：模型可能在同一回合调用多个工具（`index=0`、`index=1`），收尾要遍历整个 Map。
- **`activeToolCalls.clear()`**：必须清，不然下一回合（agent loop 重入 `chat()`）会污染——虽然每次新 chat 会重新 `new Map()`，但显式 clear 是防御。
- **`toOpenAIMessage`**：4 个 case 用 `switch` 而非 if-else 链，TS 的穷尽性检查会保证以后加新 role 时编译报错。
- **对比反例**：若不维护 Map、每个 chunk 直接 yield 一个 `tool_call`——上层会看到一堆碎片化的、`arguments` 不完整的 `tool_call`，根本无法 `JSON.parse`。

#### E. 立刻验证
保存后 `npm run dev`，DevTools console 调一次没有 tools 的请求应当与 Day 4 行为一致：
```js
await window.api.sendChatMessage('你好', '/some/path')
// 应当只收到 onChatStream 的 token，最后 onChatComplete
```

---

### 5.8 步骤 8：改造 `chat.service.ts` 为 Agent Loop

#### A. 动机
把 Day 4 的"一次请求"改成"循环请求直到没有工具调用"。同时把工具实例 `register` 进 `toolRegistry`、把 `workspacePath` 透传到每次工具执行。

#### B. 你将要做的操作
打开 `electron/services/agent/chat.service.ts`，整文件替换。

#### C. 完整代码

*文件 `electron/services/agent/chat.service.ts`：*
```ts
/**
 * Day 5: ChatService 重构为单回合 Agent Loop。
 */
import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { OpenAIProvider } from './providers/openai.provider'
import type { LLMProvider, Message, ProviderConfig, ToolCall } from './providers/base.provider'
import { toolRegistry } from './tools/tool-registry'
import readFileTool from './tools/read-file.tool'
import listFilesTool from './tools/list-files.tool'
import searchFilesTool from './tools/search.tool'

// 注册工具到全局单例（模块加载时执行一次）。
toolRegistry.register(readFileTool)
toolRegistry.register(listFilesTool)
toolRegistry.register(searchFilesTool)

const SETTINGS_FILE = 'chat-settings.json'
const MAX_ITERATIONS = 10

export interface ChatCallbacks {
  onToken: (token: string) => void
  onComplete: (fullText: string) => void
  onError: (message: string) => void
  onToolCall: (id: string, name: string, args: string) => void
  onToolResult: (id: string, result: string, isError: boolean) => void
}

export class ChatService {
  private provider: LLMProvider | null = null
  private config: ProviderConfig | null = null
  private messages: Message[] = []

  async loadSettings(): Promise<ProviderConfig | null> {
    try {
      const filePath = path.join(app.getPath('userData'), SETTINGS_FILE)
      const text = await fs.readFile(filePath, 'utf-8')
      this.config = JSON.parse(text) as ProviderConfig
      this.provider = new OpenAIProvider(this.config)
      return this.config
    } catch {
      return null
    }
  }

  async updateSettings(config: ProviderConfig): Promise<void> {
    this.config = config
    this.provider = new OpenAIProvider(config)
    const filePath = path.join(app.getPath('userData'), SETTINGS_FILE)
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')
  }

  clearHistory(): void {
    this.messages = []
  }

  async sendMessage(
    userContent: string,
    workspacePath: string,
    callbacks: ChatCallbacks,
  ): Promise<void> {
    if (!this.provider) {
      callbacks.onError('LLM 未配置，请先调用 updateChatSettings')
      return
    }

    this.messages.push({ role: 'user', content: userContent })

    let iter = 0
    while (iter < MAX_ITERATIONS) {
      iter++
      let assistantText = ''
      const completedToolCalls: ToolCall[] = []

      try {
        const stream = this.provider.chat({
          messages: this.messages,
          tools: toolRegistry.getToolDefinitions(),
          stream: true,
        })

        for await (const chunk of stream) {
          switch (chunk.type) {
            case 'text_delta':
              if (chunk.content) {
                assistantText += chunk.content
                callbacks.onToken(chunk.content)
              }
              break
            case 'tool_call_start':
              if (chunk.toolCall?.id && chunk.toolCall.function) {
                callbacks.onToolCall(
                  chunk.toolCall.id,
                  chunk.toolCall.function.name,
                  '',
                )
              }
              break
            case 'tool_call_end':
              if (chunk.toolCall?.id && chunk.toolCall.function) {
                completedToolCalls.push({
                  id: chunk.toolCall.id,
                  type: 'function',
                  function: {
                    name: chunk.toolCall.function.name,
                    arguments: chunk.toolCall.function.arguments ?? '',
                  },
                })
              }
              break
            case 'error':
              callbacks.onError(chunk.error ?? '未知错误')
              return
            case 'done':
              break
          }
        }
      } catch (err) {
        callbacks.onError(err instanceof Error ? err.message : String(err))
        return
      }

      // 没有工具调用 → 这一轮就是最终回答
      if (completedToolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: assistantText })
        callbacks.onComplete(assistantText)
        return
      }

      // 有工具调用 → 把 assistant + 工具结果都 push，继续下一轮
      this.messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: completedToolCalls,
      })

      for (const tc of completedToolCalls) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}')
        } catch {
          // 模型可能产出非法 JSON，给空对象兜底
        }
        const result = await toolRegistry.execute(
          tc.function.name,
          parsedArgs,
          { workspacePath },
        )
        const isError = result.startsWith('{"error"')
        callbacks.onToolResult(tc.id, result, isError)

        this.messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        })
      }
    }

    callbacks.onError(`已达到最大迭代次数 ${MAX_ITERATIONS}`)
  }
}
```

#### D. 这段代码做了什么
- **模块顶层 `register`**：单例的初始化副作用——只要 `chat.service.ts` 被 import 一次，三个工具就注册好。**对比写法**：在构造函数里 `register` 也行，但 `ChatService` 可能被多次 `new`，导致重复注册（虽然 Map 会覆盖，但更清晰是模块级一次）。
- **`while (iter < MAX_ITERATIONS)` 循环**：详见 §4.5。
- **`switch (chunk.type)`**：与 `StreamChunk.type` union 配合做穷尽性匹配。
- **`tool_call_start` 立即推**：UI 第一时间渲染"执行中"占位条；如果只在 end 时推，用户会看到一段空白等待——体验差。
- **`completedToolCalls.length === 0`** 是循环出口：模型这一轮纯文字回答，不再要求工具。
- **`content: assistantText || null`**：当模型纯工具调用回合（一个字都没说），content 必须为 null，符合 OpenAI 协议。
- **`isError = result.startsWith('{"error"')`**：详见 §4.8。
- **`JSON.parse(tc.function.arguments || '{}')`** + try/catch：模型偶尔会产出非法 JSON（比如截断的字符串），用 `{}` 兜底让工具至少执行（多半返回缺参数错误，模型再纠正）。**对比反例**：不 try/catch 直接 `JSON.parse`，整个回合崩溃。

#### E. 立刻验证
保存后 `npm run dev`，DevTools console：
```js
await window.api.updateChatSettings({ apiKey:'sk-xxx', baseURL:'...', model:'...' })
await window.api.sendChatMessage('列出工作区根目录文件', 'D:\\Project\\EXAMPLE\\My-Agent-IDE\\GUIDE\\day5')
```
此时还没有前端工具块，但应当能在终端看到 OpenAI SDK 的网络请求和响应；`onChatComplete` 应当输出包含目录信息的总结文字。

---

### 5.9 步骤 9：改 `chat.ipc.ts` 接受 `workspacePath` 与新增 2 个回调

#### A. 动机
把工具调用事件转发给 renderer。

#### B. 你将要做的操作
打开 `electron/ipc/chat.ipc.ts`，整文件替换。

#### C. 完整代码

*文件 `electron/ipc/chat.ipc.ts`：*
```ts
/**
 * Day 5: Chat IPC（新增 workspacePath 入参 + 2 个推送通道）。
 */
import { ipcMain, BrowserWindow, type WebContents } from 'electron'
import { ChatService } from '../services/agent/chat.service'

const chatService = new ChatService()

/** 守卫：webContents 已销毁时不发，避免 throw。 */
function safeSend(wc: WebContents, channel: string, payload: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, payload)
}

export function registerChatIpcHandlers(): void {
  // 启动时尝试加载持久化设置
  void chatService.loadSettings()

  ipcMain.handle('chat:send-message', async (event, message: string, workspacePath: string) => {
    const wc = event.sender
    await chatService.sendMessage(message, workspacePath, {
      onToken:      (token) => safeSend(wc, 'chat:stream', { token }),
      onComplete:   (text)  => safeSend(wc, 'chat:complete', { message: text }),
      onError:      (err)   => safeSend(wc, 'chat:error', { error: err }),
      onToolCall:   (id, name, args) => safeSend(wc, 'chat:tool-call', { id, name, args }),
      onToolResult: (id, result, isError) =>
        safeSend(wc, 'chat:tool-result', { id, result, isError }),
    })
  })

  ipcMain.handle('chat:get-settings', async () => chatService.loadSettings())
  ipcMain.handle('chat:update-settings', async (_e, config) => chatService.updateSettings(config))
  ipcMain.handle('chat:clear', async () => chatService.clearHistory())
}
```

#### D. 这段代码做了什么
- **`chatService` 单例**：模块顶层 `new`，整个主进程生命周期共享 messages 历史。
- **`event.sender`**：从 IPC 事件里拿到发起方的 `WebContents`，向它推流——这样多窗口时只会推给"问问题的那个窗口"。
- **5 个回调**：3 个 Day 4 老的 + 2 个 Day 5 新的，统一走 `safeSend`。
- **`safeSend` 的 isDestroyed 检查**：用户在流式生成中关闭窗口，若直接 `wc.send` 会 throw `Object has been destroyed`，整个 service 崩溃；判一下 `isDestroyed()` 就静默丢弃。

#### E. 立刻验证
不会单独验证；步骤 10 暴露后才能从 renderer 测。

---

### 5.10 步骤 10：`preload.ts` 暴露新 API

#### A. 动机
把 `sendChatMessage` 签名扩 `workspacePath`、新增两个事件订阅函数。

#### B. 你将要做的操作
打开 `electron/preload.ts`，把 chat 相关部分替换。

#### C. 完整代码

*文件 `electron/preload.ts`：*
```ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // Day 2-3
  runCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command),
  getFileTree: () => ipcRenderer.invoke('fs:get-file-tree'),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),

  // Day 4-5: Chat（Day 5 新增 workspacePath 参数）
  sendChatMessage: (message: string, workspacePath: string) =>
    ipcRenderer.invoke('chat:send-message', message, workspacePath),
  getChatSettings: () => ipcRenderer.invoke('chat:get-settings'),
  updateChatSettings: (config: { apiKey: string; baseURL: string; model: string }) =>
    ipcRenderer.invoke('chat:update-settings', config),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  onChatStream: (callback: (data: { token: string }) => void) => {
    const handler = (_e: unknown, data: { token: string }) => callback(data)
    ipcRenderer.on('chat:stream', handler)
    return () => ipcRenderer.off('chat:stream', handler)
  },
  onChatComplete: (callback: (data: { message: string }) => void) => {
    const handler = (_e: unknown, data: { message: string }) => callback(data)
    ipcRenderer.on('chat:complete', handler)
    return () => ipcRenderer.off('chat:complete', handler)
  },
  onChatError: (callback: (data: { error: string }) => void) => {
    const handler = (_e: unknown, data: { error: string }) => callback(data)
    ipcRenderer.on('chat:error', handler)
    return () => ipcRenderer.off('chat:error', handler)
  },

  // Day 5 新增：工具调用生命周期
  onChatToolCall: (callback: (data: { id: string; name: string; args: string }) => void) => {
    const handler = (_e: unknown, data: { id: string; name: string; args: string }) => callback(data)
    ipcRenderer.on('chat:tool-call', handler)
    return () => ipcRenderer.off('chat:tool-call', handler)
  },
  onChatToolResult: (callback: (data: { id: string; result: string; isError: boolean }) => void) => {
    const handler = (_e: unknown, data: { id: string; result: string; isError: boolean }) => callback(data)
    ipcRenderer.on('chat:tool-result', handler)
    return () => ipcRenderer.off('chat:tool-result', handler)
  },
})
```

#### D. 这段代码做了什么
- 5 个 `on*` 函数都返回 `unsubscribe`：调用方在 `useEffect` 卸载时调它，避免事件累积泄漏。
- 每个 `on*` 内部用具名 `handler` 而非匿名箭头：因为 `ipcRenderer.off` 必须传**同一个引用**才能解绑。**对比反例**：内部 `ipcRenderer.on('xxx', (_, d) => callback(d))` + 返回 `() => ipcRenderer.off('xxx', /* ??? */)`——拿不到那个匿名函数的引用，解绑失败，导致每次组件挂载就泄漏一个 listener。

#### E. 立刻验证
DevTools console：
```js
typeof window.api.onChatToolCall    // 'function'
typeof window.api.onChatToolResult  // 'function'
```

---

### 5.11 步骤 11：`vite-env.d.ts` 类型扩展

#### A. 动机
让 renderer 端 TypeScript 知道新增的 API 签名和 `ToolCallInfo` 类型。

#### B. 你将要做的操作
打开 `src/vite-env.d.ts`，整文件替换。

#### C. 完整代码

*文件 `src/vite-env.d.ts`：*
```ts
/// <reference types="vite/client" />

declare module "*.css"

interface TerminalCommandResult {
  stdout: string
  stderr: string
  code: number
}

interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: "file" | "directory"
  children?: FileTreeNode[]
}

interface WorkspaceTreeResult {
  workspaceRoot: string
  tree: FileTreeNode[]
}

interface ChatMessageData {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  isStreaming?: boolean
  // Day 5 新增：关联的工具调用记录（仅 assistant 消息可能有）。
  toolCalls?: ToolCallInfo[]
}

// Day 5 新增：单条工具调用的展示信息。
interface ToolCallInfo {
  id: string
  name: string
  args: string                          // JSON 字符串
  status: "running" | "completed" | "error"
  result?: string
}

interface RendererApi {
  runCommand: (command: string) => Promise<TerminalCommandResult>
  getFileTree: () => Promise<WorkspaceTreeResult>
  readFile: (filePath: string) => Promise<string>

  // Day 5: 新增 workspacePath 参数
  sendChatMessage: (message: string, workspacePath: string) => Promise<void>
  getChatSettings: () => Promise<{ apiKey: string; baseURL: string; model: string } | null>
  updateChatSettings: (config: { apiKey: string; baseURL: string; model: string }) => Promise<void>
  clearChat: () => Promise<void>
  onChatStream: (callback: (data: { token: string }) => void) => () => void
  onChatComplete: (callback: (data: { message: string }) => void) => () => void
  onChatError: (callback: (data: { error: string }) => void) => () => void
  // Day 5 新增
  onChatToolCall: (callback: (data: { id: string; name: string; args: string }) => void) => () => void
  onChatToolResult: (callback: (data: { id: string; result: string; isError: boolean }) => void) => () => void
}

declare global {
  interface Window {
    api: RendererApi
  }
}
```

#### D. 这段代码做了什么
全部是类型层面的扩展。**无需 import**——`vite-env.d.ts` 是全局声明文件。

#### E. 立刻验证
保存后 `npm run dev`，TS 应当无新错误。

---

### 5.12 步骤 12：新增 `file-tree.store.ts`

#### A. 动机
详见 §4.7：把 workspaceRoot 提升到全局 store。

#### B. 你将要做的操作
新建 `src/stores/file-tree.store.ts`。

#### C. 完整代码

*文件 `src/stores/file-tree.store.ts`：*
```ts
/**
 * Day 5: 文件树全局状态。
 *
 * 把 workspaceRoot 从 FileExplorer 局部 state 提升到 Zustand store，
 * 让 useChat → sendMessage → 主进程工具能拿到工作区路径。
 */
import { create } from 'zustand'

interface FileTreeState {
  workspaceRoot: string
  setWorkspaceRoot: (root: string) => void
}

export const useFileTreeStore = create<FileTreeState>((set) => ({
  workspaceRoot: '',
  setWorkspaceRoot: (root) => set({ workspaceRoot: root }),
}))
```

#### D. 这段代码做了什么
最朴素的 Zustand store：一个状态 + 一个 setter。**对比写法**：把 workspaceRoot 直接塞进 `editor.store.ts` 也可工作；单独抽 `file-tree.store.ts` 是为了"职责单一"——以后文件树相关的全局态（展开节点、过滤词等）都往这里堆。

#### E. 立刻验证
本步骤无运行时影响（没人订阅）。

---

### 5.13 步骤 13：改造 `FileExplorer.tsx` 改用 store

#### A. 动机
把局部 `useState` 换成 store 订阅，让其他组件能读到 workspaceRoot。

#### B. 你将要做的操作
打开 `src/components/file-explorer/FileExplorer.tsx`，把头部 `useState<string>('')` 替换为 store 订阅。

#### C. 完整代码

*文件 `src/components/file-explorer/FileExplorer.tsx`（仅展示变更行附近，其余完全保持 Day 4 原样）：*
```tsx
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import FileTreeItem from './FileTreeItem'
import { useEditorStore } from '../../stores/editor.store'
import { useFileTreeStore } from '../../stores/file-tree.store'   // 新增 import

export default function FileExplorer() {
  // Day 5: workspaceRoot 改用全局 store。
  const { workspaceRoot, setWorkspaceRoot } = useFileTreeStore()
  const [treeNodes, setTreeNodes] = useState<FileTreeNode[]>([])
  const [isLoading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { openFilePath, setOpenFile } = useEditorStore()

  const loadTree = async () => {
    setLoading(true)
    setErrorMessage(null)
    try {
      const result = await window.api.getFileTree()
      setWorkspaceRoot(result.workspaceRoot)        // 写到全局 store
      setTreeNodes(result.tree)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件树失败。'
      setErrorMessage(message)
    } finally {
      setLoading(false)
    }
  }

  // ...handleOpenFile / useEffect / return JSX 保持 Day 4 原样不变...
}
```

#### D. 这段代码做了什么
仅 2 行变化：删 `const [workspaceRoot, setWorkspaceRoot] = useState('')`，加 `useFileTreeStore()` 解构。**对比写法**：保留局部 state 同时调 store setter（双写）也行，但容易不同步——用 Zustand 取代后保持单一来源。

#### E. 立刻验证
点击侧栏文件夹应当照旧打开/刷新；DevTools console：
```js
window.useFileTreeStore?.getState()   // (Zustand 默认不挂 window，可在 store 里临时挂)
```

---

### 5.14 步骤 14：改造 `chat.store.ts` 加工具调用 actions

#### A. 动机
新增 `handleToolCall` 与 `handleToolResult`，维护最后一条 assistant 消息的 `toolCalls` 数组。

#### B. 你将要做的操作
打开 `src/stores/chat.store.ts`，整文件替换（80% 以上修改）。

#### C. 完整代码

*文件 `src/stores/chat.store.ts`：*
```ts
import { create } from "zustand"

interface ChatState {
  messages: ChatMessageData[]
  isStreaming: boolean
  currentStreamText: string

  sendMessage: (content: string, workspacePath: string) => Promise<void>
  appendToken: (token: string) => void
  handleComplete: (fullText: string) => void
  handleError: (error: string) => void
  newConversation: () => void
  // Day 5 新增
  handleToolCall: (info: { id: string; name: string; args: string }) => void
  handleToolResult: (info: { id: string; result: string; isError: boolean }) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  currentStreamText: "",

  sendMessage: async (content, workspacePath) => {
    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(), role: "user", content, timestamp: Date.now(),
    }
    const assistantMsg: ChatMessageData = {
      id: crypto.randomUUID(), role: "assistant", content: "", timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],                                  // 初始化空数组
    }
    set((state) => ({
      messages: [...state.messages, userMsg, assistantMsg],
      isStreaming: true,
      currentStreamText: "",
    }))
    try {
      await window.api.sendChatMessage(content, workspacePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      get().handleError(message)
    }
  },

  appendToken: (token) => {
    set((state) => {
      const newStreamText = state.currentStreamText + token
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = { ...messages[lastIdx], content: newStreamText }
      }
      return { messages, currentStreamText: newStreamText }
    })
  },

  // Day 5: 不再覆盖 content（因流式文本已被 appendToken 写入），仅切 isStreaming
  handleComplete: () => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = { ...messages[lastIdx], isStreaming: false }
      }
      return { messages, isStreaming: false, currentStreamText: "" }
    })
  },

  handleError: (error) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = {
          ...messages[lastIdx], content: `错误：${error}`, isStreaming: false,
        }
      }
      return { messages, isStreaming: false, currentStreamText: "" }
    })
  },

  newConversation: () => {
    window.api.clearChat()
    set({ messages: [], isStreaming: false, currentStreamText: "" })
  },

  /** 工具调用开始：在最后一条 assistant 消息的 toolCalls 数组追加一条 running 记录。 */
  handleToolCall: (info) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === "assistant") {
        const prev = messages[lastIdx]
        const newToolCall: ToolCallInfo = {
          id: info.id, name: info.name, args: info.args, status: "running",
        }
        messages[lastIdx] = {
          ...prev,
          toolCalls: [...(prev.toolCalls ?? []), newToolCall],
        }
      }
      return { messages }
    })
  },

  /** 工具调用完成：按 id 查找记录，更新 status 与 result。 */
  handleToolResult: (info) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === "assistant") {
        const prev = messages[lastIdx]
        const updated = (prev.toolCalls ?? []).map((tc) =>
          tc.id === info.id
            ? { ...tc, status: info.isError ? ("error" as const) : ("completed" as const), result: info.result }
            : tc,
        )
        messages[lastIdx] = { ...prev, toolCalls: updated }
      }
      return { messages }
    })
  },
}))
```

#### D. 这段代码做了什么
- **`handleComplete` 简化**：Day 4 是 `content: fullText`，Day 5 改成只切 `isStreaming`——因为流式 token 已被 `appendToken` 累计写入 `content`，覆盖反而会丢失中间 markdown 状态。
- **`handleToolCall`**：在最后一条 assistant 的 `toolCalls` 末尾 push 一条 `status:'running'`。注意要 `[...(prev.toolCalls ?? [])]` 不可变更新，否则 React 检测不到变化。
- **`handleToolResult`**：用 `id` 做主键查找——即使工具乱序完成（异步并行场景）也不会错配。
- **对比反例**：若 `prev.toolCalls.push(newToolCall)`（直接 mutate），Zustand 会把它当成同一引用，`subscribe` 不触发，UI 不重渲染。
- **`isError ? "error" as const : "completed" as const`**：`as const` 让 TS 推导成字面量类型而非宽 string，与 `ToolCallInfo.status` 严格对齐。

#### E. 立刻验证
本步骤是数据层，没人调它就看不到效果，下一步会接上。

---

### 5.15 步骤 15：改造 `useChat.ts` hook

#### A. 动机
订阅 2 个新 IPC 通道，并从 file-tree store 读 workspaceRoot 透传给 sendMessage。

#### B. 你将要做的操作
打开 `src/hooks/useChat.ts`，整文件替换。

#### C. 完整代码

*文件 `src/hooks/useChat.ts`：*
```ts
/**
 * Day 5: useChat Hook（扩展版）。
 *
 * 相较 Day 4，新增两个事件监听：
 * - onChatToolCall  → handleToolCall
 * - onChatToolResult → handleToolResult
 */
import { useEffect, useCallback } from "react"
import { useChatStore } from "../stores/chat.store"
import { useFileTreeStore } from "../stores/file-tree.store"

export function useChat() {
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const newConversation = useChatStore((s) => s.newConversation)
  const workspaceRoot = useFileTreeStore((s) => s.workspaceRoot)

  useEffect(() => {
    const unsub1 = window.api.onChatStream((data) => {
      useChatStore.getState().appendToken(data.token)
    })
    const unsub2 = window.api.onChatComplete((data) => {
      useChatStore.getState().handleComplete(data.message)
    })
    const unsub3 = window.api.onChatError((data) => {
      useChatStore.getState().handleError(data.error)
    })
    const unsub4 = window.api.onChatToolCall((data) => {
      useChatStore.getState().handleToolCall(data)
    })
    const unsub5 = window.api.onChatToolResult((data) => {
      useChatStore.getState().handleToolResult(data)
    })
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5() }
  }, [])

  const send = useCallback(
    async (content: string) => {
      await sendMessage(content, workspaceRoot ?? process.cwd())
    },
    [sendMessage, workspaceRoot],
  )

  return { sendMessage: send, isStreaming, newConversation }
}
```

#### D. 这段代码做了什么
- **`useEffect(..., [])`** 空依赖：5 个订阅在挂载时一次注册、卸载时一次解绑——同 Day 4。**对比反例**：把 `workspaceRoot` 加进依赖数组，每次工作区变化都重新订阅，会泄漏、且短时间内可能漏掉事件。
- **`useChatStore.getState()`** 而非订阅：在事件 handler 里只需要"调一下 action"，不需要让 hook 重新执行；用 `getState()` 拿当前 state 是 Zustand 推荐做法。
- **`workspaceRoot ?? process.cwd()`**：在 Electron renderer 里 `process` 是可用的（contextIsolation 下取决于配置），兜底防止初次加载 store 还没填时拿到空字符串导致工具拒绝执行。

#### E. 立刻验证
DevTools React DevTools → 找到 `ChatPanel` → useChat 状态正常。

---

### 5.16 步骤 16：新增 `ToolCallBlock.tsx`

#### A. 动机
工具调用的可视化卡片：折叠状态显示标题 + 状态徽章；展开显示参数 / 结果。

#### B. 你将要做的操作
新建 `src/components/chat/ToolCallBlock.tsx`。

#### C. 完整代码

*文件 `src/components/chat/ToolCallBlock.tsx`：*
```tsx
/**
 * Day 5: ToolCallBlock 组件——展示单次工具调用的状态与结果。
 */
import { useState } from 'react'
import { Wrench, ChevronRight, ChevronDown, Loader2, Check, X } from 'lucide-react'

interface Props {
  toolCall: ToolCallInfo
}

const STATUS_CONFIG = {
  running:   { label: '执行中', color: 'text-blue-400',  bgColor: 'bg-blue-400/10',  Icon: Loader2, spin: true  },
  completed: { label: '完成',   color: 'text-green-400', bgColor: 'bg-green-400/10', Icon: Check,   spin: false },
  error:     { label: '失败',   color: 'text-red-400',   bgColor: 'bg-red-400/10',   Icon: X,       spin: false },
} as const

export default function ToolCallBlock({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false)
  const config = STATUS_CONFIG[toolCall.status]

  // 尝试格式化参数 JSON，失败保留原字符串。
  let formattedArgs = toolCall.args ?? ''
  try {
    if (formattedArgs) formattedArgs = JSON.stringify(JSON.parse(formattedArgs), null, 2)
  } catch { /* keep raw */ }

  return (
    <div className="rounded border border-[var(--border)] overflow-hidden text-xs my-1">
      {/* 折叠栏头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={11} className="text-gray-500 flex-shrink-0" />
          : <ChevronRight size={11} className="text-gray-500 flex-shrink-0" />}
        <Wrench size={11} className="text-gray-400 flex-shrink-0" />
        <span className="font-mono font-medium text-gray-200 truncate flex-1">
          {toolCall.name}
        </span>
        <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${config.color} ${config.bgColor} flex-shrink-0`}>
          <config.Icon size={10} className={config.spin ? 'animate-spin' : ''} />
          {config.label}
        </span>
      </button>

      {/* 折叠内容 */}
      {expanded && (
        <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
          {formattedArgs && (
            <div className="px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">参数</p>
              <pre className="bg-[var(--bg-primary)] rounded p-2 overflow-x-auto text-gray-400 whitespace-pre-wrap break-all leading-relaxed">
                {formattedArgs}
              </pre>
            </div>
          )}
          {toolCall.result != null && (
            <div className="px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">结果</p>
              <pre className="bg-[var(--bg-primary)] rounded p-2 overflow-x-auto text-gray-400 whitespace-pre-wrap break-all leading-relaxed max-h-[200px]">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

#### D. 这段代码做了什么
- **`STATUS_CONFIG` + `as const`**：让 TS 把 label / color 都推成字面量类型，`config.Icon` 是有效组件类型而非 `unknown`。
- **`<config.Icon />`**：组件名首字母大写——在 JSX 里点访问的属性必须以大写开头才被识别为组件而非 HTML 标签。
- **`whitespace-pre-wrap break-all`**：保留 JSON 缩进同时允许超长无空格字符串折行——例如长路径。
- **`max-h-[200px]`**：结果框限高，避免一个长文件内容把整个 ChatPanel 撑爆。
- **对比写法**：用 `<details>/<summary>` 原生标签也能折叠，更朴素，但样式不好对齐图标——所以手写 `useState` 控制。

#### E. 立刻验证
此时 ChatMessage 还没渲染它，下一步会接上。

---

### 5.17 步骤 17：改造 `ChatMessage.tsx` 渲染 toolCalls

#### A. 动机
在 assistant 气泡下方追加 `toolCalls.map(tc => <ToolCallBlock>)`；流式光标条件改为 `&& !toolCalls?.length`。

#### B. 你将要做的操作
打开 `src/components/chat/ChatMessage.tsx`，整文件替换。

#### C. 完整代码

*文件 `src/components/chat/ChatMessage.tsx`：*
```tsx
import { User, Bot } from "lucide-react"
import ToolCallBlock from "./ToolCallBlock"

interface ChatMessageProps {
  message: ChatMessageData
}

/**
 * Day 5: 单条消息渲染（新增工具调用块展示）。
 */
export default function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user"
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit",
  })

  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-gray-500 bg-surface rounded px-3 py-1.5 max-w-[90%]">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${
        isUser ? "bg-blue-600" : "bg-surface"
      }`}>
        {isUser
          ? <User size={14} className="text-white" />
          : <Bot size={14} className="text-blue-400" />}
      </div>

      <div className={`flex-1 min-w-0 ${isUser ? "flex flex-col items-end" : ""}`}>
        <div className={`inline-block max-w-full text-left rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-surface" : ""
        }`}>
          <p className="text-foreground whitespace-pre-wrap break-words">{message.content}</p>
          {message.isStreaming && !message.toolCalls?.length && (
            <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-middle rounded-sm" />
          )}
        </div>

        {/* Day 5 新增：工具调用块列表 */}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="w-full mt-2 space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallBlock key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        <p className="text-[10px] text-gray-600 mt-1 select-none">{time}</p>
      </div>
    </div>
  )
}
```

#### D. 这段代码做了什么
- **`!message.toolCalls?.length`**：当模型本回合是纯工具调用（content 为空、有 toolCalls），不显示文字光标——避免空气泡下方一个孤零零闪烁的光标。
- **`key={tc.id}`**：用模型生成的 `id` 作 key，避免重渲染时 React 错配 DOM 状态（如展开/折叠状态）。
- **对比反例**：用 `key={index}` 时若工具调用乱序完成（虽然本日不会），React 会复用 DOM 节点导致 expanded 状态串台。

#### E. 立刻验证
现在可以端到端跑了：
1. 配置 LLM；
2. 输入"列出当前目录" → 看到 `list_files` 工具块依次出现 / 完成；
3. 展开看到参数与结果。

---

### 5.18 步骤 18：`TerminalInstance.tsx` 改欢迎语

#### A. 动机
仅文案。

#### B. 你将要做的操作
打开 `src/components/terminal/TerminalInstance.tsx`，把 `terminal.writeln('Day 4 Terminal Ready')` 改成 `'Day 5 Terminal Ready'`。

#### C. 完整代码

*片段：*
```tsx
terminal.writeln('Day 5 Terminal Ready')
terminal.write(PROMPT)
```

#### D. 这段代码做了什么
仅文案。无可对比写法。

#### E. 立刻验证
启动后切到 Terminal 面板，第一行显示 "Day 5 Terminal Ready"。

---

## 6. 端到端串联走查

以"用户输入：列出当前工作区根目录的所有 ts 文件"为例，按真实事件链一跳一跳追踪。

### 第 1 跳：用户按下 Enter
- `ChatInput.tsx` 的 textarea `onKeyDown`：Enter（无 Shift）→ `event.preventDefault()` + `onSend(value)`。
- `ChatPanel.tsx` 的 `onSend` 回调：`sendMessage(content)`。
- `useChat.ts` 的 `send`：`await sendMessage(content, workspaceRoot ?? process.cwd())`。

### 第 2 跳：渲染层 store 写入占位消息
- `chat.store.ts` `sendMessage`：push 一条 user 气泡 + 一条空的 assistant 气泡（`isStreaming:true, toolCalls:[]`），React 立刻重渲染。
- 接着 `await window.api.sendChatMessage(content, workspacePath)` → preload → `ipcRenderer.invoke('chat:send-message', content, workspacePath)`。

### 第 3 跳：主进程 handle
- `chat.ipc.ts` `ipcMain.handle('chat:send-message', ...)`：拿到 `event.sender` → `chatService.sendMessage(message, workspacePath, callbacks)`。

### 第 4 跳：第一轮 LLM 请求
- `chat.service.ts`：push user → 进 `while` 第 1 轮 → `provider.chat({messages, tools: registry.getToolDefinitions()})`。
- `openai.provider.ts`：构造 requestParams 携带 3 个工具定义 → SDK 发请求 → 收到第一个 chunk：`delta.tool_calls=[{index:0, id:'call_x', function:{name:'list_files', arguments:''}}]`。
- 立即 yield `tool_call_start` → service 触发 `callbacks.onToolCall('call_x', 'list_files', '')` → `safeSend(wc, 'chat:tool-call', {...})`。

### 第 5 跳：渲染层显示"执行中"
- `useChat` 订阅的 `onChatToolCall` handler 触发 → `chat.store.handleToolCall({...})`。
- 在最后一条 assistant 的 toolCalls 末尾 push `{status:'running'}` → React 重渲染 → `ToolCallBlock` 显示蓝色"执行中"徽章。

### 第 6 跳：拼装与执行
- 后续 chunks 不断追加 `arguments` 到 `activeToolCalls.get(0).arguments`（前端不感知）。
- 直到 chunk 携带 `finish_reason='tool_calls'` → provider yield `tool_call_end {function:{name:'list_files', arguments:'{"path":".","recursive":false}'}}`。
- service 把它 push 到 `completedToolCalls`，loop 结束 → `length>0` → push assistant 消息 + 遍历执行：`toolRegistry.execute('list_files', {path:'.', recursive:false}, {workspacePath})`。
- `list-files.tool.ts` 真实读盘 → 返回字符串。
- service `callbacks.onToolResult('call_x', result, false)` → `safeSend('chat:tool-result', {...})`。

### 第 7 跳：渲染层显示"完成"
- `chat.store.handleToolResult` → 找到 id=call_x 的记录 → status='completed' + result=... → React 重渲染 → 徽章变绿，结果区有内容。

### 第 8 跳：第二轮 LLM 请求
- service 已 push `{role:'tool', tool_call_id:'call_x', content:result}` → `iter=2` 重入 `while` → 再次 `provider.chat({messages, tools})`。
- 这次模型基于工具结果直接生成文字回答 → chunks 流式 yield `text_delta` → service 触发 `callbacks.onToken(token)` → `safeSend('chat:stream', {token})`。
- `chat.store.appendToken` 累加进最后一条 assistant 的 content → React 实时显示。

### 第 9 跳：完成
- chunks 结束 → loop 内 `completedToolCalls.length===0` → push assistant{content:assistantText} → `callbacks.onComplete(text)` → `safeSend('chat:complete', {message:text})`。
- `chat.store.handleComplete` 切 `isStreaming:false` → 光标消失。
- 同时第 3 跳的 `await ipcRenderer.invoke` 在主进程函数 return 后 resolve（无返回值），`chat.store.sendMessage` try 块完成。

---

## 7. 完整运行流程追踪

`npm run dev` 开始到首屏与首次工具调用。

### 7.1 进程启动
1. `npm run dev` → `electron-vite dev`：
   - vite 编译 main / preload / renderer 三端，分别落到 `out/main`、`out/preload`、`out/renderer`；
   - 启动 dev server 给 renderer（HMR）；
   - 启动 electron 进程加载 `out/main/main.js`。
2. `electron/main.ts` 创建 BrowserWindow，加载 dev server URL → renderer 启动。

### 7.2 IPC 注册时机
- `main.ts` 在 `app.whenReady()` 后调 `registerAllIpcHandlers()`（来自 `electron/ipc/index.ts`），其中 `registerChatIpcHandlers()` 在模块加载时**会执行 `chat.service.ts` 的顶层 `toolRegistry.register(...)` × 3**——三个工具注册到全局单例完成。
- 同时 `chatService.loadSettings()` 异步读 `userData/chat-settings.json`，若存在则 `new OpenAIProvider(config)`。

### 7.3 首次工具调用时序
- 用户输入 → renderer `invoke('chat:send-message', msg, ws)` → main `handle` → `chatService.sendMessage`：
  1. 第 1 轮 `provider.chat`：HTTP `POST /v1/chat/completions` 携带 `tools` 数组，`stream:true`；
  2. SSE 服务器推 `data: {...}` 行，OpenAI SDK 解析为 chunk async iterable；
  3. 每个 chunk 经 `openai.provider.ts` switch 后 yield `text_delta` / `tool_call_start` / `tool_call_end`；
  4. service 把它转 `safeSend(wc, ...)` → renderer 接收 → store 更新 → React 重渲染（一帧内）；
  5. 第 1 轮结束如有 `completedToolCalls`：`toolRegistry.execute` 进入 `read-file.tool.ts` 等具体 `execute()`，`fs.readFile` 真实磁盘 I/O；
  6. `push {role:'tool', ...}` → 第 2 轮 → 重复 1-5；
  7. 直到某轮无工具调用 → `onComplete` → renderer 关闭光标 → `invoke` 链路 resolve。

整条链路核心在于 **async generator 把"分块 HTTP 响应"转成"可被 for-await 消费的事件流"**，且 service 用 `while` 把多轮请求串成一条线性调用，对外（renderer）感觉是"一次发送、流式回答"。

---

## 9. 自测清单

- [ ] `Set-Location .\GUIDE\day5; npm install; npm run dev` 能起来，无 TS 错误。
- [ ] 配置 LLM 后输入"列出当前工作区根目录" → 看到 `list_files` 工具块由蓝色"执行中"变绿色"完成"。
- [ ] 折叠/展开工具块，看到参数 JSON 与结果文本。
- [ ] 输入"读取 package.json 第 1~20 行" → 看到 `read_file` 工具块，结果是带行号的文本。
- [ ] 输入"在 src 下搜索 useFileTreeStore" → 看到 `search_files` 工具块，结果含 `fullPath:lineNum: line` 形式。
- [ ] 输入"读取 不存在.txt" → 看到 `read_file` 工具块变红色"失败"。
- [ ] 输入需要多步推理的请求（如"列出 ts 文件并读其中之一"）→ 看到多个工具块依次执行，最后一段文字总结。
- [ ] 故意把 apiKey 改错 → 一发消息出现 `chat:error`，UI 显示 "错误: ..."，不卡死。
- [ ] 流式输出过程中关闭窗口，主进程不报 `Object has been destroyed`。
- [ ] 切换文件树根目录后再发消息，工具能基于新工作区读文件。
- [ ] DevTools console `useChatStore.getState().messages.at(-1).toolCalls` 应返回最后一条 assistant 的工具调用数组。
- [ ] 验证 MAX_ITERATIONS：构造一个永远调工具的提示词，10 轮后应当看到 "已达到最大迭代次数 10" 错误。
- [ ] Day 1-4 全部既有功能（编辑器打开文件、终端跑命令、Chat 单纯对话、面板拖动、侧栏折叠、设置持久化）正常。
- [ ] 关闭重启应用，配置仍在；新建对话能清空历史。
- [ ] 主进程不应有未捕获的 Promise rejection（DevTools Console 主进程日志区无红字）。


# Day 6：AgentLoop——把 Agent 主循环抽出来

## 0. 前言

Day 5 把工具调用接通了：模型说要 `read_file`，主进程真的去读，结果回喂给模型。但那时的"循环"还硬塞在 `chat.service.ts` 的 `sendMessage` 里——80 行的 `while`，又管 LLM 又管工具又管历史 push。Day 6 做三件事：

1. **抽出 `AgentLoop` 类**：把"推理→执行→再推理"的核心循环搬到独立文件，`ChatService` 退化为"配置/历史/转发"的薄壳。
2. **加 `write_file` 工具**：让 agent 第一次有"修改世界"的能力（之前 3 个工具都是只读）；同时落实**路径穿越严格校验**（用 `path.relative` + `..` 检查）。
3. **三类新事件**：`onThinking`（模型推理中、还没出字）、`onIteration`（轮次变化）、`abort()`（用户随时打断）；UI 上多出一个紫色"思考中"指示、一枚"轮次 N/M"徽章、一颗红色"取消"按钮。

§4 仅讲今日新概念：Agent 状态机分解 / 系统提示词的工程化 / `path.relative` 的路径穿越判定 / abort 标志位的协作式取消 / "思考中" vs "生成中" UI 双态划分。

---

## 1. 本日目标与产出

### 1.1 功能目标

1. 让模型自动多步推理：输入"在 src 下找出最大文件并把内容写到 `summary.md`" → 模型先 `list_files`、再 `read_file` 多次、最后 `write_file`，每一步在 ChatPanel 都有可视化卡片。
2. 顶栏出现"轮次 N/M"徽章（如 "轮次 3/10"）实时显示当前 agent 迭代到第几轮。
3. 模型在收到工具结果后、还没开始吐字时，底部状态条显示**紫色 BrainCircuit + "思考中..."**；一旦吐字立刻切换为蓝色 Loader2 + "生成中..."。
4. 顶栏多一颗红色"取消"按钮，长流程进行中点击立刻打断 agent，已完成的工具调用结果保留在消息里。
5. 新增 `write_file` 工具：能创建/覆盖工作区内任意文件；对工作区外的路径直接拒绝（"安全错误"）。
6. Day 1-5 全部功能保持工作。

### 1.2 工程目标

1. `electron/services/agent/agent-loop.ts` 单独承载循环；`chat.service.ts` 成为薄壳（持有 messages + 调度 AgentLoop）。
2. `AgentLoop` 接受 `LLMProvider + ToolRegistry` 注入（依赖反转），暴露 `run()` 与 `abort()`；`abort` 是协作式取消（while 顶部 + chunk 循环顶部各检查一次）。
3. 系统提示词工程化：`buildSystemPrompt(workspacePath)` 一次构建、注入到 messages 头，统一告知 agent "你是谁/有哪些工具/路径约定/行为准则"。
4. IPC 层新增 `chat:abort` invoke + `chat:thinking` / `chat:iteration` 两个推送通道；`onToolCallResult` 增补 `name` 字段（Day 5 漏带）。
5. 渲染层 `chat.store` 新增 `isThinking / iteration / maxIteration / abortChat` 字段与 actions；`useChat` 多两个 listener；`ChatPanel` 多三组 UI。

---

## 2. 先跑起来（Smoke Run）

```powershell
Set-Location .\GUIDE\day6
npm install
npm run dev
```

配置 LLM（同 Day 5）。然后：

1. 点 💬 → 输入"列出 src 下所有 ts 文件，找出行数最多的那个并复述前 30 行" → 看到顶栏"轮次 1/10 → 2/10 → 3/10"递增；底栏紫色"思考中..." ↔ 蓝色"生成中..."切换；多个 ToolCallBlock 依次完成。
2. 输入"创建一个 `notes/today.md`，内容是 'hello day6'" → 看到 `write_file` 工具块完成；切到 FileExplorer 刷新，能看到新文件。
3. 输入"把 `/etc/passwd` 写入 hello" → `write_file` 工具块标红，结果区显示"安全错误：不允许写入工作区目录之外的文件"。
4. 发起一个明显费时的请求（如"列出 src 所有目录并依次读取每个 ts 文件的全部内容并汇总"）→ 进行中点红色"取消" → 流立刻停止，已完成的工具块保留，最后一条 assistant 消息进入"已完成"状态。

---

## 3. 项目结构与变更总览

### 3.1 项目目录树（ASCII）

```text
day6/
├─ electron/
│  ├─ preload.ts                                     # 修改：+abortChat / +onChatThinking / +onChatIteration
│  ├─ ipc/chat.ipc.ts                                # 修改：+chat:abort / +safeSend('chat:thinking') / +chat:iteration
│  └─ services/
│     └─ agent/
│        ├─ chat.service.ts                          # 修改：薄壳化，循环逻辑搬出去
│        ├─ agent-loop.ts                            # 新增：AgentLoop 类（系统提示 + while + abort）
│        └─ tools/
│           └─ write-file.tool.ts                    # 新增：覆盖写 + 路径穿越校验
├─ src/
│  ├─ vite-env.d.ts                                  # 修改：abortChat / onChatThinking / onChatIteration sigs
│  ├─ stores/chat.store.ts                           # 修改：+isThinking/iteration/maxIteration/abortChat
│  ├─ hooks/useChat.ts                               # 修改：+2 listeners +abortChat 暴露
│  ├─ components/
│  │  ├─ chat/ChatPanel.tsx                          # 修改：+轮次徽章 +取消按钮 +思考/生成双态指示
│  │  └─ terminal/TerminalInstance.tsx               # 修改：仅欢迎语 "Day 6"
└─ package.json                                      # 修改：仅 name/description
```

### 3.2 AgentLoop 状态机

```text
                ┌──────── ChatService.sendMessage(content, ws, callbacks)
                │           push user → new AgentLoop(provider, registry).run([...messages], ws, cbs)
                ▼
  ┌─── AgentLoop.run ─────────────────────────────────────────────────────────┐
  │  conversation = [system(workspacePath), ...initialMessages]               │
  │  fullText = ""                                                            │
  │                                                                           │
  │  for iter = 0..MAX_ITERATIONS:                                            │
  │    if aborted → onComplete(fullText); return                              │
  │    onIteration(iter+1, MAX)                                               │
  │    onThinking()                       ← 紫色 BrainCircuit                  │
  │                                                                           │
  │    stream = provider.chat({messages:conversation, tools, stream:true})    │
  │    for await chunk of stream:                                             │
  │      if aborted → break                                                   │
  │      switch chunk.type:                                                   │
  │        text_delta:        fullText += c; onToken(c)  ← isThinking=false   │
  │        tool_call_start:   onToolCallStart({id,name,args})                 │
  │        tool_call_end:     completedToolCalls.push(tc)                     │
  │        error:             onError; return                                 │
  │                                                                           │
  │    if aborted → onComplete(fullText); return                              │
  │    if completedToolCalls.length === 0:                                    │
  │      conversation.push({role:'assistant',content:currentText})            │
  │      onComplete(fullText); return                                         │
  │                                                                           │
  │    conversation.push({role:'assistant',content:currentText||null,         │
  │                       tool_calls:completedToolCalls})                     │
  │    for tc of completedToolCalls:                                          │
  │      if aborted → break                                                   │
  │      result = registry.execute(name, JSON.parse(args)||{}, {ws})          │
  │      onToolCallResult({id,name,result,isError})                           │
  │      conversation.push({role:'tool',tool_call_id:tc.id,content:result})   │
  │                                                                           │
  │  // 走出 for: 超过最大迭代                                                  │
  │  onError("已达到最大迭代次数 10 轮")                                        │
  └───────────────────────────────────────────────────────────────────────────┘
```

三个抽象关键点：
- **AgentLoop 不持有 IPC、不知道 webContents 存在**——它只跟回调对话；`ChatService` 把回调转发为 `safeSend`。
- **abort 标志位**：用户点取消时 `abort()` 把 `aborted=true`；循环里**两个检查点**（while 顶 + chunk 循环顶）确保最快退出，且**不抛异常**——抛异常 ChatService 没法区分"正常取消"与"真错"。
- **conversation vs initialMessages**：传入的 `initialMessages` 不动；AgentLoop 内部 `conversation` 是工作副本（系统提示 + 副本），循环结束后由 `ChatService` 决定要不要把 `assistant` 文字 push 回主历史。

### 3.3 编码步骤索引（依赖顺序）

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `package.json` | 修改 | 仅 name/description |
| 2 | `electron/services/agent/tools/write-file.tool.ts` | 新增 | write_file 工具 + 路径穿越校验 |
| 3 | `electron/services/agent/agent-loop.ts` | 新增 | AgentLoop + buildSystemPrompt |
| 4 | `electron/services/agent/chat.service.ts` | 修改 | 薄壳化 + abort + register write_file |
| 5 | `electron/ipc/chat.ipc.ts` | 修改 | +abort / +thinking / +iteration |
| 6 | `electron/preload.ts` | 修改 | +abortChat / +onChatThinking / +onChatIteration |
| 7 | `src/vite-env.d.ts` | 修改 | 补 sigs |
| 8 | `src/stores/chat.store.ts` | 修改 | +isThinking / iteration / abortChat |
| 9 | `src/hooks/useChat.ts` | 修改 | +2 listeners +abortChat |
| 10 | `src/components/chat/ChatPanel.tsx` | 修改 | +badge / +button / +双态指示 |
| 11 | `src/components/terminal/TerminalInstance.tsx` | 修改 | 仅欢迎语 |

依赖序：底层工具 → 主循环（用工具 registry 类型）→ service（用 AgentLoop）→ IPC（用 service）→ preload → 类型 → store → hook → 组件 → 文案。

---

## 4. 基础知识铺垫

### 4.1 Agent 状态机分解：Thinking / Streaming / ToolRunning

Day 5 我们只有"流式生成"一个状态：`isStreaming=true` 或 `false`。但真实 agent 一轮里依次经历：

```text
[Thinking]  模型在远端推理（HTTP 已发出，还没回第一个 chunk）
   ↓
[Streaming Text] 模型逐字吐 token
   ↓
[Tool Calling] 模型决定用工具，吐出 tool_call 结构
   ↓
[Tool Running] 主进程执行工具
   ↓ （结果回喂）
[Thinking] 第二轮推理...
```

UI 应当为每个状态给出独立反馈，否则用户面对 30 秒空白屏幕会以为程序死了。Day 6 引入：

- `isThinking`：`onThinking()` 触发 → `appendToken` / `handleToolCall` 都重置；
- `iteration`：`onIteration(cur,max)`；
- 工具卡片状态：`'running'|'completed'|'error'`（Day 5 已有）。

### 4.2 系统提示词的工程化

直接告诉用户问题的模型很容易乱来：传绝对路径、调不存在的工具、把"读"当成"写"。系统提示词是最便宜的对齐手段：

```text
你是 IDE 助手；当前工作区根：${ws}。
== 工具 ==
- list_files: 优先用于了解项目
- read_file: 修改前必读
- ...
== 准则 ==
1. 路径全部相对工作区根（不要 / 前缀）
2. 修改前先读
3. 用自然语言解释每一步
```

注意三个写法：
- **明确给"当前工作区根"字面量**：模型才能在大脑里"画"出文件结构；
- **路径约定写在最显眼位置**：例如 `path` 必须相对工作区——模型容易传 `/src/app.ts`，提前告知能减少错误；
- **行为指导写顺序**：先列工具、再列规则，模型注意力对前后文分布敏感。

### 4.3 `path.relative` 的路径穿越判定

Day 5 的 `resolvePath` 只削开头 `/` 不能挡 `..`。Day 6 写文件危险得多——必须严格判：

```ts
const absTarget = path.resolve(workspacePath, relativePath)
const rel = path.relative(workspacePath, absTarget)
if (rel.startsWith('..') || path.isAbsolute(rel)) reject()
```

`path.relative('/a/b', '/a/b/c')` → `'c'`；`path.relative('/a/b', '/x')` → `'..\\..\\x'`。开头是 `..` 就是"跳出工作区"。`path.isAbsolute(rel)` 处理 Windows 跨盘符（`D:` → `E:`）的极端情况，此时 `path.relative` 会返回绝对路径。

**对比反例**：用 `absTarget.startsWith(workspacePath)` 也行但有坑——`'/a/b'.startsWith('/a/bc')` 是 `false`，但 `'/a/bc'.startsWith('/a/b')` 是 `true`；必须 `+ path.sep` 才正确。`path.relative` 更简洁。

### 4.4 协作式取消（cooperative cancellation）

JavaScript 没有"杀线程"，要中断长任务只能让任务**自己定期检查"是否要停"**。模式：

```ts
private aborted = false
abort() { this.aborted = true }

async run() {
  while (...) {
    if (this.aborted) return         // 检查点 1
    for await (const c of stream) {
      if (this.aborted) break        // 检查点 2
      ...
    }
    if (this.aborted) return         // 检查点 3
    for (const tc of toolCalls) {
      if (this.aborted) break        // 检查点 4
      await registry.execute(...)
    }
  }
}
```

检查点越密集响应越快，但也意味着代码侵入越深。**对比写法**：用 `AbortController` + 把 signal 传到 `fetch` 真把网络请求掐断，更彻底；本日为简化只在 JS 控制流里检查（OpenAI SDK 流仍会读到底，但消费循环立刻退出，UI 已经停止变化）。

### 4.5 "Thinking" 与 "Streaming" 的 UI 区分

为什么不直接 "Streaming" 一个状态？因为：
- Thinking = 等远端，体感"没反应"——必须给指示；
- Streaming = 文字在涌，已经有反馈了——再给指示反而冗余。

实现：`onThinking` 把 `isThinking=true`；只要 `appendToken` 或 `handleToolCall` 触发就 `isThinking=false`（说明模型已经"动了"）。UI 用三元式：

```tsx
{isThinking ? <BrainCircuit pulse purple/> : <Loader2 spin blue/>}
```

---

## 5. 编码步骤

### 5.1 步骤 1：更新 `package.json`

#### A. 动机
仅元数据切到 Day 6；无新依赖。

#### B. 你将要做的操作
打开 `package.json`，改 `name` / `version` / `description`。

#### C. 完整代码
```json
{
  "name": "my-agent-ide-day6",
  "version": "1.0.0",
  "description": "Day 6: AgentLoop - Automated Multi-turn Agent Core",
  "main": "./out/main/index.js",
  ...其余字段与 Day 5 一致...
}
```

#### D. 这段代码做了什么
仅元数据。**对比写法**：保留 Day 5 名字也行，但与目录强对应便于校对。

#### E. 立刻验证
`npm install` 应当无新包下载。

---

### 5.2 步骤 2：新增 `write-file.tool.ts`

#### A. 动机
让 agent 第一次能"修改世界"；同时立路径穿越的红线。

#### B. 你将要做的操作
新建 `electron/services/agent/tools/write-file.tool.ts`。

#### C. 完整代码

*文件 `electron/services/agent/tools/write-file.tool.ts`：*
```ts
/**
 * Day 6: write_file 工具——向工作区文件写入内容（覆盖写）。
 *
 * 安全约束：目标路径必须在工作区根目录内，防止路径穿越攻击。
 * 父目录若不存在会自动 recursive mkdir。
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import type { AgentTool } from './tool-registry'

const writeFileTool: AgentTool = {
  name: 'write_file',
  description:
    '将指定内容写入工作区内的文件（覆盖写）。' +
    '文件不存在时自动创建，父目录也会自动创建。' +
    '修改已有文件前，请先用 read_file 读取原内容，避免意外覆盖。',

  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: '相对于工作区根目录的文件路径，例如 "src/utils/helpers.ts"' },
      content: { type: 'string', description: '要写入文件的完整文本内容' },
    },
    required: ['path', 'content'],
  },

  async execute(args, context): Promise<string> {
    const relativePath = String(args.path ?? '')
    const content = String(args.content ?? '')

    if (!relativePath) return JSON.stringify({ error: '参数 path 不能为空。' })

    // 路径穿越校验
    const absTarget = path.resolve(context.workspacePath, relativePath)
    const absWorkspace = path.resolve(context.workspacePath)
    const rel = path.relative(absWorkspace, absTarget)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return JSON.stringify({
        error: `安全错误：不允许写入工作区目录（${absWorkspace}）之外的文件。`,
      })
    }

    await fs.mkdir(path.dirname(absTarget), { recursive: true })
    await fs.writeFile(absTarget, content, 'utf-8')

    return `文件已成功写入：${rel}（${content.length} 字符）`
  },
}

export default writeFileTool
```

#### D. 这段代码做了什么
- **`description` 直接告诉模型"先 read 再 write"**：提示词工程的最小单位。
- **`String(args.path ?? '')`**：兜底——模型偶尔会传 `null` 或数字。
- **路径穿越**：详见 §4.3。
- **`fs.mkdir({recursive:true})`**：父目录不存在自动建；不需要 `fs.access` 先判断。**对比反例**：先 `if (!await fs.access(...)) await fs.mkdir(...)` 多出一次 I/O，且引入 TOCTOU 竞态。
- **错误用 JSON 字符串**：与其他工具一致，`AgentLoop` 用 `result.startsWith('{"error"')` 判错。

#### E. 立刻验证
此工具尚未注册到 registry，下一步注册后才能用。

---

### 5.3 步骤 3：新增 `agent-loop.ts`

#### A. 动机
把 Day 5 塞在 `chat.service.ts` 里 80 行的 `while` 循环抽出来——单一职责、可独立测试、未来 Day 7+ 可在不动 ChatService 的前提下扩展。

#### B. 你将要做的操作
新建 `electron/services/agent/agent-loop.ts`。

#### C. 完整代码

*文件 `electron/services/agent/agent-loop.ts`：*
```ts
/**
 * Day 6: AgentLoop——自动化智能体主循环。
 */
import type { LLMProvider, Message, ToolCall } from './providers/base.provider'
import type ToolRegistry from './tools/tool-registry'

export interface AgentLoopCallbacks {
  /** 模型开始生成（本轮尚无文字输出时触发，"思考中"状态）。 */
  onThinking(): void
  /** 模型流式输出文字 token。 */
  onToken(token: string): void
  /** 工具即将被调用。 */
  onToolCallStart(info: { id: string; name: string; args: string }): void
  /** 工具执行完毕。 */
  onToolCallResult(info: { id: string; name: string; result: string; isError: boolean }): void
  /** Agent 本次 run 正常结束。 */
  onComplete(fullText: string): void
  /** Agent 发生错误（含超过最大迭代）。 */
  onError(error: string): void
  /** 当前迭代轮次发生变化。 */
  onIteration(current: number, max: number): void
}

/**
 * 系统提示词工厂——告诉模型它是谁、有哪些工具、怎么用路径。
 */
function buildSystemPrompt(workspacePath: string): string {
  return `你是一个集成在代码编辑器中的 AI 编程助手，能够直接访问用户的工作区文件系统。

当前工作区根目录：${workspacePath}

== 工具使用规则 ==
- 所有工具调用中的文件路径均相对于上方工作区根目录（不要带 "/" 前缀）。
- 使用 "." 代表工作区根目录本身。
- 例：读取根目录下的 src/app.ts，传入 path 为 "src/app.ts"。

== 可用工具 ==
- list_files：列出目录结构，了解项目全貌时优先调用。
- read_file：读取文件内容（带行号），修改文件前必须先读取。
- search_files：在工作区中搜索文本，快速定位代码位置。
- write_file：将内容写入文件（覆盖写），如果文件不存在会自动创建。

== 行为准则 ==
1. 收到复杂任务时，先 list_files 了解项目结构，再决定读哪些文件。
2. 修改文件前，必须用 read_file 读取最新内容，避免覆盖用户手动修改。
3. 用自然语言解释你的每一步操作，帮助用户理解你的推理过程。
4. 如果不需要工具，直接给出文字回答即可，不要强行调用工具。`
}

export default class AgentLoop {
  private aborted = false
  readonly MAX_ITERATIONS = 10

  constructor(
    private readonly provider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  /** 中断当前正在执行的 run()。幂等。 */
  abort(): void {
    this.aborted = true
  }

  async run(
    initialMessages: Message[],
    workspacePath: string,
    callbacks: AgentLoopCallbacks,
  ): Promise<void> {
    this.aborted = false

    const conversation: Message[] = [
      { role: 'system', content: buildSystemPrompt(workspacePath) },
      ...initialMessages,
    ]

    let fullText = ''

    for (let iteration = 0; iteration < this.MAX_ITERATIONS; iteration++) {
      // 中断检查点 1：每轮开始
      if (this.aborted) {
        callbacks.onComplete(fullText)
        return
      }

      callbacks.onIteration(iteration + 1, this.MAX_ITERATIONS)
      callbacks.onThinking()

      const toolDefs = this.toolRegistry.getToolDefinitions()
      let currentText = ''
      const completedToolCalls: ToolCall[] = []

      const stream = this.provider.chat({
        messages: conversation,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        stream: true,
      })

      for await (const chunk of stream) {
        // 中断检查点 2：每个 chunk
        if (this.aborted) break

        switch (chunk.type) {
          case 'text_delta':
            if (chunk.content) {
              currentText += chunk.content
              fullText += chunk.content
              callbacks.onToken(chunk.content)
            }
            break
          case 'tool_call_start':
            if (chunk.toolCall?.id && chunk.toolCall.function?.name) {
              callbacks.onToolCallStart({
                id: chunk.toolCall.id,
                name: chunk.toolCall.function.name,
                args: chunk.toolCall.function.arguments ?? '',
              })
            }
            break
          case 'tool_call_end':
            if (chunk.toolCall?.id && chunk.toolCall.function) {
              completedToolCalls.push({
                id: chunk.toolCall.id,
                type: 'function',
                function: {
                  name: chunk.toolCall.function.name ?? '',
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

      // 中断检查点 3：消费完 chunk 后
      if (this.aborted) {
        callbacks.onComplete(fullText)
        return
      }

      // 终止条件：本轮无工具调用 → 结束
      if (completedToolCalls.length === 0) {
        conversation.push({ role: 'assistant', content: currentText })
        callbacks.onComplete(fullText)
        return
      }

      // 有工具调用：先 push assistant 含 tool_calls 的消息
      conversation.push({
        role: 'assistant',
        content: currentText || null,
        tool_calls: completedToolCalls,
      })

      // 依次执行工具
      for (const tc of completedToolCalls) {
        // 中断检查点 4：每个工具前
        if (this.aborted) break

        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          args = {}
        }

        const result = await this.toolRegistry.execute(
          tc.function.name,
          args,
          { workspacePath },
        )

        const isError =
          result.startsWith('{"error"') ||
          (result.includes('"error"') && result.startsWith('{'))

        callbacks.onToolCallResult({
          id: tc.id,
          name: tc.function.name,
          result,
          isError,
        })

        conversation.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        })
      }
    }

    callbacks.onError(
      `Agent 已达到最大迭代次数（${this.MAX_ITERATIONS} 轮）。请尝试将任务拆分为更小的步骤。`,
    )
  }
}
```

#### D. 这段代码做了什么
- **`AgentLoopCallbacks` 8 个回调**：注意比 Day 5 ChatCallbacks 多了 `onThinking` 与 `onIteration`；且 `onToolCallResult` 携带 `name`（Day 5 漏带，UI 没法显示哪个工具失败了）。
- **`buildSystemPrompt(ws)` 模块级函数**：纯函数，便于测试 / 复用；workspacePath 注入而非全局——多窗口将来支持时不会串台。
- **`conversation` 工作副本**：详见 §3.2 第三点。`...initialMessages` 浅拷贝够用——内部不会修改 message 对象本身。
- **4 个中断检查点**：详见 §4.4。
- **`onComplete(fullText)`** 即使中断也调用——让 ChatService 知道流结束、关 isStreaming。**对比反例**：中断不调 onComplete，UI 永远卡在"生成中"。
- **`provider.chat({tools: toolDefs.length > 0 ? toolDefs : undefined})`**：空数组某些兼容服务会 400，传 undefined 安全。
- **`isError` 判断有冗余**：`startsWith('{"error"')` 已够用，多写一个 `includes('"error"') && startsWith('{')` 是为兼容某些工具返回 `{"some":"x","error":"y"}` 的情况。

#### E. 立刻验证
保存后 `npm run dev`，TS 应在 `chat.service.ts` 报错（因为它还在用旧 API）——下一步修。

---

### 5.4 步骤 4：薄壳化 `chat.service.ts`

#### A. 动机
把循环逻辑搬走后，`ChatService` 退化为：① 持有/读写设置；② 持有 messages；③ 注册工具；④ 调度 AgentLoop；⑤ 转发 abort。

#### B. 你将要做的操作
打开 `electron/services/agent/chat.service.ts`，整文件替换。

#### C. 完整代码

*文件 `electron/services/agent/chat.service.ts`：*
```ts
/**
 * Day 6: ChatService —— 薄壳。
 *
 * 职责：
 *   - 设置持久化（API Key/baseURL/model）
 *   - 维护多轮对话历史 messages[]
 *   - 注册工具
 *   - 创建/调度 AgentLoop，转发 abort 信号
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import type { LLMProvider, ProviderConfig, Message } from './providers/base.provider'
import OpenAIProvider from './providers/openai.provider'
import ToolRegistry from './tools/tool-registry'
import readFileTool from './tools/read-file.tool'
import listFilesTool from './tools/list-files.tool'
import searchFilesTool from './tools/search.tool'
import writeFileTool from './tools/write-file.tool'                   // Day 6 新增
import AgentLoop, { type AgentLoopCallbacks } from './agent-loop'

export interface ChatCallbacks {
  onToken(token: string): void
  onThinking(): void
  onToolCallStart(info: { id: string; name: string; args: string }): void
  onToolCallResult(info: { id: string; name: string; result: string; isError: boolean }): void
  onComplete(fullText: string): void
  onError(error: string): void
  onIteration(current: number, max: number): void
}

export default class ChatService {
  private provider: LLMProvider | null = null
  private providerConfig: ProviderConfig | null = null
  private messages: Message[] = []
  private settingsPath: string
  private toolRegistry: ToolRegistry
  private currentLoop: AgentLoop | null = null

  constructor() {
    this.settingsPath = join(app.getPath('userData'), 'chat-settings.json')
    this.loadSettings()
    this.toolRegistry = new ToolRegistry()
    this.toolRegistry.register(readFileTool)
    this.toolRegistry.register(listFilesTool)
    this.toolRegistry.register(searchFilesTool)
    this.toolRegistry.register(writeFileTool)                          // Day 6 新增
  }

  getSettings(): ProviderConfig | null { return this.providerConfig }

  updateSettings(config: ProviderConfig): void {
    this.providerConfig = config
    this.provider = new OpenAIProvider(config)
    this.saveSettings()
  }

  clearMessages(): void { this.messages = [] }

  /** Day 6 新增：转发到当前 AgentLoop。无活动 loop 时静默。 */
  abort(): void { this.currentLoop?.abort() }

  async sendMessage(
    userContent: string,
    workspacePath: string,
    callbacks: ChatCallbacks,
  ): Promise<void> {
    if (!this.provider) {
      callbacks.onError('未配置 LLM Provider，请先在设置中填写 API Key 与模型名称。')
      return
    }

    this.messages.push({ role: 'user', content: userContent })

    this.currentLoop = new AgentLoop(this.provider, this.toolRegistry)

    const loopCallbacks: AgentLoopCallbacks = {
      onThinking:       () => callbacks.onThinking(),
      onToken:          (t) => callbacks.onToken(t),
      onToolCallStart:  (info) => callbacks.onToolCallStart(info),
      onToolCallResult: (info) => callbacks.onToolCallResult(info),
      onIteration:      (cur, max) => callbacks.onIteration(cur, max),
      onComplete: (fullText) => {
        // 只有产生了文字才 push 进主历史；纯工具调用最后一轮可能 fullText 为空
        if (fullText) this.messages.push({ role: 'assistant', content: fullText })
        callbacks.onComplete(fullText)
        this.currentLoop = null
      },
      onError: (error) => {
        callbacks.onError(error)
        this.currentLoop = null
      },
    }

    await this.currentLoop.run([...this.messages], workspacePath, loopCallbacks)
  }

  private loadSettings(): void {
    try {
      if (existsSync(this.settingsPath)) {
        const config = JSON.parse(readFileSync(this.settingsPath, 'utf-8')) as ProviderConfig
        this.providerConfig = config
        this.provider = new OpenAIProvider(config)
      }
    } catch { /* ignore */ }
  }

  private saveSettings(): void {
    if (!this.providerConfig) return
    try {
      const dir = dirname(this.settingsPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.settingsPath, JSON.stringify(this.providerConfig, null, 2), 'utf-8')
    } catch { /* ignore */ }
  }
}
```

#### D. 这段代码做了什么
- **`new AgentLoop` per request**：每次请求新建实例——`aborted` 标志位天然隔离，不会出现"上次取消污染本次"的 bug。**对比写法**：复用同一个 `AgentLoop` 实例，每次 `run` 内部 `this.aborted=false` 重置——也行，本日选择前者更纯净。
- **`[...this.messages]` 浅拷贝**：传入 AgentLoop 后，AgentLoop 内部 push 进 conversation 副本不会污染外部 messages；**主历史只在最终 onComplete 时 push 一条简单 assistant**——避免 messages 里堆积 tool / tool_calls 的中间结构（这些是"过程"，非用户视角的对话）。
- **`onComplete` 里 `if (fullText) push`**：模型可能在最后一轮没说话（例如循环超时），不 push 空消息防止下次请求时上下文里有空 assistant 让模型困惑。
- **`onError` 不 push**：错误已经显示在 UI 上，不污染历史。
- **`this.currentLoop = null`**：完成/错误时清，让 abort() 在请求间静默。

#### E. 立刻验证
`npm run dev`，TS 应当全绿。DevTools console：
```js
await window.api.sendChatMessage('你好', '/some/path')   // 行为应与 Day 5 一致
```

---

### 5.5 步骤 5：改造 `chat.ipc.ts`

#### A. 动机
新增 `chat:abort` invoke + 两个推送通道（thinking / iteration）；`onToolCallResult` 补 `name` 字段。

#### B. 你将要做的操作
打开 `electron/ipc/chat.ipc.ts`，整文件替换。

#### C. 完整代码

*文件 `electron/ipc/chat.ipc.ts`：*
```ts
/**
 * Day 6: Chat IPC（扩展版）。
 */
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import ChatService from '../services/agent/chat.service'

const chatService = new ChatService()

export function registerChatIpcHandlers(): void {
  // 防止 HMR 重复注册
  ipcMain.removeHandler('chat:send-message')
  ipcMain.removeHandler('chat:abort')
  ipcMain.removeHandler('chat:get-settings')
  ipcMain.removeHandler('chat:update-settings')
  ipcMain.removeHandler('chat:clear')

  ipcMain.handle(
    'chat:send-message',
    async (event: IpcMainInvokeEvent, message: string, workspacePath: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return

      const safeSend = (channel: string, data: Record<string, unknown>): void => {
        if (!win.isDestroyed()) win.webContents.send(channel, data)
      }

      await chatService.sendMessage(message, workspacePath, {
        onToken:          (token)   => safeSend('chat:stream', { token }),
        onThinking:       ()        => safeSend('chat:thinking', {}),
        onComplete:       (text)    => safeSend('chat:complete', { message: text }),
        onError:          (err)     => safeSend('chat:error', { error: err }),
        onToolCallStart:  (info)    => safeSend('chat:tool-call', info),
        onToolCallResult: (info)    => safeSend('chat:tool-result', info),
        onIteration:      (cur, max) => safeSend('chat:iteration', { current: cur, max }),
      })
    },
  )

  ipcMain.handle('chat:abort', () => {
    chatService.abort()
  })

  ipcMain.handle('chat:get-settings', () => chatService.getSettings())

  ipcMain.handle('chat:update-settings', (_e, config: { apiKey: string; baseURL: string; model: string }) => {
    chatService.updateSettings(config)
  })

  ipcMain.handle('chat:clear', () => {
    chatService.clearMessages()
  })
}
```

#### D. 这段代码做了什么
- **`removeHandler` × 5**：electron-vite HMR 会重新执行此模块，重复 `ipcMain.handle` 同一通道会 throw `Attempted to register a second handler`。
- **`BrowserWindow.fromWebContents(event.sender)`** 取窗口、用 `win.isDestroyed()` 判：比 Day 5 的 `wc.isDestroyed()` 多一层保险——如果窗口已关 BrowserWindow.fromWebContents 会返回 null，提前退出。
- **`onToolCallStart` 整 info 透传**：Day 5 是 `(id,name,args)` 三个参数，Day 6 改成 `info` 对象——payload 形态与 IPC 通道一致，避免在 service 拆开又在 IPC 拼回。
- **`safeSend` 闭包内定义**：每次 invoke 都重新生成，引用 win 局部——并发请求互不干扰。

#### E. 立刻验证
DevTools console:
```js
await window.api.abortChat()        // 应当立刻 resolve、无错
```

---

### 5.6 步骤 6：`preload.ts` 暴露新 API

#### A. 动机
让 renderer 能调 `abortChat`、订阅 `onChatThinking` / `onChatIteration`。

#### B. 你将要做的操作
打开 `electron/preload.ts`，整文件替换。

#### C. 完整代码

*文件 `electron/preload.ts`：*
```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Day 2-3
  runCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command),
  getFileTree: () => ipcRenderer.invoke('file-system:get-tree'),
  readFile: (filePath: string) => ipcRenderer.invoke('file-system:read-file', filePath),

  // Chat
  sendChatMessage: (message: string, workspacePath: string) =>
    ipcRenderer.invoke('chat:send-message', message, workspacePath),
  abortChat: () => ipcRenderer.invoke('chat:abort'),                                  // Day 6 新增
  getChatSettings: () => ipcRenderer.invoke('chat:get-settings'),
  updateChatSettings: (config: { apiKey: string; baseURL: string; model: string }) =>
    ipcRenderer.invoke('chat:update-settings', config),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  onChatStream: (callback: (data: { token: string }) => void) => {
    const handler = (_e: IpcRendererEvent, data: { token: string }) => callback(data)
    ipcRenderer.on('chat:stream', handler)
    return () => { ipcRenderer.removeListener('chat:stream', handler) }
  },
  onChatComplete: (callback: (data: { message: string }) => void) => {
    const handler = (_e: IpcRendererEvent, data: { message: string }) => callback(data)
    ipcRenderer.on('chat:complete', handler)
    return () => { ipcRenderer.removeListener('chat:complete', handler) }
  },
  onChatError: (callback: (data: { error: string }) => void) => {
    const handler = (_e: IpcRendererEvent, data: { error: string }) => callback(data)
    ipcRenderer.on('chat:error', handler)
    return () => { ipcRenderer.removeListener('chat:error', handler) }
  },
  onChatToolCall: (callback: (data: { id: string; name: string; args: string }) => void) => {
    const handler = (_e: IpcRendererEvent, data: { id: string; name: string; args: string }) =>
      callback(data)
    ipcRenderer.on('chat:tool-call', handler)
    return () => { ipcRenderer.removeListener('chat:tool-call', handler) }
  },
  onChatToolResult: (callback: (data: { id: string; name: string; result: string; isError: boolean }) => void) => {
    const handler = (_e: IpcRendererEvent, data: { id: string; name: string; result: string; isError: boolean }) =>
      callback(data)
    ipcRenderer.on('chat:tool-result', handler)
    return () => { ipcRenderer.removeListener('chat:tool-result', handler) }
  },
  // Day 6 新增
  onChatThinking: (callback: () => void) => {
    const handler = (_e: IpcRendererEvent) => callback()
    ipcRenderer.on('chat:thinking', handler)
    return () => { ipcRenderer.removeListener('chat:thinking', handler) }
  },
  onChatIteration: (callback: (data: { current: number; max: number }) => void) => {
    const handler = (_e: IpcRendererEvent, data: { current: number; max: number }) =>
      callback(data)
    ipcRenderer.on('chat:iteration', handler)
    return () => { ipcRenderer.removeListener('chat:iteration', handler) }
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
```

#### D. 这段代码做了什么
- **`onChatThinking` 不带 payload**：协议本身是"事件"而非"数据"——纯通知。
- **`abortChat` 用 `invoke` 而非 `send`**：得到 promise 让前端能 await 完成确认；虽然 main 端 handle 是同步逻辑，invoke 仍能正确 resolve。
- 其他模式与 Day 5 一致：每个 on* 用具名 handler 配 `removeListener` 解绑。

#### E. 立刻验证
DevTools console：
```js
typeof window.api.abortChat        // 'function'
typeof window.api.onChatThinking   // 'function'
typeof window.api.onChatIteration  // 'function'
```

---

### 5.7 步骤 7：`vite-env.d.ts` 补类型

#### A. 动机
让 TS 知道新 API 形态，否则 `chat.store` 调 `window.api.abortChat()` 会红线。

#### B. 你将要做的操作
打开 `src/vite-env.d.ts`，在 `RendererApi` 接口里追加 3 个签名。

#### C. 完整代码

*文件 `src/vite-env.d.ts`（仅展示 RendererApi 内变更）：*
```ts
interface RendererApi {
  runCommand: (command: string) => Promise<TerminalCommandResult>
  getFileTree: () => Promise<WorkspaceTreeResult>
  readFile: (filePath: string) => Promise<string>

  sendChatMessage: (message: string, workspacePath: string) => Promise<void>
  abortChat: () => Promise<void>                                                       // Day 6 新增
  getChatSettings: () => Promise<{ apiKey: string; baseURL: string; model: string } | null>
  updateChatSettings: (config: { apiKey: string; baseURL: string; model: string }) => Promise<void>
  clearChat: () => Promise<void>

  onChatStream: (callback: (data: { token: string }) => void) => () => void
  onChatComplete: (callback: (data: { message: string }) => void) => () => void
  onChatError: (callback: (data: { error: string }) => void) => () => void
  onChatToolCall: (callback: (data: { id: string; name: string; args: string }) => void) => () => void
  // Day 6: result payload 增加 name 字段
  onChatToolResult: (callback: (data: { id: string; name: string; result: string; isError: boolean }) => void) => () => void
  // Day 6 新增
  onChatThinking: (callback: () => void) => () => void
  onChatIteration: (callback: (data: { current: number; max: number }) => void) => () => void
}
```

#### D. 这段代码做了什么
仅类型层。注意 `onChatToolResult` 的 payload 形态从 Day 5 的 `{id,result,isError}` 加上了 `name` —— 让 store 在 result 回来时知道"哪个工具完成了"，UI 可在卡片标题以工具名为区分（Day 5 已经在 `handleToolCall` 阶段记下 name；name 在 result payload 里冗余是为了 IPC 自洽，事件可独立解释）。

#### E. 立刻验证
TS 全绿。

---

### 5.8 步骤 8：`chat.store.ts` 加新状态

#### A. 动机
渲染层需要 3 个新状态字段（`isThinking / iteration / maxIteration`）+ 3 个新 action（`handleThinking / handleIteration / abortChat`）。

#### B. 你将要做的操作
打开 `src/stores/chat.store.ts`，整文件替换。

#### C. 完整代码

*文件 `src/stores/chat.store.ts`：*
```ts
import { create } from 'zustand'

interface ChatState {
  messages: ChatMessageData[]
  isStreaming: boolean
  currentStreamText: string
  // Day 6 新增
  isThinking: boolean
  iteration: number
  maxIteration: number

  sendMessage: (content: string, workspacePath: string) => Promise<void>
  appendToken: (token: string) => void
  handleComplete: (fullText: string) => void
  handleError: (error: string) => void
  newConversation: () => void
  handleToolCall: (info: { id: string; name: string; args: string }) => void
  handleToolResult: (info: { id: string; name: string; result: string; isError: boolean }) => void
  // Day 6 新增
  handleThinking: () => void
  handleIteration: (current: number, max: number) => void
  abortChat: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  currentStreamText: '',
  isThinking: false,
  iteration: 0,
  maxIteration: 10,

  sendMessage: async (content, workspacePath) => {
    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(), role: 'user', content, timestamp: Date.now(),
    }
    const assistantMsg: ChatMessageData = {
      id: crypto.randomUUID(), role: 'assistant', content: '', timestamp: Date.now(),
      isStreaming: true, toolCalls: [],
    }
    set((state) => ({
      messages: [...state.messages, userMsg, assistantMsg],
      isStreaming: true,
      currentStreamText: '',
      isThinking: false,
      iteration: 0,
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
      // 模型开始吐字 → 退出"思考中"
      return { messages, currentStreamText: newStreamText, isThinking: false }
    })
  },

  handleComplete: () => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = { ...messages[lastIdx], isStreaming: false }
      }
      return { messages, isStreaming: false, currentStreamText: '', isThinking: false, iteration: 0 }
    })
  },

  handleError: (error) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = { ...messages[lastIdx], content: `错误：${error}`, isStreaming: false }
      }
      return { messages, isStreaming: false, currentStreamText: '', isThinking: false, iteration: 0 }
    })
  },

  newConversation: () => {
    window.api.clearChat()
    set({ messages: [], isStreaming: false, currentStreamText: '', isThinking: false, iteration: 0 })
  },

  handleToolCall: (info) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
        const prev = messages[lastIdx]
        const newToolCall: ToolCallInfo = {
          id: info.id, name: info.name, args: info.args, status: 'running',
        }
        messages[lastIdx] = {
          ...prev,
          toolCalls: [...(prev.toolCalls ?? []), newToolCall],
        }
      }
      // 模型开始调用工具 → 退出"思考中"
      return { messages, isThinking: false }
    })
  },

  handleToolResult: (info) => {
    set((state) => {
      const messages = state.messages.map((msg) => {
        if (msg.role !== 'assistant' || !msg.toolCalls) return msg
        const toolCalls = msg.toolCalls.map((tc) =>
          tc.id === info.id
            ? { ...tc, status: (info.isError ? 'error' : 'completed') as ToolCallInfo['status'], result: info.result }
            : tc,
        )
        return { ...msg, toolCalls }
      })
      return { messages }
    })
  },

  // Day 6 新增
  handleThinking: () => { set({ isThinking: true }) },

  handleIteration: (current, max) => { set({ iteration: current, maxIteration: max }) },

  abortChat: () => { window.api.abortChat() },
}))
```

#### D. 这段代码做了什么
- **`handleThinking` 仅 `set({isThinking:true})`**：极简，UI 自己决定怎么渲染。
- **`appendToken` 与 `handleToolCall` 都把 `isThinking` 重置为 false**：单点退出策略——只要"模型开始动了"就退出 thinking，不需要主动 `onNotThinking` 事件。
- **`handleToolResult` 改用 `map` 而非 lastIdx**：Day 5 是只改最后一条 assistant；Day 6 用 `map` 遍历所有 assistant 消息——理论上更稳，因为 agent loop 中可能多个 assistant 消息嵌套（虽然本日不会，未来 Day 7+ 可能）。
- **`abortChat` 仅转发**：不改本地 state——AgentLoop 会通过 `onComplete` 关 isStreaming，统一走主路径。
- **`handleComplete` 重置 `iteration:0`**：让下次请求 UI 不残留旧轮次。

#### E. 立刻验证
DevTools console:
```js
useChatStore.getState().isThinking            // false
useChatStore.getState().handleThinking()
useChatStore.getState().isThinking            // true
```

---

### 5.9 步骤 9：`useChat.ts` 加 listener + 暴露 abort

#### A. 动机
订阅 2 个新事件、把 abort 函数从 store 透传到组件。

#### B. 你将要做的操作
打开 `src/hooks/useChat.ts`，整文件替换。

#### C. 完整代码

*文件 `src/hooks/useChat.ts`：*
```ts
/**
 * Day 6: useChat Hook（扩展版）。
 *
 * 相较 Day 5 新增两个事件监听：
 * - onChatThinking  → handleThinking
 * - onChatIteration → handleIteration
 * 并暴露 abortChat 给 UI。
 */
import { useEffect, useCallback } from 'react'
import { useChatStore } from '../stores/chat.store'
import { useFileTreeStore } from '../stores/file-tree.store'

export function useChat() {
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const newConversation = useChatStore((s) => s.newConversation)
  const abortChat = useChatStore((s) => s.abortChat)
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
    // Day 6 新增
    const unsub6 = window.api.onChatThinking(() => {
      useChatStore.getState().handleThinking()
    })
    const unsub7 = window.api.onChatIteration((data) => {
      useChatStore.getState().handleIteration(data.current, data.max)
    })

    return () => {
      unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); unsub7()
    }
  }, [])

  const send = useCallback(
    async (content: string) => {
      await sendMessage(content, workspaceRoot ?? process.cwd())
    },
    [sendMessage, workspaceRoot],
  )

  return { sendMessage: send, isStreaming, newConversation, abortChat }
}
```

#### D. 这段代码做了什么
- **`abortChat` 直接从 store 取**：返回引用本身（store 的 abortChat 不变所以引用稳定），不需要 useCallback 包。
- **return 多了 `abortChat`**：`ChatPanel` 解构使用。
- **对比反例**：把 onChatThinking 注册到 `appendToken` 的同一个 `subscribe` 内——会让两类事件耦合，将来加新事件时改一处就影响多处。

#### E. 立刻验证
React DevTools 看 `ChatPanel` 的 useChat 返回值含 `abortChat: ƒ`。

---

### 5.10 步骤 10：`ChatPanel.tsx` 三组新 UI

#### A. 动机
顶栏添加"轮次"徽章 + "取消"按钮；底栏切换"思考中" / "生成中"双态指示。

#### B. 你将要做的操作
打开 `src/components/chat/ChatPanel.tsx`，整文件替换。

#### C. 完整代码

*文件 `src/components/chat/ChatPanel.tsx`：*
```tsx
import { useEffect, useRef } from 'react'
import { Plus, Settings, Loader2, BrainCircuit, Square } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useChat } from '../../hooks/useChat'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'

/**
 * Day 6: Chat 面板（扩展版）。
 *
 * 新增三组 UI：
 *   - 顶栏「轮次 N/M」徽章
 *   - 顶栏红色「取消」按钮
 *   - 底栏「思考中」/「生成中」双态指示
 */
export default function ChatPanel() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const isThinking = useChatStore((s) => s.isThinking)
  const iteration = useChatStore((s) => s.iteration)
  const maxIteration = useChatStore((s) => s.maxIteration)

  const { sendMessage, newConversation, abortChat } = useChat()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 h-10 min-h-10 border-b border-border">
        <span className="text-xs font-semibold tracking-wider text-gray-400">AI ASSISTANT</span>
        <div className="flex items-center gap-2">
          {/* 轮次徽章 */}
          {isStreaming && iteration > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-mono select-none">
              轮次 {iteration}/{maxIteration}
            </span>
          )}
          {/* 取消按钮 */}
          {isStreaming && (
            <button
              onClick={abortChat}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
              title="中断 Agent"
            >
              <Square size={10} className="fill-current" />
              取消
            </button>
          )}
          <button
            onClick={newConversation}
            className="p-1.5 rounded hover:bg-[#2a2d2e] text-gray-400 hover:text-white transition-colors cursor-pointer"
            title="新建对话"
          >
            <Plus size={16} />
          </button>
          <button
            className="p-1.5 rounded hover:bg-[#2a2d2e] text-gray-400 hover:text-white transition-colors cursor-pointer"
            title="设置"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 select-none">
            <p className="text-sm">向下方输入框中发送消息</p>
            <p className="text-xs mt-1 opacity-60">按 Enter 发送，Shift+Enter 换行</p>
            <p className="text-xs mt-3 opacity-40">Agent 可读取、搜索、写入工作区文件</p>
          </div>
        ) : (
          messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 状态指示：思考中 / 生成中 */}
      {isStreaming && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border/50 text-xs text-gray-500">
          {isThinking ? (
            <>
              <BrainCircuit size={13} className="text-purple-400 animate-pulse" />
              <span className="text-purple-400">思考中...</span>
            </>
          ) : (
            <>
              <Loader2 size={12} className="animate-spin text-blue-400" />
              <span>生成中...</span>
            </>
          )}
        </div>
      )}

      <ChatInput onSend={sendMessage} isStreaming={isStreaming} />
    </div>
  )
}
```

#### D. 这段代码做了什么
- **5 个独立的 `useChatStore((s) => s.X)` 订阅**：Zustand 的最佳实践——每条订阅只关心一个字段，字段没变时组件不重渲染。**对比反例**：`const { messages, isStreaming, ... } = useChatStore()`（整个 state 解构）会让 `iteration` 变化也触发 messages 重渲染。
- **`isStreaming && iteration > 0` 双重门**：iteration=0 时（初始）不显示徽章；只在真正开始 agent 后出现。
- **`Square fill-current`**：lucide 的 Square 默认描边，`fill-current` 让它实心更像"停止"按钮。
- **三元式 thinking/streaming**：详见 §4.5。
- **底栏 `border-t border-border/50`**：半透明边框，比 ChatInput 上边框更柔和——视觉层级是 messages > status > input。

#### E. 立刻验证
完整端到端：发起多步任务，能看到顶栏徽章变化、底栏紫蓝切换、点取消能停。

---

### 5.11 步骤 11：`TerminalInstance.tsx` 改欢迎语

#### A. 动机
仅文案。

#### B. 你将要做的操作
把 `terminal.writeln('Day 5 Terminal Ready')` 改为 `'Day 6 Terminal Ready'`。

#### C. 完整代码
```tsx
terminal.writeln('Day 6 Terminal Ready')
```

#### D. 这段代码做了什么
仅文案。无可对比写法。

#### E. 立刻验证
启动 Terminal 看到 "Day 6 Terminal Ready"。

---

## 6. 端到端串联走查

以"创建 `notes/today.md`，内容是 'hello day6'"为例。

### 第 1 跳：用户回车
- `ChatInput` Enter → `ChatPanel.onSend` → `useChat.send` → `chat.store.sendMessage(content, workspaceRoot)`。
- store 立即 push user + 空 assistant；set `isStreaming=true, isThinking=false, iteration=0`；
- await `window.api.sendChatMessage(content, ws)` → preload → `ipcRenderer.invoke('chat:send-message',...)`。

### 第 2 跳：主进程
- `chat.ipc.ts` handle → `chatService.sendMessage(msg, ws, callbacks)`。
- ChatService push user → `new AgentLoop(provider, registry)` → `currentLoop.run([...messages], ws, loopCallbacks)`。

### 第 3 跳：第 1 轮 LLM 请求
- AgentLoop set `aborted=false`，构造 conversation = [system(ws), user]。
- 发 `onIteration(1, 10)` → IPC `chat:iteration` → store `handleIteration` → 顶栏显示 "轮次 1/10"。
- 发 `onThinking()` → IPC `chat:thinking` → store `handleThinking` → 底栏紫色 BrainCircuit。
- `provider.chat({messages, tools, stream:true})` 发 HTTP；模型很快回 `tool_call_start name="write_file" id="call_1"` → `onToolCallStart({id,name,''})` → IPC `chat:tool-call` → store `handleToolCall` → 最后一条 assistant 多一个 ToolCallBlock，状态 `running`，且 `isThinking=false`（底栏切到蓝色"生成中"）。
- chunks 拼装 arguments 完成 → `tool_call_end` → push 到 `completedToolCalls`。

### 第 4 跳：执行工具
- chunk 流结束、completedToolCalls.length=1 → push assistant {content:null, tool_calls:[call_1]}。
- 遍历 → `JSON.parse('{"path":"notes/today.md","content":"hello day6"}')` → `toolRegistry.execute('write_file', {...}, {workspacePath})`。
- `write-file.tool.ts`：路径校验通过 → `fs.mkdir('notes', recursive)` → `fs.writeFile('notes/today.md', 'hello day6')` → 返回 "文件已成功写入：notes\\today.md（10 字符）"。
- `onToolCallResult({id:call_1, name:'write_file', result:..., isError:false})` → IPC `chat:tool-result` → store `handleToolResult` → ToolCallBlock 变绿。
- conversation push {role:'tool', tool_call_id:call_1, content:result}。

### 第 5 跳：第 2 轮 LLM 请求
- 进入下次 for 迭代。`onIteration(2, 10)` → 顶栏 "轮次 2/10"。
- `onThinking()` → 紫色。
- `provider.chat` 重新发请求（带新增的 tool 消息）。
- 这次模型只输出文字 "已创建 notes/today.md..." → `text_delta` 一颗颗 → store `appendToken` 同时 set `isThinking=false` → 底栏切蓝色 → 文字流式出现。
- 流结束、completedToolCalls.length=0 → push {role:'assistant', content:currentText} → `onComplete(fullText)`。

### 第 6 跳：完成
- ChatService.onComplete 把 fullText push 进主 messages → `callbacks.onComplete` 透传 → IPC `chat:complete` → store `handleComplete` → set `isStreaming=false, isThinking=false, iteration=0`，最后 assistant.isStreaming=false → 顶栏徽章/取消按钮消失，底栏指示消失，光标消失。
- 第 1 跳 `await invoke` resolve（无返回值）。

### 取消路径
- 用户在第 5 跳中点取消 → `useChat.abortChat` → `window.api.abortChat()` → IPC `chat:abort` → `chatService.abort()` → `currentLoop.aborted = true`。
- 下一个检查点（chunk 顶部）触发 break → 结束 chunk for → 检查点 3 触发 → `onComplete(fullText)`。
- 后续工具 / 第 6 跳走完整 onComplete 路径。

---

## 7. 完整运行流程追踪

### 7.1 模块加载
- `npm run dev` → electron-vite 编译 → main 启动 `electron/main.ts` → `app.whenReady()` → `registerAllIpcHandlers()` → `registerChatIpcHandlers()`：
  - 模块顶层 `new ChatService()`：`loadSettings` 同步读 userData/chat-settings.json；`new ToolRegistry()`；`register` × 4（read/list/search/write 工具）。
- renderer 启动 → React 挂载 → `ChatPanel` 挂载 → `useChat` 一次性 `useEffect` 注册 7 个事件 listener。

### 7.2 一次完整请求时序
```
T+0ms   Enter pressed
T+1ms   store push user+assistant; isStreaming=true
T+2ms   invoke('chat:send-message',...) → main receives
T+3ms   ChatService.sendMessage → push user → new AgentLoop → run
T+4ms   AgentLoop iter=0: onIteration(1,10) → IPC chat:iteration
T+5ms   onThinking() → IPC chat:thinking → UI 紫色
T+6ms   provider.chat → HTTP POST /v1/chat/completions
T+800ms 第一个 chunk 回来：tool_call_start name="write_file"
T+801ms onToolCallStart → IPC → store → ToolCallBlock 出现 running
        store.appendToken/handleToolCall 同时 set isThinking=false → UI 蓝色
T+850ms 后续 chunks 拼 arguments
T+900ms finish_reason → tool_call_end → push to completedToolCalls
T+901ms for-await done → completedToolCalls.length=1
T+902ms push assistant{tool_calls} → execute write_file（fs 同步耗 ~5ms）
T+910ms onToolCallResult → IPC → ToolCallBlock 变绿
T+911ms push tool message → 进入第 2 轮 iter=1
T+912ms onIteration(2,10), onThinking() → UI 切紫
T+913ms provider.chat 第 2 次请求
T+1.5s  第二次响应：纯 text_delta 流
T+1.51s store.appendToken → isThinking=false → UI 蓝色 + 文字流式
T+2.5s  完成 → onComplete → store handleComplete → UI 全部清零
```

### 7.3 取消的精确时序
```
T+1.4s  用户点"取消"
T+1.401s window.api.abortChat() → IPC handle → chatService.abort() → currentLoop.aborted=true
T+1.402s 当前第 2 轮 chunks 流仍在收，下一个 chunk 进入 for-await 时检查 aborted → break
T+1.403s 检查点 3 → onComplete(fullText) → store handleComplete → UI 还原
        SDK 流仍在后台读到底（无副作用，被 GC）
```

---

## 9. 自测清单

- [ ] `npm install; npm run dev` 启动无 TS 错误。
- [ ] 多步推理任务能看到顶栏 "轮次 1/10 → 2/10 → 3/10..." 递增。
- [ ] 模型推理空挡时底栏显示**紫色 BrainCircuit + "思考中..."**；吐字 / 调工具后切**蓝色 Loader2 + "生成中..."**。
- [ ] 长流程进行中点"取消"按钮，UI 立刻停止变化、轮次徽章消失，最后一条 assistant 进入"已完成"状态；已完成的工具卡片仍显示。
- [ ] 输入"创建 `notes/today.md`，写入 'hello'" → `write_file` 工具卡片完成；FileExplorer 刷新可看到文件。
- [ ] 输入"把 hello 写入 `../../danger.txt`" → 工具卡片标红，结果显示"安全错误：不允许写入工作区目录之外的文件"。
- [ ] 输入"修改 `package.json` 把 description 改成 X" → 模型先调用 `read_file` 后调用 `write_file`（验证系统提示中"先读后写"准则起作用）。
- [ ] 故意构造 11+ 轮的循环（如让模型反复 list_files）→ 第 11 轮触发 `onError("已达到最大迭代次数 10 轮")`，UI 显示错误而非卡死。
- [ ] 关闭重启应用，配置仍在；新建对话能清空历史。
- [ ] 流式中关闭窗口，主进程不报 `Object has been destroyed`。
- [ ] DevTools console `useChatStore.getState()` 含 `isThinking / iteration / maxIteration / abortChat`。
- [ ] Day 1-5 全部既有功能正常。
- [ ] HMR 触发 chat.ipc.ts 重新加载不报 `Attempted to register a second handler`（验证 removeHandler 起作用）。

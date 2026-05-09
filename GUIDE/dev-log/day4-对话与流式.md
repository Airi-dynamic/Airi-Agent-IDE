# Day 4：Chat 面板、Provider 抽象与流式 IPC

## 0. 前言

Day 1-3 我们把 IDE 的"骨架"立起来了：编辑器、终端、文件树。Day 4 是项目第一次接入"AI 能力"——但**不是 agent**（agent 主循环放到 Day 6），只是最朴素的"用户问一句、LLM 流式回答一句"的对话面板。本日的工程价值在三处：

1. **Provider 抽象**：`LLMProvider` 接口 + `OpenAIProvider` 实现 = 上层 ChatService 不依赖具体 SDK。Day 5+ 想换 Claude / 本地 ollama，只加一个新文件、零侵入。
2. **流式 IPC 模式**：第一次出现 `ipcMain.handle` 之外的反向通道——`webContents.send('chat:stream', ...)` 把 token 一颗颗推回 renderer。这是 Day 5 工具调用、Day 6 Agent loop、Day 8 Diff 推送都会复用的通信范式。
3. **AsyncIterable 与 async generator**：用 `async function*` + `for await...of` 把"分块 HTTP 响应"变成"可被消费的 token 流"。

§4 仅讲今日新概念：Provider 抽象 / async generator / `webContents.send` / `crypto.randomUUID` / textarea 自适应高度 / `app.getPath('userData')` 持久化 / `react-resizable-panels` 三段式。

---

## 1. 本日目标与产出

### 1.1 功能目标

1. 顶部活动栏新增 💬 图标 → 点击切换右侧 Chat 面板（默认隐藏）。
2. Chat 面板自顶向下：标题栏（含「+ 新建对话」「⚙ 设置」按钮）→ 消息列表（用户右对齐蓝头像、助手左对齐机器人头像）→ 流式生成指示条（`Loader2` 旋转 + "Generating..."）→ 输入框（textarea 自适应高度、Enter 发送、Shift+Enter 换行、流式期间禁用）。
3. 用户输入"你好" → 后端调用 OpenAI 兼容流式接口 → 助手气泡内文字一颗颗追加、末尾闪烁光标 → 完成后光标消失、保留全文。
4. 多轮上下文：前一句 "我叫小明"、后一句 "我叫什么" → 助手能正确回忆。
5. 「+ 新建对话」清空消息 + 通知后端清空 history。
6. Provider 配置（apiKey / baseURL / model）持久化到 `app.getPath('userData')/chat-settings.json`，重启应用自动加载。
7. Day 1-3 全部功能保持工作（编辑器、文件树、终端、面板拖动、侧栏折叠）。

### 1.2 工程目标

1. `electron/services/agent/providers/` 抽象层：`base.provider.ts` 定义 `LLMProvider` 接口，`openai.provider.ts` 实现之；上层只依赖接口。
2. `electron/services/agent/chat.service.ts` 编排器：管理 messages 历史、设置持久化、调用 Provider、通过回调把流式事件抛给 IPC 层。
3. `electron/ipc/chat.ipc.ts` 引入**双向 IPC**：`ipcMain.handle` 接请求 + `webContents.send` 推流；用 `safeSend` 守卫窗口已销毁场景。
4. renderer 端 `useChat` hook 在挂载时一次性订阅 3 个流式事件、卸载时解绑——避免重复挂载导致的事件泄漏。
5. `chat.store.ts` 管理消息列表与 streaming 状态；`appendToken / handleComplete / handleError` 三个 action 让组件层只关心"渲染最新数据"。

---

## 2. 先跑起来（Smoke Run）

```powershell
Set-Location .\GUIDE\day4
npm install
npm run dev
```

首次启动后**配置 LLM**（教学阶段没做设置弹窗，直接 DevTools console 调）：

```js
await window.api.updateChatSettings({
  apiKey: 'sk-xxx',                            // 你的 key
  baseURL: 'https://api.deepseek.com/v1',      // 或 OpenAI / Moonshot / Ollama
  model: 'deepseek-chat'
})
```

然后：

1. 点活动栏 💬 → 右侧出现 Chat 面板。
2. 输入 "用一句话介绍 TypeScript" + Enter → 助手气泡里文字一颗颗冒出，末尾有光标。完成后光标消失。
3. 输入 "我叫小明" → 等待生成 → 输入 "我叫什么名字" → 助手应回 "小明"（多轮上下文）。
4. 点 ➕ → 列表清空，再问 "我叫什么名字" 应回答不知道。
5. 关闭并重启 `npm run dev` → 不需要再调 `updateChatSettings`，配置已持久化。
6. 故意把 apiKey 改成无效值发消息 → 气泡显示 "错误: ..."；UI 不卡死。

---

## 3. 项目结构与变更总览

### 3.1 项目目录树（ASCII）

```text
day4/
├─ electron/
│  ├─ main.ts                              # 修改：仅注释 "Day 3" → "Day 4"
│  ├─ preload.ts                           # 修改：暴露 sendChatMessage / on* 事件订阅
│  ├─ ipc/
│  │  ├─ index.ts                          # 修改：追加 registerChatIpcHandlers()
│  │  ├─ file-system.ipc.ts                # 不变
│  │  ├─ terminal.ipc.ts                   # 不变
│  │  └─ chat.ipc.ts                       # 新增：handle 请求 + webContents.send 推流
│  └─ services/
│     ├─ file-system.service.ts            # 不变
│     └─ agent/                            # 新增目录：所有 LLM 相关 service
│        ├─ chat.service.ts                # 新增：messages 历史 + 设置持久化 + 调 Provider
│        └─ providers/                     # 新增子目录
│           ├─ base.provider.ts            # 新增：接口定义（LLMProvider/ChatMessage/StreamChunk/ProviderConfig）
│           └─ openai.provider.ts          # 新增：OpenAI 兼容实现（async generator）
├─ src/
│  ├─ components/
│  │  ├─ chat/                             # 新增目录
│  │  │  ├─ ChatMessage.tsx                # 新增：单条消息气泡
│  │  │  ├─ ChatInput.tsx                  # 新增：textarea 自适应输入框
│  │  │  └─ ChatPanel.tsx                  # 新增：消息列表 + 输入框组合 + 自动滚底
│  │  ├─ layout/
│  │  │  ├─ AppLayout.tsx                  # 修改：活动栏多 💬、PanelGroup 加第三段 Chat
│  │  │  ├─ Sidebar.tsx                    # 不变
│  │  │  └─ StatusBar.tsx                  # 修改：仅文案 "Day 3" → "Day 4 Chat + LLM"
│  │  ├─ terminal/
│  │  │  └─ TerminalInstance.tsx           # 修改：仅欢迎语 "Day 3" → "Day 4"
│  │  ├─ editor/MonacoWrapper.tsx          # 不变
│  │  └─ file-explorer/...                 # 不变
│  ├─ hooks/
│  │  └─ useChat.ts                        # 新增：挂载时订阅 3 个流式事件
│  ├─ stores/
│  │  ├─ chat.store.ts                     # 新增：messages + isStreaming + actions
│  │  └─ editor.store.ts                   # 修改：增加 isChatOpen / setChatOpen
│  └─ vite-env.d.ts                        # 修改：ChatMessageData + 7 个新 RendererApi 方法
└─ package.json                            # 修改：name/description + 新增 "openai" 依赖
```

### 3.2 双向 IPC 链路图

Day 4 的关键差异：第一次出现 **request-then-streaming** 双通道。

```text
┌─────────────────── renderer ───────────────────┐         ┌──────────────────── main ────────────────────┐
│                                                │         │                                              │
│ ChatPanel  → ChatInput onSend                  │         │                                              │
│                ↓                               │         │                                              │
│ useChat.sendMessage                            │         │                                              │
│                ↓                               │         │                                              │
│ chat.store.sendMessage(content)                │         │                                              │
│   ① 本地 push user 气泡 + 占位 assistant 气泡   │         │                                              │
│   ② await window.api.sendChatMessage(content)──┼────────▶│ ipcMain.handle('chat:send-message', ...)     │
│                                                │ invoke  │       ↓                                      │
│                                                │         │ ChatService.sendMessage(content, callbacks)  │
│                                                │         │       ↓                                      │
│                                                │         │ provider.chat({messages, stream:true})       │
│                                                │         │  // async generator yield StreamChunk        │
│                                                │         │       ↓                                      │
│                                                │         │ for await chunk:                             │
│                                                │         │   if text_delta:                             │
│ window.api.onChatStream(cb) 已订阅 ────────────┼◀────────┤    callbacks.onToken(chunk.content)          │
│   → store.appendToken(token) → re-render       │ send    │       ↓ safeSend('chat:stream',{token})     │
│                                                │         │ 循环结束（done）                              │
│ window.api.onChatComplete(cb) ─────────────────┼◀────────┤ callbacks.onComplete(fullText)              │
│   → store.handleComplete(fullText) → 关闭光标   │ send    │   safeSend('chat:complete',{message})       │
│                                                │         │                                              │
│ window.api.onChatError(cb) ────────────────────┼◀────────┤ try/catch → callbacks.onError(message)      │
│                                                │ send    │   safeSend('chat:error',{error})            │
│                                                │         │                                              │
│ ① ipc.handle 的 await 此时也 resolve（无返回值）│         │                                              │
│   sendMessage 函数返回                         │         │                                              │
└────────────────────────────────────────────────┘         └──────────────────────────────────────────────┘
```

注意：`chat:send-message` 的 `invoke` **没有返回值**——所有"内容"都通过反向 `send` 通道穿回。`invoke` 完成只代表"主进程那边的 sendMessage 函数返回了"，并不意味着流已开始/结束。

### 3.3 编码步骤索引（依赖顺序）

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `package.json` | 修改 | +openai 依赖、name/description |
| 2 | `electron/services/agent/providers/base.provider.ts` | 新增 | 接口 |
| 3 | `electron/services/agent/providers/openai.provider.ts` | 新增 | 实现 + async generator |
| 4 | `electron/services/agent/chat.service.ts` | 新增 | 编排 + 持久化 |
| 5 | `electron/ipc/chat.ipc.ts` | 新增 | handle + webContents.send |
| 6 | `electron/ipc/index.ts` | 修改 | 追加 registerChatIpcHandlers() |
| 7 | `electron/main.ts` | 修改 | 仅注释字符串 |
| 8 | `electron/preload.ts` | 修改 | 暴露 4 个 invoke + 3 个 on* |
| 9 | `src/vite-env.d.ts` | 修改 | ChatMessageData + RendererApi 扩充 |
| 10 | `src/stores/chat.store.ts` | 新增 | messages + actions |
| 11 | `src/stores/editor.store.ts` | 修改 | isChatOpen / setChatOpen |
| 12 | `src/hooks/useChat.ts` | 新增 | 订阅 3 个流式事件 |
| 13 | `src/components/chat/ChatMessage.tsx` | 新增 | 单条消息气泡 |
| 14 | `src/components/chat/ChatInput.tsx` | 新增 | 自适应 textarea |
| 15 | `src/components/chat/ChatPanel.tsx` | 新增 | 消息列表 + 标题栏 |
| 16 | `src/components/layout/AppLayout.tsx` | 修改 | 活动栏 + 第三段 Panel |
| 17 | `src/components/layout/StatusBar.tsx` | 修改 | 仅文案 |
| 18 | `src/components/terminal/TerminalInstance.tsx` | 修改 | 仅欢迎语 |

依赖序原则：接口（无依赖）→ 实现（依赖接口）→ service（用 provider）→ ipc（用 service + webContents）→ index/main 接线 → preload 暴露 → 类型 → renderer store/hook → 叶子组件 → 容器组件 → 布局接入 → 文案微调。

---

## 4. 基础知识铺垫

### 4.1 Provider 抽象——面向接口编程的最小用例

Day 5 的 agent 工具会要求"换一家 LLM"成为常态：开发期用便宜的 deepseek，演示用 OpenAI，离线用本地 ollama。如果 ChatService 直接 `import OpenAI from 'openai'`、直接 `new OpenAI(...)`，那"换 Provider" 就要改 ChatService——违反开闭原则。

标准做法：

```text
LLMProvider (interface)             ← chat.service.ts 只 import 这个
   ▲                                  ↑
   │                                  │ 任意 provider 都行，互换零成本
   ├── OpenAIProvider                 │
   ├── ClaudeProvider                 │
   └── OllamaProvider                 │
```

`LLMProvider` 只定义"输入：messages + stream → 输出：AsyncIterable<StreamChunk>"——具体怎么 HTTP 请求、SSE 解析、错误重试都是 Provider 内部的事。本日只实现 OpenAI 兼容；接口形状已经按"未来 Day 5 会加 tool_use / tool_result"留好扩展空间（`StreamChunk.type` 是判别式字符串而非 boolean）。

### 4.2 Async Generator + `for await...of`

ES2018 引入 `async function*`，让"逐步异步产出值"变成一等公民：

```ts
async function* tick() {
  yield 1
  await new Promise(r => setTimeout(r, 100))
  yield 2
  yield 3
}

for await (const v of tick()) {
  console.log(v)   // 1, 2, 3 (中间有 100ms 间隔)
}
```

OpenAI SDK 的 `client.chat.completions.create({ stream: true })` 返回的本来就是个 AsyncIterable——我们用 `for await` 消费它的 SSE 块，重新 `yield` 成自己的 `StreamChunk` 形状。**两层 generator 串联**：上游是 OpenAI 的 chunk、下游是消费方的 StreamChunk，中间做"格式归一化"。

> **反例对比**：用 `Promise<string[]>` 一次返回所有 token——失去流式价值（用户要等几秒才看到第一个字）。用 EventEmitter / RxJS Observable 也能做，但 async generator 是 **TypeScript 原生支持**、不引入额外依赖、`for await` 比 `subscribe` 直观。

### 4.3 `ipcMain.handle` vs `webContents.send`——两种方向

| | `invoke` / `handle` | `send` / `on` |
|---|---|---|
| 方向 | renderer → main，**有返回值** | main → renderer，**单向** |
| 模式 | request-response | 推送 / 事件 |
| 使用场景 | "读这个文件返回内容"、"运行命令拿结果" | "新 token 到了"、"下载进度更新"、"系统通知" |

Day 4 第一次同时用到两边：
- `chat:send-message` 用 `handle`——renderer 想知道"主进程已收到我的请求"。
- `chat:stream / complete / error` 用 `send`——主进程不知道 renderer 什么时候订阅、订阅几次，只管广播。

`webContents.send(channel, data)` 的 data 同样走结构化克隆，所以**只能传纯数据**。

> **反例对比**：把流式 token 也用 `handle` 实现——`handle` 只能 return 一次，要么把所有 token 拼成数组返回（失去流式），要么开一个新 `invoke` 拿下一个 token（轮询，性能差）。流推送场景必须用 `send`。

### 4.4 `safeSend` 与窗口生命周期

主进程发 `webContents.send` 时，如果 BrowserWindow 已被关闭/销毁，调用会抛 `Object has been destroyed`。流式回调可能在窗口关闭后还在跑（用户 Ctrl+W 关窗、但 OpenAI 请求还有几个 chunk 在路上），必须守卫：

```ts
const safeSend = (channel, data) => {
  if (!win.isDestroyed()) win.webContents.send(channel, data)
}
```

Day 6 agent loop 长时间运行时这个守卫尤其关键。

### 4.5 流式事件订阅的"返回 unsubscribe 函数"模式

preload 给 renderer 暴露的事件订阅 API 应当**返回取消订阅函数**：

```ts
onChatStream: (cb) => {
  const handler = (_, data) => cb(data)
  ipcRenderer.on('chat:stream', handler)
  return () => ipcRenderer.removeListener('chat:stream', handler)
}
```

为什么？React 的 `useEffect` cleanup 需要它：

```ts
useEffect(() => {
  const unsub = window.api.onChatStream(...)
  return unsub                       // ← cleanup 直接返回
}, [])
```

如果 preload 只 `ipcRenderer.on` 不返回 unsubscribe，组件每次 React StrictMode 双调用都会**多注册一个 listener**，发一条消息会触发 2/3/4... 次回调——典型的"事件泄漏"。

### 4.6 `crypto.randomUUID`

浏览器 + Node 18+ 都内置 `crypto.randomUUID()` 返回 RFC 4122 v4 UUID。**不需要 `import { v4 } from 'uuid'`**。本日消息 ID 全用它——renderer 端 `crypto` 已挂在 window 上，service 端 Node 18+ 全局可用（如果未来需要在 service 用，`import { randomUUID } from 'crypto'`）。

### 4.7 `app.getPath('userData')` 持久化

Electron 给每个应用分配一个标准的"用户数据目录"——Windows 是 `%APPDATA%/<appName>`、macOS 是 `~/Library/Application Support/<appName>`、Linux 是 `~/.config/<appName>`。`app.getPath('userData')` 返回该路径。Day 4 的 `chat-settings.json` 落在这里，比"放工作区根"更安全（apiKey 不会被误提交到 git）。

### 4.8 textarea 自适应高度

CSS 没有"按内容自适应高度"的 textarea。标准做法：

```ts
const adjust = () => {
  el.style.height = 'auto'                               // 先重置才能正确测量 scrollHeight
  el.style.height = Math.min(el.scrollHeight, MAX) + 'px'
}
useEffect(adjust, [value])                                // value 变化触发重测
```

注意 **必须先 `height = 'auto'`** 再读 `scrollHeight`——否则 height 还是上一次设的值，scrollHeight 不会缩小（删字时高度永远不收缩）。

### 4.9 `react-resizable-panels` 三段式

Day 1 我们用过两段式（侧栏 + 主区）。Day 4 加 Chat 后变三段：

```text
PanelGroup (horizontal)
  ├─ ActivityBar (w-12 固定)
  ├─ if isSidebarOpen: <Panel> + <PanelResizeHandle>
  ├─ <Panel>  Main (Monaco + Terminal vertical)
  └─ if isChatOpen:    <PanelResizeHandle> + <Panel> Chat
```

**关键**：固定宽度的活动栏不在 PanelGroup 内（不参与拖动）；Sidebar / Chat 都是条件渲染——条件成立时同时渲染 `<PanelResizeHandle>` + `<Panel>`，避免 panels 计数不一致导致布局错乱。`<Panel defaultSize={isChatOpen ? 55 : 80}>` 让主区在 Chat 打开时主动让出空间。

---

## 5. 编码步骤

### 5.1 步骤 1：更新 `package.json`

#### A. 动机

新增 `openai` SDK（覆盖 OpenAI / DeepSeek / Moonshot / Kimi / 任何 OpenAI 兼容端点 / 本地 ollama）。其他依赖与 Day 3 完全相同。

#### B. 操作

复制 Day 3 的 `package.json`：① name → `my-agent-ide-day4`、description → `Day 4: Chat Panel + OpenAI Provider + Streaming IPC`；② `dependencies` 中加入 `"openai": "^4.80.0"`（按字母序插入）。

#### C. 完整代码

*文件 `package.json`：*

```json
{
  "name": "my-agent-ide-day4",
  "version": "1.0.0",
  "description": "Day 4: Chat Panel + OpenAI Provider + Streaming IPC",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev"
  },
  "dependencies": {
    "@monaco-editor/react": "^4.7.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.5.0",
    "clsx": "^2.1.1",
    "lucide-react": "^0.468.0",
    "openai": "^4.80.0",
    "react-resizable-panels": "^2.1.0",
    "zustand": "^5.0.0",
    "@electron-toolkit/preload": "^3.0.1",
    "@electron-toolkit/utils": "^3.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^35.0.0",
    "electron-vite": "^3.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

#### D. 这段代码做了什么

唯一新增 `openai` 包（约 800 KB，无 node 原生模块编译，不需要 electron-rebuild）。我们用它的两个能力：① `new OpenAI({ apiKey, baseURL })` 构造客户端；② `client.chat.completions.create({ stream: true })` 拿 AsyncIterable。

> **反例对比**：用原生 `fetch` 自己处理 SSE（`event-stream` 协议）——可学但繁琐：要解析 `data: {...}` 行、处理 `[DONE]` 终止符、累计 partial chunk。教学日志用官方 SDK 抹平这些细节，把注意力留给 Provider 抽象本身。

#### E. 验证

```powershell
Set-Location .\GUIDE\day4
npm install
```

`node_modules/openai` 应当存在。

---

### 5.2 步骤 2：新增 `electron/services/agent/providers/base.provider.ts`

#### A. 动机

定义一个稳定的接口契约，让"添加新 Provider" = "加一个文件实现接口"。本日只实现 OpenAI，但接口已为 Day 5 工具调用、Day 6 多轮 agent loop 留好扩展点（`StreamChunk.type` 是字符串判别式、不是 boolean）。

#### B. 操作

新建 `electron/services/agent/providers/` 目录，建 `base.provider.ts`。

#### C. 完整代码

*文件 `electron/services/agent/providers/base.provider.ts`：*

```ts
/**
 * Day 4: LLM Provider 基础接口定义。
 *
 * 所有 LLM 提供商（OpenAI、Claude、本地模型等）都实现这套接口，
 * 上层 ChatService 不关心具体实现，只依赖接口编程。
 */

// 聊天消息结构：role 决定消息来源（系统/用户/助手）。
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 流式输出里的每一块数据，按 type 区分含义。
export interface StreamChunk {
  type: 'text_delta' | 'done' | 'error'
  content?: string
  error?: string
}

// Provider 配置：连接 LLM 所需的最小信息集合。
export interface ProviderConfig {
  apiKey: string
  baseURL: string
  model: string
}

// 所有 Provider 必须实现的接口。
export interface LLMProvider {
  // 流式聊天：返回异步迭代器，逐块产出文本增量。
  chat(params: {
    messages: ChatMessage[]
    stream: boolean
  }): AsyncIterable<StreamChunk>
}
```

#### D. 这段代码做了什么

- **`ChatMessage`**：`role` 是字符串字面量联合（`'system' | 'user' | 'assistant'`），TypeScript 编译期就能拒绝 `role: 'admin'` 这种笔误。Day 5 会扩展为 `'tool'` 角色。
- **`StreamChunk`** 的判别式设计：`type: 'text_delta' | 'done' | 'error'` 让 `if (chunk.type === 'text_delta')` 后面 TS 能 narrow 出 `chunk.content` 必定有值（虽然这里 `content?: string` 仍是可选——更严格可改成判别式联合，但教学阶段保持简单）。Day 5 会再加 `'tool_call'` / `'tool_result'`。
- **`ProviderConfig`**：三字段是 OpenAI 兼容协议的最小集合。本地 ollama 用 `baseURL: 'http://localhost:11434/v1'` + 任意 apiKey + `model: 'qwen2.5'` 也工作。
- **`LLMProvider.chat` 返回 `AsyncIterable<StreamChunk>`**：注意不是 `Promise<...>`——AsyncIterable 是同步的"可迭代对象"，迭代过程中每步才异步。`for await` 消费时第一颗 token 不需要等所有 token 全部到齐。

> **反例对比**：把接口做成 `chat(callback: (chunk) => void): Promise<void>`——能跑，但调用方要传回调，错误处理割裂（要不要在回调里 try？要不要 reject Promise？）。AsyncIterable 让调用方写普通 `for await + try/catch` 就涵盖所有情况。

#### E. 验证

无独立验证。

---

### 5.3 步骤 3：新增 `electron/services/agent/providers/openai.provider.ts`

#### A. 动机

实现 `LLMProvider`，把 OpenAI SDK 的流式响应翻译成项目自己的 `StreamChunk` 形状。

#### B. 操作

在 providers 目录建 `openai.provider.ts`。

#### C. 完整代码

*文件 `electron/services/agent/providers/openai.provider.ts`：*

```ts
/**
 * Day 4: OpenAI / 兼容端点 Provider 实现。
 *
 * 核心能力：接收消息列表，调用 OpenAI SDK 流式接口，
 * 将增量文本通过 AsyncIterable<StreamChunk> 逐块产出。
 *
 * 兼容性：只要 API 实现了 OpenAI Chat Completions 协议（如 DeepSeek、
 * Moonshot、本地 Ollama 等），都可以通过修改 baseURL 接入。
 */

import OpenAI from 'openai'
import type {
  LLMProvider,
  ChatMessage,
  ProviderConfig,
  StreamChunk
} from './base.provider'

export default class OpenAIProvider implements LLMProvider {
  private client: OpenAI

  constructor(private config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL
    })
  }

  /**
   * 流式聊天实现。
   * 使用 async generator（async function*）逐块 yield StreamChunk，
   * 调用方通过 for-await-of 消费。
   */
  async *chat(params: {
    messages: ChatMessage[]
    stream: boolean
  }): AsyncIterable<StreamChunk> {
    try {
      // 将内部消息结构映射为 OpenAI SDK 所需格式。
      const openaiMessages: OpenAI.ChatCompletionMessageParam[] = params.messages.map((msg) => ({
        role: msg.role,
        content: msg.content
      }))

      // 发起流式请求。
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: openaiMessages,
        stream: true
      })

      // 逐块读取并转换为统一格式。
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          yield { type: 'text_delta', content: delta.content }
        }
      }

      // 所有块消费完毕，告知下游流结束。
      yield { type: 'done' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', error: message }
    }
  }
}
```

#### D. 这段代码做了什么

- **`implements LLMProvider`**：让 TS 编译期检查"我有没有满足契约"。如果哪天接口加了新方法没实现，构建立刻报错。
- **`constructor(private config: ProviderConfig)`**：TS 简写，等价于 `this.config = config`。一次性创建 OpenAI 客户端，后续复用。
- **`async *chat(...)`**：星号 + async = async generator。函数体内 `yield` 出去的值就是 AsyncIterable 的元素。
- **映射消息**：项目的 `ChatMessage`（`role + content`）正好是 OpenAI 的子集，直接 1:1 映射即可。Day 5 会加 `tool_calls / tool_call_id` 字段。
- **`stream.choices[0]?.delta`**：OpenAI SSE 每块的形状是 `{ choices: [{ delta: { content?, role?, tool_calls? } }] }`。`?.` 防御 choices 数组为空。
- **只 yield `text_delta`**：本日不处理 `delta.role`（首块会带 role: 'assistant'）和 `delta.tool_calls`（Day 5 才用）——直接忽略。
- **try/catch 包裹整体**：任何异常（401 / 网络断 / 限流 / JSON 解析失败）都翻译成 `{ type: 'error', error }` 一颗 chunk yield 出去。**为什么不直接 throw？** 调用方用 `for await` 消费，throw 会让 `for await` 立刻终止，调用方需要在外层再加 try/catch；统一用 chunk 携带错误能让调用方只写一个 for 循环。

> **反例对比 1**：在 try 外面 throw、在 for 内 yield 错误——两种错误传递路径混存，调用方要同时写 try/catch + 检查 chunk.type，逻辑分裂。**单一错误通道**更易维护。

> **反例对比 2**：直接把 OpenAI SDK 的 chunk 对象 yield 出去——Provider 接口被 OpenAI 形状绑死，换 Claude 时 ChatService 要改全部 chunk 解析逻辑。**适配器模式的价值就在归一化**。

#### E. 验证

无独立验证。

---

### 5.4 步骤 4：新增 `electron/services/agent/chat.service.ts`

#### A. 动机

ChatService 是"业务编排层"：管理消息历史、读写设置文件、把 Provider 的流式 chunk 翻译成 IPC 层易用的回调（`onToken / onComplete / onError`）。**不依赖任何 IPC API**——这点对 Day 5 工具调用复用同一个 service 至关重要。

#### B. 操作

新建 `electron/services/agent/chat.service.ts`。

#### C. 完整代码

*文件 `electron/services/agent/chat.service.ts`：*

```ts
/**
 * Day 4: Chat 服务——管理 Provider 配置与流式对话。
 *
 * 职责：
 * 1. 持久化保存/读取 Provider 配置（apiKey/baseURL/model）。
 * 2. 接收用户消息，调用 LLM Provider 流式生成，通过回调推送增量。
 *
 * 设计选择：
 * - Day 4 不引入多轮对话管理，仅做"单次请求→流式输出"，
 *   但内部维护消息历史以支持多轮上下文。
 * - 配置持久化到 Electron userData 目录，便于重启后恢复。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import type { LLMProvider, ChatMessage, ProviderConfig } from './providers/base.provider'
import OpenAIProvider from './providers/openai.provider'

// 流式输出时主进程 → 渲染进程的回调签名。
export interface ChatCallbacks {
  onToken: (token: string) => void
  onComplete: (fullText: string) => void
  onError: (error: string) => void
}

export default class ChatService {
  private provider: LLMProvider | null = null
  private providerConfig: ProviderConfig | null = null
  // 维护当前会话的消息列表，供多轮上下文使用。
  private messages: ChatMessage[] = []
  private settingsPath: string
  // 用于取消正在进行的流式请求。
  private abortController: AbortController | null = null

  constructor() {
    this.settingsPath = join(app.getPath('userData'), 'chat-settings.json')
    this.loadSettings()
  }

  /** 获取当前 Provider 配置，返回 null 表示未配置。 */
  getSettings(): ProviderConfig | null {
    return this.providerConfig
  }

  /** 更新 Provider 配置并重建 Provider 实例。 */
  updateSettings(config: ProviderConfig): void {
    this.providerConfig = config
    this.provider = new OpenAIProvider(config)
    this.saveSettings()
  }

  /** 清空当前会话消息（新建对话）。 */
  clearMessages(): void {
    this.messages = []
  }

  /** 发送消息并流式返回结果。 */
  async sendMessage(userContent: string, callbacks: ChatCallbacks): Promise<void> {
    if (!this.provider) {
      callbacks.onError('未配置 LLM Provider。请先在设置中填写 API Key 和模型名称。')
      return
    }

    // 将用户消息加入历史。
    this.messages.push({ role: 'user', content: userContent })

    let fullText = ''

    try {
      const stream = this.provider.chat({
        messages: this.messages,
        stream: true
      })

      for await (const chunk of stream) {
        if (chunk.type === 'text_delta' && chunk.content) {
          fullText += chunk.content
          callbacks.onToken(chunk.content)
        }

        if (chunk.type === 'error') {
          callbacks.onError(chunk.error ?? '未知错误。')
          return
        }
      }

      // 将助手回复加入历史，以供后续对话使用。
      this.messages.push({ role: 'assistant', content: fullText })
      callbacks.onComplete(fullText)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      callbacks.onError(message)
    }
  }

  /** 取消当前流式请求（Day 4 仅做标志位，后续可扩展）。 */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  // ─── 配置持久化 ────────────────────────────────────────

  private loadSettings(): void {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = readFileSync(this.settingsPath, 'utf-8')
        const config: ProviderConfig = JSON.parse(raw)
        if (config.apiKey && config.baseURL && config.model) {
          this.providerConfig = config
          this.provider = new OpenAIProvider(config)
        }
      }
    } catch {
      // 文件不存在或格式错误，使用默认空配置。
    }
  }

  private saveSettings(): void {
    try {
      const dir = dirname(this.settingsPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.settingsPath, JSON.stringify(this.providerConfig, null, 2), 'utf-8')
    } catch {
      // 非关键操作，忽略写入失败。
    }
  }
}
```

#### D. 这段代码做了什么

- **`provider: LLMProvider | null`**：未配置时为 null。`sendMessage` 第一行守卫返回友好错误。
- **`messages: ChatMessage[]`**：在 service 内**也**维护一份历史——尽管 renderer store 也有一份。**为什么双份？** 因为多轮上下文的"权威源"在 service：每次 sendMessage 把当前所有 messages 发给 OpenAI；renderer 端的 messages 只是 UI 显示。`clearMessages` 同时被 IPC 调用，让两端同步重置。
- **`settingsPath = join(app.getPath('userData'), 'chat-settings.json')`**：Windows 下路径示例 `C:\Users\xxx\AppData\Roaming\Electron\chat-settings.json`（dev 模式 appName 是 'Electron'，正式打包后用真实 appName）。
- **`loadSettings`**：构造时读文件，存在且字段齐全就立刻 new OpenAIProvider。三个字段缺任何一个不加载——避免 "apiKey 为空但 baseURL 有" 这种半残状态。
- **`saveSettings`**：先 `existsSync(dir)` + `mkdirSync({ recursive: true })`——首次运行 userData 目录可能不存在。
- **`sendMessage` 主流程**：① 守卫；② push user 消息到 history；③ 拿 provider 的 AsyncIterable；④ for await 循环：text_delta 累加 + 推 token，error 立刻调 onError 并 return；⑤ 循环正常结束后 push assistant 消息；⑥ 调 onComplete。
- **`abortController`**：Day 4 占位，没真接到 OpenAI SDK 的 signal——OpenAI SDK v4 实际支持 `{ signal }` 第二参数，留给 Day 6 真正用户能"中断"长时间生成时再接入。
- **`text_delta && chunk.content`**：第二个条件是 narrow + 防 content 为空字符串。空字符串拼接没事，但调 onToken('') 让 renderer 多触发一次无意义渲染。

> **反例对比 1**：把 settings 持久化路径写成 `path.join(__dirname, 'chat-settings.json')`——`__dirname` 在打包后是 asar 包内的路径，**只读**，写入会抛 EROFS。永远用 `app.getPath('userData')` 存可写数据。

> **反例对比 2**：`messages.push(user) → 调 LLM 抛错 → user 消息留在 history 里污染下次对话`。本实现里 `try/catch` 包住整个流式循环，错误时 user 消息**确实**留在 history（这是有意设计——下一次重试会带上同一个 user）。如果想改成"出错回滚"，在 catch 里 `this.messages.pop()`。**两种行为都有合理性**，本日选择"保留以便重试"。

#### E. 验证

无独立验证。

---

### 5.5 步骤 5：新增 `electron/ipc/chat.ipc.ts`

#### A. 动机

把 ChatService 包装成 4 个 IPC channel + 3 个反向推送通道。这是项目第一次写 `webContents.send`。

#### B. 操作

在 `electron/ipc/` 建 `chat.ipc.ts`。

#### C. 完整代码

*文件 `electron/ipc/chat.ipc.ts`：*

```ts
/**
 * Day 4: Chat IPC 模块。
 *
 * 负责注册四个 IPC 通道：
 * 1. chat:send-message — 接收用户消息，触发流式生成，
 *    通过 webContents.send 向渲染进程推送 token/complete/error 事件。
 * 2. chat:get-settings — 读取当前 Provider 配置。
 * 3. chat:update-settings — 更新 Provider 配置。
 * 4. chat:clear — 清空对话历史。
 */

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import ChatService from '../services/agent/chat.service'

const chatService = new ChatService()

export function registerChatIpcHandlers(): void {
  ipcMain.removeHandler('chat:send-message')
  ipcMain.removeHandler('chat:get-settings')
  ipcMain.removeHandler('chat:update-settings')
  ipcMain.removeHandler('chat:clear')

  ipcMain.handle('chat:send-message', async (event: IpcMainInvokeEvent, message: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    // 安全发送：检查窗口是否已销毁。
    const safeSend = (channel: string, data: Record<string, unknown>): void => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }

    await chatService.sendMessage(message, {
      onToken(token: string) {
        safeSend('chat:stream', { token })
      },
      onComplete(fullText: string) {
        safeSend('chat:complete', { message: fullText })
      },
      onError(error: string) {
        safeSend('chat:error', { error })
      }
    })
  })

  ipcMain.handle('chat:get-settings', () => {
    return chatService.getSettings()
  })

  ipcMain.handle('chat:update-settings', (_event, config: { apiKey: string; baseURL: string; model: string }) => {
    chatService.updateSettings(config)
  })

  ipcMain.handle('chat:clear', () => {
    chatService.clearMessages()
  })
}
```

#### D. 这段代码做了什么

- **`BrowserWindow.fromWebContents(event.sender)`**：每个 IPC 调用都带 sender（发起请求的 webContents）。我们用它定位"哪个窗口要接收推送"。多窗口场景下这一步保证流式 token 推回**发起请求的那个窗口**而不是广播。
- **`safeSend`**：§4.4 已展开。单窗口场景理论上不会触发（窗口关闭主进程也跟着退出），但多窗口或主进程长生命周期时必须有。
- **回调对象**传给 service：onToken / onComplete / onError 三个方法分别推三个 channel。**channel 命名约定**：`chat:stream` / `chat:complete` / `chat:error`——前缀 `chat:` 与 invoke 通道（`chat:send-message`）保持一致便于过滤日志。
- **`async (event, message) => { await ... }`**：handler 是 async，await `sendMessage` 等流式全部跑完才 return。renderer 那边 `await window.api.sendChatMessage(...)` 在最后一颗 chunk 推完后才 resolve——可用作"知道流式结束"的备用信号（虽然我们已有 `chat:complete`）。
- **三个简单 handle**：get/update/clear 都同步操作，没有"流式"语义，普通 `handle` 足够。

> **反例对比**：把 `safeSend` 写成 `try { win.webContents.send } catch {}`——能跑，但会吞掉所有错误。`isDestroyed()` 是确定性判断，比 try/catch 更明确表达意图。

#### E. 验证

无独立验证。

---

### 5.6 步骤 6：修改 `electron/ipc/index.ts`

#### A. 动机

让聚合入口知道有 chat 模块。

#### B. 操作

在原 2 行 import + 2 行调用基础上各加一行。

#### C. 完整代码

*文件 `electron/ipc/index.ts`：*

```ts
import { registerFileSystemIpcHandlers } from './file-system.ipc'
import { registerTerminalIpcHandlers } from './terminal.ipc'
import { registerChatIpcHandlers } from './chat.ipc'

export function registerIpcHandlers(): void {
  registerTerminalIpcHandlers()
  registerFileSystemIpcHandlers()
  registerChatIpcHandlers()
}
```

#### D. 这段代码做了什么

新加的 `registerChatIpcHandlers` 在最后调用——chat 不依赖前两个 feature，顺序无所谓，但保持"按业务复杂度排序"的可读性。

> **反例对比**：在 main.ts 里直接 `import { registerChatIpcHandlers } from './ipc/chat.ipc'`——绕开 index 聚合层，未来 main.ts 又会膨胀。**永远只 import index**。

#### E. 验证

无。

---

### 5.7 步骤 7：修改 `electron/main.ts`

#### A. 动机

Day 4 的 main.ts **几乎不变**——证明 Day 3 的分层设计达到"加新功能不动 main.ts"的目标。仅修改两处注释字符串以反映本日。

#### B. 操作

把两处 "Day 3" 注释改成 "Day 4"。

#### C. 完整代码

*文件 `electron/main.ts`（仅展示变化的两行）：*

```ts
function createWindow(): void {
  // 创建主窗口：Day 4 增加 Chat 与 LLM 流式对话能力。
  // ...
}

app.whenReady().then(() => {
  // ...
  // Day 4: 统一注册终端、文件系统、Chat IPC 能力。
  registerIpcHandlers()
  // ...
})
```

其余 100% 与 Day 3 §5.6 相同——故省略。

#### D. 这段代码做了什么

零功能变更。**这正是 service+ipc 分层的回报**：Day 4 加了 4 个新 IPC channel + Provider 抽象 + service，main.ts 一行业务都没动。

> **反例对比**：如果 Day 3 没建 ipc/index.ts，本日 main.ts 就要多 5 行 chat 相关注册——每加一日要改一次 main.ts，污染 PR diff、增加冲突风险。

#### E. 验证

`npm run dev` 启动无错。

---

### 5.8 步骤 8：修改 `electron/preload.ts`

#### A. 动机

把 4 个新 invoke + 3 个事件订阅 API 暴露给 renderer。

#### B. 操作

整文件重写：在 Day 3 的 `api` 对象上扩展。

#### C. 完整代码

*文件 `electron/preload.ts`：*

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Day 4: 在文件系统/终端基础上，新增 Chat 对话相关 API。
const api = {
  // ── Day 2~3 保留 ──
  runCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command),
  getFileTree: () => ipcRenderer.invoke('file-system:get-tree'),
  readFile: (filePath: string) => ipcRenderer.invoke('file-system:read-file', filePath),

  // ── Day 4 新增：Chat ──
  sendChatMessage: (message: string) => ipcRenderer.invoke('chat:send-message', message),
  getChatSettings: () => ipcRenderer.invoke('chat:get-settings'),
  updateChatSettings: (config: { apiKey: string; baseURL: string; model: string }) =>
    ipcRenderer.invoke('chat:update-settings', config),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  // 监听主进程推送的流式事件，返回取消订阅函数。
  onChatStream: (callback: (data: { token: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { token: string }) => callback(data)
    ipcRenderer.on('chat:stream', handler)
    return () => { ipcRenderer.removeListener('chat:stream', handler) }
  },
  onChatComplete: (callback: (data: { message: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { message: string }) => callback(data)
    ipcRenderer.on('chat:complete', handler)
    return () => { ipcRenderer.removeListener('chat:complete', handler) }
  },
  onChatError: (callback: (data: { error: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { error: string }) => callback(data)
    ipcRenderer.on('chat:error', handler)
    return () => { ipcRenderer.removeListener('chat:error', handler) }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
```

#### D. 这段代码做了什么

- **4 个 invoke**：与 ipc 层的 channel 名严格对应。
- **3 个 on***：每个都是同一模式：① 在闭包里建 handler（吃掉 IpcRendererEvent 第一参数，只给 callback 传 data）；② `ipcRenderer.on(channel, handler)`；③ return `() => removeListener(channel, handler)`。**返回的 handler 引用必须与 on 时同一个**——`removeListener` 通过引用比较，传 lambda 删不掉。
- **`type IpcRendererEvent`**：仅类型导入（不运行时打包）。
- **不需要新加 channel 字符串到任何"常量表"**——本日仍硬编码字符串，Day 8 再统一抽。

> **反例对比**：preload 里 `ipcRenderer.on('chat:stream', (_, d) => callback(d))` 不返回任何东西——renderer 端无法 unsubscribe，StrictMode 双调用 + 多次组件挂载下会泄漏 listener。**始终返回 unsubscribe 函数**，这是 Electron preload 暴露事件 API 的标准模式。

#### E. 验证

DevTools console:

```js
typeof window.api.sendChatMessage    // 'function'
typeof window.api.onChatStream        // 'function'
```

---

### 5.9 步骤 9：修改 `src/vite-env.d.ts`

#### A. 动机

让 renderer 端 TS 知道 `window.api` 多了 7 个方法、并新增 `ChatMessageData` 类型。

#### B. 操作

在 Day 3 基础上加 `ChatMessageData` 接口、扩充 `RendererApi`。

#### C. 完整代码

*文件 `src/vite-env.d.ts`：*

```ts
/// <reference types="vite/client" />

declare module '*.css'

interface TerminalCommandResult {
	stdout: string
	stderr: string
	code: number
}

interface FileTreeNode {
	name: string
	path: string
	relativePath: string
	type: 'file' | 'directory'
	children?: FileTreeNode[]
}

interface WorkspaceTreeResult {
	workspaceRoot: string
	tree: FileTreeNode[]
}

// Day 4: Chat 消息类型。
interface ChatMessageData {
	id: string
	role: 'user' | 'assistant' | 'system'
	content: string
	timestamp: number
	isStreaming?: boolean
}

interface RendererApi {
	// Day 2~3
	runCommand: (command: string) => Promise<TerminalCommandResult>
	getFileTree: () => Promise<WorkspaceTreeResult>
	readFile: (filePath: string) => Promise<string>

	// Day 4: Chat
	sendChatMessage: (message: string) => Promise<void>
	getChatSettings: () => Promise<{ apiKey: string; baseURL: string; model: string } | null>
	updateChatSettings: (config: { apiKey: string; baseURL: string; model: string }) => Promise<void>
	clearChat: () => Promise<void>
	onChatStream: (callback: (data: { token: string }) => void) => () => void
	onChatComplete: (callback: (data: { message: string }) => void) => () => void
	onChatError: (callback: (data: { error: string }) => void) => () => void
}

declare global {
	interface Window {
		api: RendererApi
	}
}
```

#### D. 这段代码做了什么

- **`ChatMessageData`** 是**渲染层**专用类型（注意它有 `id / timestamp / isStreaming`，service 端的 `ChatMessage` 没有这些 UI 字段）。两端类型故意不一样——renderer 关心展示，service 关心 LLM 协议。
- **`isStreaming?: boolean`**：可选，仅最后一条 assistant 消息在流式时为 true，用来控制气泡末尾的闪烁光标。
- **`onChat*` 三个方法返回 `() => void`**：与 preload 实现签名严格对齐。

> **反例对比**：把 `ChatMessageData` 与 service 的 `ChatMessage` 合并为一个 type——会出现"renderer 拿到的消息没有 id"或"service 要传 timestamp 给 OpenAI"两种荒诞情况。**两层视角的类型分别定义**才稳。

#### E. 验证

IDE 自动补全 `window.api.` 应弹出 7 个新方法。

---

### 5.10 步骤 10：新增 `src/stores/chat.store.ts`

#### A. 动机

renderer 端的"消息列表 + streaming 状态"全局化。多个组件（ChatPanel 渲染 / ChatInput 禁用 / 未来 StatusBar 显示中）共享同一份数据。

#### B. 操作

新建 `src/stores/chat.store.ts`。

#### C. 完整代码

*文件 `src/stores/chat.store.ts`：*

```ts
/**
 * Day 4: Chat 全局状态管理。
 *
 * 核心状态：消息列表 + 是否正在流式输出 + 当前流式文本。
 * 设计原则：渲染层不直接调用 IPC，而是通过 store action 组合
 * invoke（发起请求）与 on/off（监听推送），保持组件简洁。
 */

import { create } from 'zustand'

interface ChatState {
  messages: ChatMessageData[]
  isStreaming: boolean
  currentStreamText: string

  // 发送消息：创建 user + streaming assistant 条目，调用 IPC。
  sendMessage: (content: string) => Promise<void>
  // 追加流式 token 到最后一条 assistant 消息。
  appendToken: (token: string) => void
  // 流式完成：固定最终文本并关闭 streaming 标志。
  handleComplete: (fullText: string) => void
  // 流式错误：写入错误文本并关闭 streaming 标志。
  handleError: (error: string) => void
  // 新建对话（清空前端 + 通知后端）。
  newConversation: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  currentStreamText: '',

  sendMessage: async (content: string) => {
    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now()
    }

    const assistantMsg: ChatMessageData = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true
    }

    set((state) => ({
      messages: [...state.messages, userMsg, assistantMsg],
      isStreaming: true,
      currentStreamText: ''
    }))

    try {
      await window.api.sendChatMessage(content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      get().handleError(message)
    }
  },

  appendToken: (token: string) => {
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

  handleComplete: (fullText: string) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1

      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: fullText || state.currentStreamText,
          isStreaming: false
        }
      }

      return { messages, isStreaming: false, currentStreamText: '' }
    })
  },

  handleError: (error: string) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1

      if (lastIdx >= 0 && messages[lastIdx].isStreaming) {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: `错误: ${error}`,
          isStreaming: false
        }
      }

      return { messages, isStreaming: false, currentStreamText: '' }
    })
  },

  newConversation: () => {
    window.api.clearChat()
    set({ messages: [], isStreaming: false, currentStreamText: '' })
  }
}))
```

#### D. 这段代码做了什么

- **3 个状态**：`messages` 是要渲染的列表；`isStreaming` 全局标志（用来在 UI 多处展示"生成中"）；`currentStreamText` 累计当前流式文本——理论上等于 `messages[last].content`，但单独存一份避免"读取最后一条消息"的样板代码。
- **`sendMessage` 的 happy-path**：一次性创建 **两条** 消息（user + 占位的 streaming assistant），原子 set。**为什么用占位 assistant 而不是等第一颗 token 到达再创建？** 因为：① 用户期望"按下发送立刻有响应反馈"——光标 + Generating 提示需要立刻出现；② 第一颗 token 到达时直接更新最后一条比"如果 last 是 user 就 push、否则更新 last" 简单。
- **`crypto.randomUUID()`**：浏览器原生，不依赖任何 npm 包。
- **`appendToken`**：immutable 更新——`...state.messages` 浅拷贝、`{ ...last, content: ... }` 浅拷贝最后一条。Zustand 比较新 messages 引用变化触发订阅者重渲染。**绝不能 `state.messages[last].content += token`**——直接 mutate 不会触发 Zustand 的订阅通知。
- **守卫 `if (messages[lastIdx].isStreaming)`**：避免错误时序（complete 后又来一颗 stray token）改到错误的消息。
- **`handleComplete` 用 `fullText || state.currentStreamText`**：服务端 onComplete 传的 fullText 与累积的 currentStreamText 应当一致；用 `||` 是双重保险（如果某 Provider 没传 fullText，回退到本地累积值）。
- **`handleError`**：把错误文本写入最后一条消息（用户能看到红色提示文字"错误: xxx"）。
- **`newConversation`**：先 `window.api.clearChat()` 通知 service 端清 messages history，再清 renderer state。**注意**没 await——清空操作很快，UI 不需要等。如果想保险可以 `await window.api.clearChat()` 后再 set。

> **反例对比 1**：在 store 里把 `appendToken` 写成 `set(state => ({ messages: state.messages.map(m => m.isStreaming ? {...m, content: m.content + token} : m) }))`——遍历整个数组找 streaming 那条。messages 长度大时低效，且如果有多条 streaming 会全更新。**直接用 lastIdx** 更准确高效。

> **反例对比 2**：`messages.push(...)` 直接 mutate——React 看到的是同一个数组引用，不重渲染。永远 immutable。

#### E. 验证

无独立验证。

---

### 5.11 步骤 11：修改 `src/stores/editor.store.ts`

#### A. 动机

新增 Chat 面板的开关状态。

#### B. 操作

在 EditorState 加 `isChatOpen / setChatOpen` 一对。

#### C. 完整代码

*文件 `src/stores/editor.store.ts`：*

```ts
import { create } from 'zustand'

// 定义编辑器 UI 相关的最小全局状态结构。
interface EditorState {
  isSidebarOpen: boolean
  isChatOpen: boolean
  openFilePath: string | null
  openFileContent: string
  setSidebarOpen: (open: boolean) => void
  setChatOpen: (open: boolean) => void
  setOpenFile: (filePath: string, content: string) => void
  setOpenFileContent: (content: string) => void
}

// Day 4: 增加 Chat 面板开关状态。
export const useEditorStore = create<EditorState>((set) => ({
  isSidebarOpen: true,
  isChatOpen: false,
  openFilePath: null,
  openFileContent: '',
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  setChatOpen: (open) => set({ isChatOpen: open }),
  setOpenFile: (filePath, content) =>
    set({
      openFilePath: filePath,
      openFileContent: content
    }),
  setOpenFileContent: (content) => set({ openFileContent: content })
}))
```

#### D. 这段代码做了什么

- 默认 `isChatOpen: false`——首启动 Chat 面板隐藏，避免新用户被"什么都没配置就先看到一个空 Chat"震惊。
- `setChatOpen` 走相同的 `set({ isChatOpen: open })`——可以接收 boolean 切换。
- **为什么 chat panel 状态放 editor.store 而不是 chat.store？** 因为面板**开关属于 UI 布局**而非"chat 业务"。chat.store 关心"消息内容"，editor.store 关心"哪个面板可见"。职责分明。

> **反例对比**：把 isChatOpen 放 chat.store——AppLayout 既要订阅 chat.store 又要订阅 editor.store，组件多一个依赖源。**布局相关状态都在 editor.store**。

#### E. 验证

无独立验证。

---

### 5.12 步骤 12：新增 `src/hooks/useChat.ts`

#### A. 动机

封装"挂载时订阅 3 个流式事件、卸载时解绑"的逻辑。让组件层（ChatPanel）只调一行 `useChat()` 就拿到 `sendMessage / isStreaming / newConversation`。

#### B. 操作

新建 `src/hooks/useChat.ts`。

#### C. 完整代码

*文件 `src/hooks/useChat.ts`：*

```ts
/**
 * Day 4: 封装 Chat 事件监听的自定义 Hook。
 *
 * 在组件挂载时注册 onChatStream / onChatComplete / onChatError，
 * 卸载时自动解注册，保证事件不泄漏。
 */

import { useEffect, useCallback } from 'react'
import { useChatStore } from '../stores/chat.store'

export function useChat() {
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const newConversation = useChatStore((s) => s.newConversation)

  useEffect(() => {
    // 从 store 获取最新引用（避免闭包过期）。
    const unsub1 = window.api.onChatStream((data) => {
      useChatStore.getState().appendToken(data.token)
    })

    const unsub2 = window.api.onChatComplete((data) => {
      useChatStore.getState().handleComplete(data.message)
    })

    const unsub3 = window.api.onChatError((data) => {
      useChatStore.getState().handleError(data.error)
    })

    return () => {
      unsub1()
      unsub2()
      unsub3()
    }
  }, [])

  const send = useCallback(
    async (content: string) => {
      await sendMessage(content)
    },
    [sendMessage]
  )

  return { sendMessage: send, isStreaming, newConversation }
}
```

#### D. 这段代码做了什么

- **`useChatStore((s) => s.xxx)`** 三次单字段订阅——每个 selector 只在对应字段变化时让本 hook 重渲染。
- **`useEffect(() => {...}, [])` 空依赖**：订阅一次，组件卸载时解绑。**callback 内部用 `useChatStore.getState().appendToken`** 而不是闭包捕获 `appendToken`——因为 effect 只跑一次，闭包里的 `appendToken` 引用永远是首次渲染时的版本。`getState()` 永远返回最新 store。
- **三个 unsubscribe 顺序解绑**——任意顺序皆可。
- **`useCallback`** 包 `send`——返回稳定引用，让 ChatInput / ChatPanel 在 dep 数组里写 `[sendMessage]` 时不会无意义重跑。
- **StrictMode 下双调用问题**：StrictMode 会让 effect 跑两次（第二次先 cleanup 再 setup）。第一次 setup 注册 listener → cleanup 解绑 → 第二次 setup 重新注册——最终只有 1 个 listener，正确。如果不返回 unsub，会变成 2 个 listener。

> **反例对比**：把 `useEffect` 依赖写成 `[appendToken, handleComplete, handleError]`——因为 store action 引用稳定（zustand 默认 set/get 函数不变），实际上不会重跑；但显式写 `[]` 更直白表达"只跑一次"意图。

#### E. 验证

无独立验证。

---

### 5.13 步骤 13：新增 `src/components/chat/ChatMessage.tsx`

#### A. 动机

单条消息气泡：用户右对齐 + 蓝头像、助手左对齐 + 灰头像、流式时末尾光标闪烁。

#### B. 操作

新建 `src/components/chat/` 目录，建 `ChatMessage.tsx`。

#### C. 完整代码

*文件 `src/components/chat/ChatMessage.tsx`：*

```tsx
import { User, Bot } from 'lucide-react'

interface ChatMessageProps {
  message: ChatMessageData
}

/**
 * Day 4: 单条消息渲染。
 * - 用户消息右对齐 + 蓝色头像。
 * - 助手消息左对齐 + 灰色头像。
 * - 流式输出时显示闪烁光标。
 */
export default function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })

  // 系统消息居中展示。
  if (message.role === 'system') {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-gray-500 bg-surface rounded px-3 py-1.5 max-w-[90%]">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* 头像 */}
      <div
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${
          isUser ? 'bg-blue-600' : 'bg-surface'
        }`}
      >
        {isUser ? (
          <User size={14} className="text-white" />
        ) : (
          <Bot size={14} className="text-blue-400" />
        )}
      </div>

      {/* 内容区 */}
      <div className={`flex-1 min-w-0 ${isUser ? 'flex flex-col items-end' : ''}`}>
        <div
          className={`inline-block max-w-full text-left rounded-lg px-3 py-2 text-sm ${
            isUser ? 'bg-surface' : ''
          }`}
        >
          <p className="text-foreground whitespace-pre-wrap break-words">{message.content}</p>
          {message.isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-middle rounded-sm" />
          )}
        </div>
        <p className="text-[10px] text-gray-600 mt-1 select-none">{time}</p>
      </div>
    </div>
  )
}
```

#### D. 这段代码做了什么

- **`isUser ? 'flex-row-reverse' : ''`**：Tailwind 的 `flex-row-reverse` 让 flex 子项逆序排——头像跑右边、气泡跑左边。React 节点顺序不变，CSS 翻转。
- **系统消息提前 return**：`system` role（Day 4 用不到，预留 Day 5+ 提示用）居中显示成小灰条。
- **气泡 `inline-block max-w-full`**：用户消息文字短时气泡只有一句话宽度（`inline-block`），文字长时撑满 max-w（受 `max-w-full` 限制）。**为什么用户消息有 `bg-surface`、助手消息没有？** VS Code Copilot 风格——助手消息直接平铺在背景上更像"被讲解"，用户消息有底色更像"输入"。
- **`whitespace-pre-wrap`**：保留消息中的换行（`\n`）、保留空格。`break-words` 防止超长 URL 撑爆容器。
- **闪烁光标**：仅在 `isStreaming === true` 时渲染——`<span animate-pulse>`。Tailwind `animate-pulse` 是内置 CSS 动画。`align-middle` 让光标与文字基线对齐。
- **时间戳 `text-[10px] select-none`**：极小字号 + 不可选中——避免用户拖选消息内容时连带选中时间。

> **反例对比**：用 `<div onClick>` + `cursor-pointer` 让用户能"点消息复制"——本日不做这种功能；保持单条消息纯展示。Day 8 设计系统会加 hover 工具条（复制 / 重新生成）。

#### E. 验证

无独立验证。

---

### 5.14 步骤 14：新增 `src/components/chat/ChatInput.tsx`

#### A. 动机

底部输入框：textarea 自适应高度、Enter 发送 / Shift+Enter 换行、流式期间禁用。

#### B. 操作

新建 `src/components/chat/ChatInput.tsx`。

#### C. 完整代码

*文件 `src/components/chat/ChatInput.tsx`：*

```tsx
import { useRef, useState, useCallback, type KeyboardEvent, useEffect } from 'react'
import { SendHorizontal } from 'lucide-react'

interface ChatInputProps {
  onSend: (message: string) => void
  isStreaming: boolean
}

/**
 * Day 4: 聊天输入框。
 * 支持 Enter 发送、Shift+Enter 换行、自动高度调节。
 */
export default function ChatInput({ onSend, isStreaming }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 根据内容自动调节高度，最大 160px。
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  useEffect(() => {
    adjustHeight()
  }, [value, adjustHeight])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, isStreaming, onSend])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="p-3 border-t border-border">
      <div className="flex items-end gap-2 bg-surface rounded-lg border border-border focus-within:border-blue-500 transition-colors">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，按 Enter 发送..."
          disabled={isStreaming}
          rows={1}
          className="flex-1 bg-transparent px-3 py-2.5 text-sm text-foreground placeholder:text-gray-500 resize-none outline-none max-h-[160px] disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!value.trim() || isStreaming}
          className="p-2 m-1 rounded-md text-blue-400 hover:bg-[#2a2d2e] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
          title="发送消息"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}
```

#### D. 这段代码做了什么

- **受控 textarea**：value + onChange 标配。
- **`adjustHeight` § 4.8 已展开**——先设 auto 再读 scrollHeight 再 cap 到 160。`useCallback([])` 让函数引用稳定，effect dep 不会无谓重跑。
- **`useEffect([value, adjustHeight])`**：每次 value 变化都跑 adjustHeight。adjustHeight 是 stable 引用，实际只在 value 变时触发。
- **`handleSend`**：`trim` + 守卫 isStreaming + 非空。发送后清空 value 并重置 textarea 高度（清空 value 会触发 effect 跑 adjustHeight，**但 adjustHeight 内部基于 scrollHeight，空字符串的 scrollHeight 等于 1 行高度——已经是最小**）。这里冗余多写一行 `style.height = 'auto'` 是为了视觉上**立刻**看到高度收缩，不等 React 下一帧。
- **`handleKeyDown`**：Enter（无 shift）= 发送，preventDefault 防换行；Shift+Enter 自然换行（不调 preventDefault）。
- **`focus-within:border-blue-500`**：Tailwind 伪类，文本框聚焦时整个外框（包含发送按钮）边框变蓝。比单独给 textarea border 更统一。
- **`flex items-end`**：textarea 多行变高时，发送按钮始终贴在底部对齐 textarea 底边。
- **`disabled` 双触发**：流式中或值为空都禁用。`disabled:opacity-30` Tailwind 状态 variant。

> **反例对比 1**：textarea 不限 max-h——用户粘 1000 行内容会把整个 Chat 面板撑爆。`max-h-[160px] resize-none` 配合 `overflow` 自动出滚动条。

> **反例对比 2**：用 `<input>` 替代 `<textarea>`——失去多行能力，长 prompt 没法看全。永远用 textarea。

#### E. 验证

无独立验证。

---

### 5.15 步骤 15：新增 `src/components/chat/ChatPanel.tsx`

#### A. 动机

把 ChatMessage 列表 + ChatInput 组合成完整面板：标题栏 + 自动滚底 + 流式指示条。

#### B. 操作

新建 `src/components/chat/ChatPanel.tsx`。

#### C. 完整代码

*文件 `src/components/chat/ChatPanel.tsx`：*

```tsx
import { useEffect, useRef } from 'react'
import { Plus, Settings, Loader2 } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useChat } from '../../hooks/useChat'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'

/**
 * Day 4: Chat 面板——消息列表 + 流式指示器 + 输入框。
 *
 * 职责：
 * 1. 渲染消息列表并自动滚动到底部。
 * 2. 提供新建对话 / 打开设置的入口。
 * 3. 流式输出时显示 "Generating..." 指示器。
 */
export default function ChatPanel() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)

  const { sendMessage, newConversation } = useChat()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 每次消息变化后自动滚动到底部。
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 h-10 min-h-10 border-b border-border">
        <span className="text-xs font-semibold tracking-wider text-gray-400">
          AI ASSISTANT
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={newConversation}
            className="p-1.5 rounded hover:bg-[#2a2d2e] text-gray-400 hover:text-white transition-colors cursor-pointer"
            title="新建对话"
          >
            <Plus size={16} />
          </button>
          <button
            className="p-1.5 rounded hover:bg-[#2a2d2e] text-gray-400 hover:text-white transition-colors cursor-pointer"
            title="设置（Day 4 暂不实现弹窗，请通过开发者工具调用 window.api.updateChatSettings）"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 select-none">
            <p className="text-sm">在下方输入框中发送消息</p>
            <p className="text-xs mt-1 opacity-60">按 Enter 发送，Shift+Enter 换行</p>
          </div>
        ) : (
          messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 流式输出指示器 */}
      {isStreaming && (
        <div className="flex items-center justify-center gap-2 py-1.5 text-xs text-gray-500 border-t border-border/50">
          <Loader2 size={12} className="animate-spin text-blue-400" />
          <span>Generating...</span>
        </div>
      )}

      {/* 输入区 */}
      <ChatInput onSend={sendMessage} isStreaming={isStreaming} />
    </div>
  )
}
```

#### D. 这段代码做了什么

- **`useChatStore((s) => s.messages)` + `useChatStore((s) => s.isStreaming)`** 两个独立 selector——比 `const { messages, isStreaming } = useChatStore()` 更严格（后者整个 store 任意字段变都触发本组件重渲染）。
- **`useChat()`** 在挂载时订阅 3 个事件——只要 ChatPanel 挂载，事件就被消费；ChatPanel 卸载（用户关闭 Chat 面板）时自动解绑。**关键设计**：事件订阅生命周期与面板组件生命周期绑定，不在 App 层做。如果用户关闭 Chat 面板，新到的 token 也不会触发 store 更新——但 service 端历史已经记录，下次打开看不到这次中断的回复（按日设计简化，Day 6+ 可改成 App 级订阅）。
- **`messagesEndRef.scrollIntoView({ behavior: 'smooth' })`**：经典自动滚底模式。`<div ref={messagesEndRef} />` 是个零高度的"锚点"，每次 messages 变化时滚到它处。`smooth` 平滑动画。
- **空状态**：`messages.length === 0` 时显示引导文字。空消息时 `messagesEndRef` 仍然渲染，但 effect 中 `messagesEndRef.current?.scrollIntoView` 会调一次（无内容时滚动无视觉效果）。
- **流式指示条**：`Loader2 animate-spin` + "Generating..."。**位置在输入框上方而非消息中**——给一个稳定不动的状态指示，比"看气泡末尾光标"更明显。
- **`<ChatInput onSend={sendMessage} isStreaming={isStreaming} />`**：把 hook 拿到的 sendMessage 与 store 的 isStreaming 透传给输入框。

> **反例对比 1**：用 `useEffect([])` 一次性 ref + `setTimeout(() => scrollIntoView(), 0)`——丑陋。`useEffect([messages])` 是 React 标准模式：状态变化驱动 DOM 操作。

> **反例对比 2**：把 `useChat()` 调用放 ChatInput 内——ChatInput 卸载（textarea blur 不卸载，但 panel 关闭时一起卸）后事件解绑。看起来差不多但语义乱：input 不该负责消息流订阅。**生命周期匹配语义边界**。

#### E. 验证

`npm run dev` 后打开 Chat 面板（步骤 16 接入后）能看到完整 UI。

---

### 5.16 步骤 16：修改 `src/components/layout/AppLayout.tsx`

#### A. 动机

把 Chat 面板挂到三段式布局右侧；活动栏多一个 💬 切换按钮。

#### B. 操作

整文件重写：① 加 `import ChatPanel`、`MessageSquare`；② 解构出 `isChatOpen / setChatOpen`；③ 活动栏加按钮；④ PanelGroup 末尾追加条件渲染的 ResizeHandle + Panel。

#### C. 完整代码

*文件 `src/components/layout/AppLayout.tsx`：*

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import { FileCode, TerminalSquare, MessageSquare } from 'lucide-react'
import { useEditorStore } from '../../stores/editor.store'
import MonacoWrapper from '../editor/MonacoWrapper'
import TerminalInstance from '../terminal/TerminalInstance'
import ChatPanel from '../chat/ChatPanel'

export default function AppLayout() {
  // 从全局状态读取侧边栏与 Chat 面板开关。
  const { isSidebarOpen, isChatOpen, setChatOpen } = useEditorStore()

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* 主内容区：活动栏 + 侧边栏 + 主工作区 + Chat 面板 */}
      <div className="flex-1 flex overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* 活动栏：Day 4 聊天图标可切换 Chat 面板。 */}
          <div className="w-12 shrink-0 bg-surface border-r border-border flex flex-col items-center py-2 gap-4">
            <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
              <FileCode size={24} />
            </button>
            <button
              onClick={() => setChatOpen(!isChatOpen)}
              className={`p-2 rounded cursor-pointer ${isChatOpen ? 'text-white bg-[#2a2d2e]' : 'text-gray-400 hover:text-white'}`}
              title="切换 AI 对话面板"
            >
              <MessageSquare size={24} />
            </button>
          </div>

          {/* 可折叠侧边栏（文件树） */}
          {isSidebarOpen && (
            <>
              <Panel defaultSize={20} minSize={15} maxSize={30}>
                <Sidebar />
              </Panel>
              <PanelResizeHandle className="w-1 bg-border hover:bg-blue-500 transition-colors" />
            </>
          )}

          {/* 主工作区：Monaco + 终端 */}
          <Panel defaultSize={isChatOpen ? 55 : 80}>
            <PanelGroup direction="vertical">
              {/* Day 4: Monaco 展示真实文件内容。 */}
              <Panel defaultSize={70}>
                <div className="h-full bg-background border-b border-border">
                  <MonacoWrapper />
                </div>
              </Panel>

              <PanelResizeHandle className="h-1 bg-border hover:bg-blue-500 transition-colors" />

              {/* 保留终端 */}
              <Panel defaultSize={30}>
                <div className="h-full flex flex-col bg-surface">
                  <div className="h-8 border-b border-border flex items-center px-4">
                    <TerminalSquare size={14} className="mr-2" />
                    <span className="text-xs uppercase font-semibold">Terminal</span>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <TerminalInstance />
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          {/* Day 4: 可折叠 Chat 面板 */}
          {isChatOpen && (
            <>
              <PanelResizeHandle className="w-1 bg-border hover:bg-blue-500 transition-colors" />
              <Panel defaultSize={25} minSize={20} maxSize={40}>
                <ChatPanel />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* 状态栏固定在底部。 */}
      <StatusBar />
    </div>
  )
}
```

#### D. 这段代码做了什么

- **活动栏不在 PanelGroup 内**：`<div className="w-12 shrink-0 ...">` 平铺在 `<PanelGroup>` 旁边——固定 48px、不参与拖动。
- **MessageSquare 按钮**：`onClick={() => setChatOpen(!isChatOpen)}` 切换。`isChatOpen` 时 `bg-[#2a2d2e]` 高亮，配合 `text-white`——视觉反馈"当前激活面板"。
- **`<Panel defaultSize={isChatOpen ? 55 : 80}>`**：主工作区随 Chat 开/关动态切默认尺寸。**注意**：`defaultSize` 只在 panel 首次挂载时生效——但这里 panel 在两种状态下都挂载（不在条件块里），所以 `isChatOpen` 切换时 react-resizable-panels 会**重新归一化**剩余空间。100 - 12(活动栏忽略) - 20(sidebar) = 68；isChatOpen 时 main:55 + handle:1 + chat:25 = 81；不开时 main:80。**注意比例**：默认值要与最终所有 panel 的 size 之和大致协调，否则首次渲染会有跳动。
- **`{isChatOpen && (<><PanelResizeHandle /><Panel /></>)}`**：注意 ResizeHandle 与 Panel **同时**渲染、同时卸载——这是 react-resizable-panels 的硬性要求（panels 与 handles 必须严格成对）。如果只渲染 Panel 漏掉 Handle，运行时会抛 invariant。

> **反例对比 1**：把活动栏写在 PanelGroup 内 `<Panel defaultSize={5}>`——用户能拖动活动栏改宽度，破坏 VS Code 视觉规范。固定 UI 用普通 div + `shrink-0`。

> **反例对比 2**：`<Panel defaultSize={isChatOpen ? 55 : 80}>` 上挂 `key={isChatOpen}`——每次切换强制 panel 重新挂载。会导致编辑器内容、终端会话全部重置，灾难性。**Panel 不该按状态加 key**。

#### E. 验证

`npm run dev` 后点活动栏 💬 应能开 / 关 Chat 面板；编辑器与终端宽度自适应。

---

### 5.17 步骤 17：修改 `src/components/layout/StatusBar.tsx`

#### A. 动机

仅文案 "Day 3 File System" → "Day 4 Chat + LLM"。

#### B. 操作

改一行字符串。

#### C. 完整代码

*文件 `src/components/layout/StatusBar.tsx`（仅展示变化部分）：*

```tsx
return (
  <div className="h-6 bg-blue-600 text-white text-xs flex items-center px-4 shrink-0 transition-colors">
    <span className="font-semibold">Day 4 Chat + LLM</span>
    <span className="mx-4 opacity-50">|</span>
    <span>{fileLabel}</span>
  </div>
)
```

其余代码（`useMemo` 计算 `fileLabel`、`useEditorStore` 解构）与 Day 3 §5.14 完全一致。

#### D. 这段代码做了什么

零功能变化——纯标识当前日。

> **反例对比**：把"是否在流式生成"也加到 StatusBar——StatusBar 要再订阅 chat.store。本日不必，让 StatusBar 保持极薄。Day 8 设计系统统一时再考虑信息密度。

#### E. 验证

启动后状态栏显示 "Day 4 Chat + LLM"。

---

### 5.18 步骤 18：修改 `src/components/terminal/TerminalInstance.tsx`

#### A. 动机

仅欢迎语 "Day 3 Terminal Ready" → "Day 4 Terminal Ready"。

#### B. 操作

改一行字符串。

#### C. 完整代码

*文件 `src/components/terminal/TerminalInstance.tsx`（仅展示变化的那一行）：*

```tsx
terminal.writeln('Day 4 Terminal Ready')
```

其余代码（xterm 初始化、PROMPT 处理、onData 回调、cleanup）与 Day 3 §5.15 完全一致。

#### D. 这段代码做了什么

零功能变化。

> **反例对比**：每天都"顺便"重构一下 TerminalInstance——读者无法识别 Day 4 真正学到的新概念是什么。**未变更代码就保持不变**。

#### E. 验证

启动后终端首行 "Day 4 Terminal Ready"。

---

## 6. 端到端串联走查

以「用户问 "你好"」追完整链路：

| 步骤 | 文件 | 关键代码 |
|---|---|---|
| ① 输入 + Enter | `ChatInput` | `handleKeyDown`: Enter 无 shift → `handleSend()` → `onSend(trimmed)` |
| ② 透传 | `ChatPanel` | `<ChatInput onSend={sendMessage}>` （`sendMessage` 来自 `useChat()`） |
| ③ hook → store | `useChat` | `send = useCallback` 直接调 `useChatStore.s.sendMessage` |
| ④ 乐观更新 | `chat.store.sendMessage` | push user 气泡 + push 占位 streaming assistant 气泡 + setStreaming(true) |
| ⑤ IPC invoke | `chat.store.sendMessage` | `await window.api.sendChatMessage(content)` |
| ⑥ preload | `electron/preload.ts` | `ipcRenderer.invoke('chat:send-message', message)` |
| ⑦ ipc handler | `electron/ipc/chat.ipc.ts` | 拿 win + safeSend + `await chatService.sendMessage(message, callbacks)` |
| ⑧ service | `chat.service.ts` | push user 到 history → `provider.chat({messages, stream:true})` |
| ⑨ provider | `openai.provider.ts` | `client.chat.completions.create({stream:true})` → `for await` 每个 SDK chunk → yield `{type:'text_delta', content}` |
| ⑩ service for-await | `chat.service.ts` | 收 text_delta → fullText += content → `callbacks.onToken(content)` |
| ⑪ ipc 推送 | `chat.ipc.ts` | onToken: `safeSend('chat:stream', {token})` → renderer |
| ⑫ preload listener | `electron/preload.ts` | `ipcRenderer.on('chat:stream', handler)` 已被 useChat 注册过 |
| ⑬ store 追加 | `useChat` | `useChatStore.getState().appendToken(data.token)` → set 新 messages |
| ⑭ 重渲染 | `ChatMessage` | last message content 更新 → `<p>` 内文字增长 → 闪烁光标仍显示 |
| ⑮ 流式结束 | `chat.service.ts` | for-await 跳出 → push assistant 到 history → `callbacks.onComplete(fullText)` |
| ⑯ 推送 complete | `chat.ipc.ts` | `safeSend('chat:complete', {message: fullText})` |
| ⑰ store 收尾 | `useChat` | `handleComplete(data.message)` → 关闭 isStreaming + 清光标 |
| ⑱ ipc.handle resolve | `chat.ipc.ts` | `await chatService.sendMessage` 返回 → handler 函数 return |
| ⑲ renderer await 解 | `chat.store.sendMessage` | `await window.api.sendChatMessage` resolve → sendMessage 函数返回 |

**两个并行通道**（invoke + 多次 send）通过同一份 `messages` 数据在 service / store 双端同步，invoke 的 await 仅作"完成确认"。

---

## 7. 完整运行流程追踪

`npm install && npm run dev` 后内部时序：

1. **TS 编译**：electron-vite 比 Day 3 多编译 4 个 main 文件（base.provider / openai.provider / chat.service / chat.ipc）+ 4 个 renderer 文件（chat.store / useChat / ChatMessage / ChatInput / ChatPanel——后者其实 5 个）。`openai` SDK 约 800KB 被打包进 main bundle（不进 renderer）。
2. **主进程冷启动**：`registerIpcHandlers()` → 顺序执行 terminal → file-system → chat 三个注册。`new ChatService()` 在 chat.ipc.ts 模块顶层执行：① `app.getPath('userData')` 拿路径；② 尝试读 `chat-settings.json`：a. 第一次启动文件不存在，loadSettings 静默失败，provider/providerConfig 保持 null；b. 之后启动文件存在，立刻 new OpenAIProvider 复活上次配置。
3. **renderer 启动**：StrictMode → AppLayout → Sidebar / Monaco / Terminal / 不渲染 Chat（isChatOpen=false）。
4. **用户配置 LLM**：DevTools console `await window.api.updateChatSettings({...})` → IPC `chat:update-settings` → `service.updateSettings(config)` → `new OpenAIProvider(config)` + `saveSettings()` 写文件。
5. **用户点 💬**：`setChatOpen(true)` → store 通知 → AppLayout 重渲染 → 右侧 Panel 挂载 ChatPanel → ChatPanel 内 `useChat()` 触发 effect → 注册 3 个 ipcRenderer.on listener。
6. **用户输入并发送**：链路如 §6。第一颗 token 通常在 100~500 ms 内到达（取决于 LLM 服务器与网络），后续 token 间隔 20~80 ms。
7. **关闭 Chat 面板**：`setChatOpen(false)` → ChatPanel 卸载 → useChat effect cleanup → 3 个 unsubscribe 调用 → 主进程之后再发的 token 推送到 renderer 后没人接，被 ipcRenderer 静默丢弃。
8. **关闭应用**：window-all-closed → app.quit()。如果用户关窗时正在流式，`safeSend` 在 `win.isDestroyed()` 时跳过 send；`for await` 仍在跑（OpenAI SDK 的 fetch 没被 abort），但回调全部 noop。这是 Day 4 的已知小缺陷——Day 6 引入 AbortController 真正接 SDK signal 时修复。
9. **热重启时序**：保存 main 文件 → electron-vite 重启主进程 → chat.ipc.ts 顶层 `new ChatService()` 再跑一次 → settings 文件被重新加载（Provider 复活）→ messages 历史被**清空**（service 是新实例）→ 注意：renderer 不重启，store 仍有旧消息 → 此时再发送会"renderer 看到完整对话历史，但 service 只看到这一句新消息"，多轮上下文实际丢失。这是开发期已知现象，刷新 renderer（Ctrl+R）能让两边状态对齐。

---

## 8. 必学知识点深化

### 8.1 流式数据与 React 渲染节流

每秒到 50+ 个 token 时，`appendToken` 触发 50+ 次 setState → React 重渲染 ChatMessage 50+ 次。本日 React 19 + Zustand 性能足够（每帧渲染单条 `<p>` < 1ms），**无感**。但当：① 切换到 markdown 渲染（Day 8）每次重新解析整段 markdown；② 消息超长（5000+ 字符）时 reflow 成本上升时，需要：
- `requestAnimationFrame` 节流：把多个 token 累积到下一帧一次性应用。
- 把"流式中的最新文本"分离出主消息列表，独立成 `<StreamingMessage>` 单组件——避免整个列表重渲染。

Day 8 设计系统升级会引入这两个优化。

### 8.2 OpenAI 兼容生态

只要服务实现了 `POST /v1/chat/completions` + 支持 `stream: true` 返回 SSE，就能用 OpenAIProvider 接入：
- DeepSeek: `baseURL: 'https://api.deepseek.com/v1'`, model `'deepseek-chat'` / `'deepseek-reasoner'`
- Moonshot Kimi: `baseURL: 'https://api.moonshot.cn/v1'`, model `'moonshot-v1-8k'`
- 本地 Ollama: 启动 `ollama serve`，`baseURL: 'http://localhost:11434/v1'`, apiKey 任意填，model `'qwen2.5-coder'` / `'llama3.1'`
- 字节 Doubao（火山方舟）: `baseURL: 'https://ark.cn-beijing.volces.com/api/v3'`

非兼容协议（Anthropic Claude 原生 API）需要单独写 ClaudeProvider——这正是 §4.1 接口抽象的存在意义。

### 8.3 SSE 是怎么工作的（理解 OpenAI SDK 黑盒）

`stream: true` 的 HTTP 响应头是 `Content-Type: text/event-stream`，body 形如：

```
data: {"choices":[{"delta":{"role":"assistant"}}]}

data: {"choices":[{"delta":{"content":"你"}}]}

data: {"choices":[{"delta":{"content":"好"}}]}

data: [DONE]

```

每条以空行分隔。OpenAI SDK 内部用 `fetch` + `ReadableStream.getReader()` 逐行解析、按 `data: ` 前缀切分、`JSON.parse` 后封成 chunk 对象。我们用 SDK 时拿到的是已经解析好的 JS 对象——但理解底层让你能在出问题（连接被代理截断、JSON 解析错误）时定位。

---

## 9. 自测清单

- [ ] `npm install && npm run dev` 启动无报错。
- [ ] 启动后右侧默认无 Chat 面板（`isChatOpen: false`）。
- [ ] 活动栏 💬 图标点击切换 Chat 面板（对应 §1.1 目标 1）。
- [ ] DevTools 调 `updateChatSettings` 后立刻可发消息，不需重启。
- [ ] 助手回复气泡内文字一颗颗追加，末尾有蓝色闪烁光标（对应 §1.1 目标 3）。
- [ ] 流式期间输入框被禁用、发送按钮变灰（`isStreaming` 同步生效）。
- [ ] 流式期间面板上方出现旋转 Loader2 + "Generating..."。
- [ ] 完成后光标消失、最终全文保留。
- [ ] 多轮上下文：连问 "我叫小明" → "我叫什么" → 助手能答 "小明"（对应 §1.1 目标 4）。
- [ ] 「+」按钮清空消息列表 + 后端历史也被清（再问一次"我叫什么"应回不知道）（对应 §1.1 目标 5）。
- [ ] 关闭并 `npm run dev` 重启后无需再 `updateChatSettings` 直接能发（对应 §1.1 目标 6）。
- [ ] 故意把 apiKey 改无效 → 助手气泡显示 "错误: ..."；UI 不卡死、新建对话后能继续输入。
- [ ] Enter 发送、Shift+Enter 换行；textarea 高度自适应到 160px 上限后出滚动条。
- [ ] 关闭 Chat 面板再打开，消息列表保持（store 没卸载）。
- [ ] Day 1-3 全部功能可用：编辑器加载文件 / 文件树展开折叠 / 终端跑 `node -v` / 侧栏拖动 / Sidebar X 折叠（对应 §1.1 目标 7）。
- [ ] 状态栏显示 "Day 4 Chat + LLM"。
- [ ] 终端首行显示 "Day 4 Terminal Ready"。

# Day 8：Inline Diff 审核 + 设计系统 + 扩展设置

## 0. 前言

Day 7 让 Agent 拥有了 `edit_file` 和 `run_command` 这样的「写工具」与「执行工具」。但是它写得越果断，开发者就越焦虑：每次 Agent 修改文件都是直接落盘，等你回过神来打开 Git 一看，它已经把整个项目改了一圈。事后审核（看 diff）当然可以，但**事前/事中审核**才是符合人类工作习惯的方式：每改一个文件，让我先看看，按 Accept 才生效。

Day 8 解决三件事：

1. **Inline Diff 审核流**：给 `edit_file` / `write_file` 加上一条「文件变更事件」总线（main → IPC → renderer → editor.store.pendingDiffs），并在编辑器区里渲染一个左旧右新的 diff 视图，配 Accept / Reject 按钮。Reject 时通过 `chat:revert-file` IPC 把旧内容写回。
2. **设计系统统一化**：之前写组件用 `bg-gray-800`、`text-amber-400` 这类 Tailwind 调色板拼凑，缺少统一语言。本日把全套色彩抽成 CSS 变量（`--color-bg-primary`、`--color-accent`…），所有组件迁移到「var token」写法，并补上 fade-in / shimmer / pulse-glow 等通用动画。
3. **扩展设置**：在 SettingsDialog 加上 System Prompt（追加给 Agent 的额外指令）、Max Iterations（防止 Agent 死循环）、Temperature（控制随机性）三项；端到端把这三个参数塞进 `ProviderConfig` → ChatService → AgentLoop。

不会做的事：

- 不引入第三方 diff 库（写一个 LCS 教学版自己跑）。
- 不拆 design tokens 到独立文件（保持单一 `main.css` 便于教学审视）。
- 不做 Accept/Reject 的批量操作（一次审一个文件）。

## 1. 目标产出

完成本日代码后应当具备：

1. Agent 调用 `edit_file` / `write_file` 修改文件后，编辑器区会自动弹出 Inline Diff 视图（左旧右新，绿增红删，行号双列）。
2. Diff 视图顶部有 Accept / Reject 按钮：Accept 接受变更，Reject 把文件恢复成旧内容。
3. 多个文件等待审核时，编辑器区顶部出现「待审核」标签栏，可点击切换。
4. 全套界面色彩通过 `:root` 上的 CSS 变量统一管理；所有组件改为 `var(--color-xxx)` token 写法。
5. 提供 6 套通用动画类：`animate-fade-in`、`animate-fade-in-scale`、`animate-slide-right`、`animate-slide-left`、`animate-pulse-glow`、`animate-shimmer`、`animate-typing-cursor`。
6. SettingsDialog 新增 System Prompt（textarea）、Max Iterations（1~30 滑杆）、Temperature（0~2 滑杆）。
7. `ProviderConfig` 持久化包含上述三个新字段；`AgentLoop` 构造时读取并应用。
8. 首次启动若无配置，ChatService 自动注入一份默认 Ollama 配置（无需用户手填即可冒烟）。
9. AgentLoop 完成后把完整对话历史（含 tool_calls / tool 消息）写回 ChatService.messages，下一轮对话保留工具上下文。
10. 模型在纯文本中错误地把 tool_call 拼成 JSON 时，AgentLoop 能从文本中解析出工具调用并补救执行（Ollama 兼容回退）。

## 2. 先跑起来

```powershell
cd GUIDE\day8
pnpm install
pnpm dev
```

冒烟流程：

1. 不配置任何 API Key，启动后 ChatService 默认连本地 Ollama（`http://localhost:11434/v1`，模型 `qwen2.5-coder:32b-instruct-q4_K_M`）。如果你没装 Ollama，点齿轮换成你自己的 OpenAI 配置。
2. 让 Agent：「在工作区根目录创建一个 hello.txt，写入 Hello Day 8」。
3. 工具调用块出现 `write_file` → 完成后，编辑器区自动跳出 Inline Diff 视图，显示「(空) → Hello Day 8」，按钮 Accept / Reject 可见。
4. 点 Accept → diff 视图关闭，编辑器内容变成 Hello Day 8。
5. 让 Agent：「把 hello.txt 第一行改成 Hi Day 8」。Diff 视图再次出现，绿色 +Hi 红色 -Hello。
6. 点 Reject → 编辑器和磁盘都恢复成 Hello Day 8（背后是 IPC `chat:revert-file` 把旧内容写回）。
7. 打开齿轮 → SettingsDialog → 拖 Temperature 滑杆到 0.2 → 保存 → 再发起对话观察 Agent 输出更稳定。
8. 把 Max Iterations 拉到 1 → 让 Agent 跑「请帮我重构整个项目」→ 第 1 轮就停止并返回「已达到最大迭代次数」错误。
9. 在 System Prompt 里写「回答全部用 emoji 开头」→ 保存 → 下一轮回答会带 emoji。

## 3. 整体结构

### 3.1 目录树

```
day8/
├── electron/
│   ├── preload.ts                              # +onChatFileChange / +revertFileChange
│   ├── ipc/chat.ipc.ts                         # +chat:file-change 事件 / +chat:revert-file
│   └── services/agent/
│       ├── agent-loop.ts                       # +文本回退解析 +onFileChange 透传 +options
│       ├── chat.service.ts                     # +默认配置 +持久化对话历史 +参数透传
│       ├── providers/
│       │   ├── base.provider.ts                # +systemPrompt/maxIterations/temperature
│       │   └── openai.provider.ts              # +temperature 入参 +Ollama 兜底逻辑
│       └── tools/
│           ├── tool-registry.ts                # +ToolContext.onFileChange
│           ├── edit-file.tool.ts               # +调用 onFileChange
│           └── write-file.tool.ts              # +调用 onFileChange
└── src/
    ├── main.css                                # ★ 设计系统（颜色 token + 动画）
    ├── vite-env.d.ts                           # +FileChangeInfo +onChatFileChange/revertFileChange
    ├── stores/editor.store.ts                  # +pendingDiffs/activeDiff +addPendingDiff/review/accept/reject
    ├── hooks/useChat.ts                        # +订阅 onChatFileChange
    └── components/
        ├── editor/
        │   ├── EditorArea.tsx                  # ★ 新增：Pending Diff 标签栏 + 编辑器主体
        │   ├── InlineDiffView.tsx              # ★ 新增：LCS diff + Accept/Reject UI
        │   └── MonacoWrapper.tsx               # 当 activeDiff 存在时切到 InlineDiffView
        ├── settings/SettingsDialog.tsx         # +System Prompt/Max Iterations/Temperature
        └── chat/ChatPanel.tsx                  # 颜色 token 化 + 动画细节
```

### 3.2 数据链路

```
LLM 流式响应 → tool_calls(edit_file)
  └─ AgentLoop → ToolRegistry.execute('edit_file', args, ctx)
        └─ editFileTool.execute
              ├─ fs.readFile  →  oldContent
              ├─ fs.writeFile →  落盘 newContent
              └─ ctx.onFileChange?.({ filePath, oldContent, newContent, toolName })
                    ↑ 透传自 AgentLoop callbacks.onFileChange
                          ↑ 透传自 ChatService callbacks.onFileChange
                                ↑ 注册自 chat.ipc.ts onFileChange
                                      └─ webContents.send('chat:file-change', info)
                                            ↓
渲染端：useChat 内 onChatFileChange 监听
  └─ useEditorStore.addPendingDiff(info)
        └─ useEditorStore.reviewDiff(info.filePath)  ← 自动展示
              ↓
EditorArea 重渲染：
  - 顶部 Pending 标签栏出现该文件
  - MonacoWrapper 检测 activeDiff !== null → 切到 InlineDiffView
  - InlineDiffView 用 LCS 计算逐行 diff 并渲染
              ↓
用户点 Accept：
  └─ useEditorStore.acceptDiff()
        └─ 从 pendingDiffs 移除 + activeDiff=null + openFileContent=newContent
              （文件已经落盘，无需 IPC）
用户点 Reject：
  └─ useEditorStore.rejectDiff()
        └─ window.api.revertFileChange(filePath, oldContent)
              └─ IPC chat:revert-file → fs.writeFileSync(filePath, oldContent)
        └─ 从 pendingDiffs 移除 + activeDiff=null + openFileContent=oldContent
```

### 3.3 步骤索引

| # | 步骤 | 文件 | 类型 |
|---|------|------|------|
| 5.1 | 设计系统：CSS 变量 + 动画 | `src/main.css` | 修改 |
| 5.2 | ToolContext 增加 onFileChange 字段 | `electron/services/agent/tools/tool-registry.ts` | 修改 |
| 5.3 | edit_file 触发 onFileChange | `electron/services/agent/tools/edit-file.tool.ts` | 修改 |
| 5.4 | write_file 触发 onFileChange | `electron/services/agent/tools/write-file.tool.ts` | 修改 |
| 5.5 | ProviderConfig 扩展三参数 | `electron/services/agent/providers/base.provider.ts` | 修改 |
| 5.6 | OpenAIProvider 透传 temperature | `electron/services/agent/providers/openai.provider.ts` | 修改 |
| 5.7 | AgentLoop 接收 options + onFileChange + 文本回退解析 | `electron/services/agent/agent-loop.ts` | 修改 |
| 5.8 | ChatService 默认配置 + 持久化对话 + 参数透传 | `electron/services/agent/chat.service.ts` | 修改 |
| 5.9 | chat.ipc 转发 file-change + 增加 revert-file | `electron/ipc/chat.ipc.ts` | 修改 |
| 5.10 | preload 暴露 onChatFileChange / revertFileChange | `electron/preload.ts` | 修改 |
| 5.11 | vite-env.d.ts 补 FileChangeInfo | `src/vite-env.d.ts` | 修改 |
| 5.12 | editor.store 增加 pendingDiffs/activeDiff 状态机 | `src/stores/editor.store.ts` | 修改 |
| 5.13 | useChat 订阅文件变更 | `src/hooks/useChat.ts` | 修改 |
| 5.14 | InlineDiffView 实现 LCS + UI | `src/components/editor/InlineDiffView.tsx` | 新增 |
| 5.15 | EditorArea 加 Pending 标签栏 | `src/components/editor/EditorArea.tsx` | 新增 |
| 5.16 | MonacoWrapper 切换 InlineDiffView | `src/components/editor/MonacoWrapper.tsx` | 修改 |
| 5.17 | SettingsDialog 加三项设置 | `src/components/settings/SettingsDialog.tsx` | 修改 |

## 4. 基础知识

### 4.1 LCS（最长公共子序列）与 diff

逐行 diff 的本质是：把两段文本视作两个序列，先求出它们的「最长公共子序列」（LCS），保留下来作为 unchanged 行；剩下的，左侧序列里的算 removed，右侧序列里的算 added。

LCS 的标准 DP 递推：

$$
dp[i][j] =
\begin{cases}
dp[i-1][j-1] + 1, & \text{if } a_i = b_j \\
\max(dp[i-1][j], dp[i][j-1]), & \text{otherwise}
\end{cases}
$$

回溯时：

- 若 `a[i-1] == b[j-1]`：unchanged，i--, j--
- 否则若 `dp[i][j-1] >= dp[i-1][j]`：added（来自右），j--
- 否则：removed（来自左），i--

复杂度 O(m·n)，对教程级别的文件（几百行）非常充裕。生产里若文件数 MB 级，应换 Myers diff（O((m+n)·D)）或 patience diff。

### 4.2 设计 token 与 CSS 变量

「设计 token」是 Design System 的术语：把所有可视参数（颜色、阴影、间距、字号…）抽成命名常量，组件只引用名字。最朴素的实现就是 CSS 自定义属性（`--color-bg-primary`），因为：

- 浏览器原生支持；
- 可在 `:root` 集中定义，未来加亮色主题只需复写一份；
- 可在 Tailwind 任意类里用 `bg-[var(--color-bg-primary)]` 引用，零运行时开销。

我们这里不引入复杂的 ThemeProvider，因为单主题项目用 `:root` 已足够。

### 4.3 IPC 单向通知 vs 双向 invoke

之前 Day 7 加的 `chat:file-change` 是「main → renderer」单向通知（`webContents.send`），`chat:revert-file` 是「renderer → main」单向命令（`ipcRenderer.invoke`）。两者各有用武之地：

- **send / on**：主进程主动推、零返回值，典型场景是事件流。
- **invoke / handle**：渲染端主动问、有 Promise 返回，典型场景是请求-响应。

把「文件变更」做成事件、「恢复文件」做成命令，符合二者的语义边界。

### 4.4 Pending Diff 队列：用 filePath 去重

同一个文件可能被 Agent 多轮修改（先 write 再 edit）。我们的策略是「队列里同一文件只保留最新一份」，所以 `addPendingDiff` 里先 `filter` 掉旧的、再 push 新的。注意：**`oldContent` 仍然取 Agent 第一次修改前的真实内容**吗？不 —— 我们这里取**本次工具调用前的内容**，所以多次修改的累计「旧」是「上一次的新」。如果用户审多次后选择 Reject 第二次，仅恢复到第一次修改后的状态。要做完整 undo 链需要单独的栈结构，本日不做。

### 4.5 Ollama 文本回退解析

某些本地模型（Qwen / Llama 等）走 OpenAI 兼容端点时，并不真的产生 `tool_calls` 字段，而是把工具调用以纯文本 JSON 写出来：

```text
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
```

我们的 AgentLoop 在「本轮无 tool_calls 但有文本」时，做一次兜底：扫文本里的 `{...}`，找到 `name in registeredToolNames` 的对象，按工具调用执行。`findMatchingBrace` 简单状态机处理嵌套和字符串转义，避免大括号在字符串里被误算。

## 5. 编码步骤

### 5.1 设计系统：`main.css` 重构

#### A. 动机

为后续所有迁移工作奠定 token 基础；同时引入若干通用动画类，提升交互质感。

#### B. 操作

整体重写 `src/main.css`：在 `:root` 定义颜色变量，添加滚动条美化、字体栈、6 套 keyframes 与对应 utility class。

#### C. 完整代码

```css
/* src/main.css */
@import "tailwindcss";

/* ─── Day 8: 统一设计系统 ─────────────────────────────────────────── */
:root {
  /* 基础灰度 */
  --color-bg-primary: #0f1117;
  --color-bg-secondary: #161922;
  --color-bg-tertiary: #1c1f2b;
  --color-bg-elevated: #232736;
  --color-bg-hover: #2a2e3d;
  --color-bg-active: #323750;

  /* 前景色 */
  --color-fg-primary: #e2e4eb;
  --color-fg-secondary: #9399ab;
  --color-fg-muted: #5d6377;

  /* 边框 */
  --color-border: #2a2e3d;
  --color-border-subtle: #1f2333;

  /* 主题色（蓝紫渐变感） */
  --color-accent: #6c8aff;
  --color-accent-hover: #839dff;
  --color-accent-muted: rgba(108, 138, 255, 0.12);

  /* 语义色 */
  --color-success: #4ade80;
  --color-error: #f87171;
  --color-warning: #fbbf24;
  --color-info: #60a5fa;

  /* 兼容 Day 7 旧变量名 */
  --color-background: var(--color-bg-primary);
  --color-surface: var(--color-bg-secondary);
  --color-foreground: var(--color-fg-primary);
}

/* 工具类 */
.bg-background  { background-color: var(--color-bg-primary); }
.bg-surface     { background-color: var(--color-bg-secondary); }
.bg-elevated    { background-color: var(--color-bg-elevated); }
.text-foreground{ color: var(--color-fg-primary); }
.text-secondary { color: var(--color-fg-secondary); }
.text-muted     { color: var(--color-fg-muted); }
.border-border  { border-color: var(--color-border); }
.border-subtle  { border-color: var(--color-border-subtle); }

/* ─── 全局基础样式 ─────────────────────────────────────────────────── */
body, html {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background-color: var(--color-bg-primary);
  color: var(--color-fg-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

#root { height: 100%; }

/* 全局滚动条美化 */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--color-fg-muted);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover { background: var(--color-fg-secondary); }

/* ─── 微动画定义 ───────────────────────────────────────────────────── */
@keyframes fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fade-in-scale {
  from { opacity: 0; transform: scale(0.97); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes slide-in-right {
  from { opacity: 0; transform: translateX(8px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes slide-in-left {
  from { opacity: 0; transform: translateX(-8px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(108, 138, 255, 0); }
  50%      { box-shadow: 0 0 12px 2px rgba(108, 138, 255, 0.15); }
}
@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes typing-cursor {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0; }
}

.animate-fade-in       { animation: fade-in 0.2s ease-out both; }
.animate-fade-in-scale { animation: fade-in-scale 0.2s ease-out both; }
.animate-slide-right   { animation: slide-in-right 0.2s ease-out both; }
.animate-slide-left    { animation: slide-in-left 0.15s ease-out both; }
.animate-pulse-glow    { animation: pulse-glow 2s ease-in-out infinite; }
.animate-typing-cursor { animation: typing-cursor 1s step-end infinite; }
.animate-shimmer {
  background: linear-gradient(90deg, transparent 25%, rgba(108,138,255,0.06) 50%, transparent 75%);
  background-size: 200% 100%;
  animation: shimmer 2s linear infinite;
}

/* 通用过渡 */
.transition-base { transition: all 0.15s ease; }
```

#### D. 解释 + 反例

- **CSS 变量 vs Tailwind theme 扩展**：变量改一行就全局生效，不需要重启 Vite；`theme.colors` 修改要 rebuild。教学项目优先变量。
- **保留 `--color-background` 等旧名**：避免一次性改光所有旧组件类名 —— Day 7 写过 `bg-background` 等组件保持工作。
- **`overflow: hidden` 在 body**：防止顶层滚动条影响 Monaco 内部布局。Electron 应用的滚动应当限定在子容器里。
- **反例**：在每个组件内单独定义颜色 const —— 失去「改一处全部更新」的能力，主题切换无门。
- **反例**：把 keyframes 用内联 style 写在组件 —— React 不支持 `style` 包含 keyframes，必须 CSS-in-JS 或 stylesheet。

#### E. 立刻验证

任意组件加 `className="animate-fade-in"`，刷新页面观察元素淡入。

### 5.2 ToolContext 增加 `onFileChange`

#### A. 动机

工具修改文件后，需要把变更通知抛回上层（最终到 renderer）。最干净的接入点是 `ToolContext` —— 它本就是工具与外部世界的通道。

#### B. 操作

修改 `electron/services/agent/tools/tool-registry.ts`，在 `ToolContext` 接口加可选的 `onFileChange` 字段。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/tools/tool-registry.ts
export interface ToolContext {
  workspacePath: string
  /** Day 8: 文件变更通知回调（edit_file/write_file 修改文件后调用）。 */
  onFileChange?: (info: {
    filePath: string
    oldContent: string
    newContent: string
    toolName: string
  }) => void
}
```

其他部分（`AgentTool` 接口 / `ToolRegistry` 类）保持不变。

#### D. 解释 + 反例

- **可选字段**：因为不是所有工具调用方都需要这个回调（比如未来的批处理脚本可能不关心）。
- **传内联对象而不是单独 4 个参数**：以后扩字段（如 `lineDelta`）只需改 type，调用方自动适配。
- **反例**：把 `onFileChange` 做成 `ToolRegistry` 的成员（`new ToolRegistry({ onFileChange })`）—— 那么单个 `ChatService` 的不同 `sendMessage` 调用就无法各自携带不同的 callback；工具的 callback 应当跟随每次执行而非全局。

#### E. 立刻验证

TS 编译通过即可。

### 5.3 `edit_file` 触发 `onFileChange`

#### A. 动机

让精修工具在写盘后立刻把变更广播出去。

#### B. 操作

修改 `electron/services/agent/tools/edit-file.tool.ts`，在 `fs.writeFile` 之后、return 之前调用 `context.onFileChange?.(...)`。其他逻辑（路径校验、唯一性校验）维持 Day 7 不变。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/tools/edit-file.tool.ts
// ── 执行替换 ──────────────────────────────────────────────────────
const newContent = content.replace(oldString, newString)
await fs.writeFile(absTarget, newContent, "utf-8")

// Day 8: 通知前端文件发生变更（供 Inline Diff 使用）。
context.onFileChange?.({
  filePath: absTarget,
  oldContent: content,
  newContent,
  toolName: "edit_file",
})

const oldLines = oldString.split("\n").length
const newLines = newString.split("\n").length
const delta = newLines - oldLines
const sign = delta >= 0 ? "+" : ""
return `文件 ${rel} 修改成功。替换了 ${oldLines} 行 → ${newLines} 行（${sign}${delta} 行）。`
```

#### D. 解释 + 反例

- **`absTarget`（绝对路径）作为 `filePath`**：渲染端 Reject 时要把内容写回，必须用绝对路径，否则 main 进程的 `cwd` 不一定是工作区根。
- **`oldContent: content`**：这是修改前刚 read 出来的全文，确保「Reject 真能恢复」。
- **可选链 `?.`**：调用方不传 callback 时不该报错。
- **反例**：在 `await fs.writeFile` 之前调 onFileChange —— 写盘失败时已经把「改成功」的假消息发出去了，UI 状态错乱。
- **反例**：传 `oldContent: oldString` —— 那只是被替换的片段，不是文件全貌；diff 视图会变成对比小段文本而非完整文件。

#### E. 立刻验证

让 Agent 用 `edit_file` 改一个文件，DevTools Network/Console 应见 `chat:file-change` 事件传输。

### 5.4 `write_file` 触发 `onFileChange`

#### A. 动机

`write_file` 也是写工具，必须同样接入 Inline Diff。新建文件场景下 `oldContent` 是空字符串 —— 视为「全部新增」依然可在 diff 视图里看清。

#### B. 操作

修改 `electron/services/agent/tools/write-file.tool.ts`，在 `mkdir` 之后、`writeFile` 之前先尝试 `readFile` 拿旧内容（不存在则空串），然后写盘并 onFileChange。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/tools/write-file.tool.ts
// ── 创建父目录（若不存在）────────────────────────────────────────
await fs.mkdir(path.dirname(absTarget), { recursive: true })

// Day 8: 记录旧内容（用于 Inline Diff）。
let oldContent = ""
try {
  oldContent = await fs.readFile(absTarget, "utf-8")
} catch {
  // 文件不存在时 oldContent 保持空字符串（新建文件场景）。
}

// ── 写入文件 ─────────────────────────────────────────────────────
await fs.writeFile(absTarget, content, "utf-8")

// Day 8: 通知前端文件发生变更。
context.onFileChange?.({
  filePath: absTarget,
  oldContent,
  newContent: content,
  toolName: "write_file",
})

return `文件已成功写入：${rel}（${content.length} 字符）`
```

#### D. 解释 + 反例

- **`try { readFile } catch { "" }`**：文件不存在抛 ENOENT 是预期的，吞掉即可；其他错误（如权限）我们也吞 —— 因为后续 `writeFile` 同样会失败并把真错误抛上去，无需在此重复处理。
- **反例**：用 `existsSync` 先判存在再 read —— 引入 race condition 且 readFile 已经天然处理 ENOENT，更简洁。

#### E. 立刻验证

让 Agent 创建一个全新文件，diff 视图应显示「左侧空 / 右侧全部为绿色 +」。

### 5.5 ProviderConfig 扩展三参数

#### A. 动机

把「自定义 system prompt」「最大迭代轮次」「temperature」纳入持久化配置。

#### B. 操作

修改 `electron/services/agent/providers/base.provider.ts` 的 `ProviderConfig` 接口。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/providers/base.provider.ts

// Provider 配置。Day 8: 新增 systemPrompt / maxIterations / temperature。
export interface ProviderConfig {
  apiKey: string
  baseURL: string
  model: string
  systemPrompt?: string
  maxIterations?: number
  temperature?: number
}
```

#### D. 解释 + 反例

- 三个新字段都 **可选**：旧的持久化配置文件 `chat-settings.json` 不带它们也能 parse 成功，向后兼容。
- **反例**：`systemPrompt: string` 必填 —— 已存在的用户配置文件第一次升级后 parse 出来 `systemPrompt = undefined`，运行时类型断言失效。

#### E. 立刻验证

TS 编译通过；`JSON.parse` 旧配置不再出现「字段缺失」报错。

### 5.6 OpenAIProvider 透传 temperature

#### A. 动机

`AgentLoop` 已经在 `chat()` 调用时传入 `temperature`，但 OpenAIProvider 之前没在 request 里使用它。

#### B. 操作

修改 `openai.provider.ts`，在 `requestParams` 构造时按需带上 `temperature`。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/providers/openai.provider.ts
const requestParams: OpenAI.ChatCompletionCreateParamsStreaming = {
  model: this.config.model,
  messages: openaiMessages,
  stream: true,
  ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
}
```

其余流式处理与 Day 7 一致（包括 Ollama 的 id 兜底、finish_reason 后 flush tool_calls）。

#### D. 解释 + 反例

- **条件 spread** `...(cond ? {a:1} : {})`：避免显式 `if (cond) requestParams.temperature = ...`，让 const 对象保持单一 expression 风格。
- **反例**：`temperature: params.temperature ?? 0.7` —— 等于强制覆盖了未配置场景，与「不传则用模型默认」的语义不同；某些模型默认 1.0，强行 0.7 改变默认行为。

#### E. 立刻验证

抓包或加 console.log 看 request body 含 `"temperature": 0.2`（保存设置后）。

### 5.7 AgentLoop：options + onFileChange + 文本回退解析

#### A. 动机

三件事合并到本步：

1. **接受 options**：把 `maxIterations / systemPrompt / temperature` 从外部传入，而不是写死在常量。
2. **透传 `onFileChange`**：把 ToolContext 的回调链打通。
3. **文本回退解析**：兼容 Ollama，从 assistant 文本里识别 JSON 形式的 tool_call。
4. **完成时返回完整对话历史**：让 ChatService 能持久化（含 tool_calls + tool 消息）下一轮使用。

#### B. 操作

修改 `electron/services/agent/agent-loop.ts`：

- 构造函数加 `options?: { maxIterations?; systemPrompt?; temperature? }`。
- `buildSystemPrompt(workspacePath, customPrompt?)` 在末尾追加用户自定义指令段。
- `AgentLoopCallbacks.onFileChange?` + `onComplete(fullText, conversationMessages?)`。
- 单轮中若没有 `tool_calls` 但有 assistant 文本，调 `parseToolCallsFromText(text, registeredNames)` 兜底；解析到则按工具调用执行。
- ToolContext 透传 `onFileChange`。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/agent-loop.ts
import type { LLMProvider, Message, ToolCall } from "./providers/base.provider"
import type ToolRegistry from "./tools/tool-registry"

export interface AgentLoopCallbacks {
  onThinking(): void
  onToken(token: string): void
  onToolCallStart(info: { id: string; name: string; args: string }): void
  onToolCallResult(info: { id: string; name: string; result: string; isError: boolean }): void
  onIteration(current: number, max: number): void
  /** Day 8: 文件变更回调（透传给工具）。 */
  onFileChange?(info: { filePath: string; oldContent: string; newContent: string; toolName: string }): void
  /**
   * Day 8: 完成时回调。
   * conversationMessages 包含本轮所有新增消息（assistant tool_calls / tool 结果 / 最终 assistant 文本），
   * 供 ChatService 替换旧 messages 数组以保留多轮工具上下文。
   */
  onComplete(fullText: string, conversationMessages?: Message[]): void
  onError(error: string): void
}

interface AgentLoopOptions {
  maxIterations?: number
  systemPrompt?: string
  temperature?: number
}

const DEFAULT_MAX_ITERATIONS = 10

export default class AgentLoop {
  private aborted = false
  private readonly maxIterations: number
  private readonly customSystemPrompt?: string
  private readonly temperature?: number

  constructor(
    private provider: LLMProvider,
    private toolRegistry: ToolRegistry,
    options: AgentLoopOptions = {},
  ) {
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.customSystemPrompt = options.systemPrompt
    this.temperature = options.temperature
  }

  abort(): void { this.aborted = true }

  private buildSystemPrompt(workspacePath: string, customPrompt?: string): string {
    const base = `你是一个运行在 IDE 中的编码助手。
当前工作区根目录：${workspacePath}
你可以使用以下工具：read_file, list_files, search, write_file, edit_file, run_command。
- 修改文件前先 read_file 读取当前内容；
- edit_file 的 old_string 必须是文件中精确出现且唯一的片段；
- 在你完成所有必需操作后，给出对用户的最终回复。`
    if (customPrompt && customPrompt.trim()) {
      return `${base}\n\n## 用户自定义指令\n${customPrompt.trim()}`
    }
    return base
  }

  async run(
    initialMessages: Message[],
    workspacePath: string,
    callbacks: AgentLoopCallbacks,
  ): Promise<void> {
    this.aborted = false

    // 准备本轮 messages：在最前面注入 system prompt
    const systemPrompt = this.buildSystemPrompt(workspacePath, this.customSystemPrompt)
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...initialMessages,
    ]

    const tools = this.toolRegistry.getToolDefinitions()
    const registeredToolNames = new Set(this.toolRegistry.getAll().map((t) => t.name))

    let finalText = ""

    for (let iter = 1; iter <= this.maxIterations; iter++) {
      if (this.aborted) {
        callbacks.onError("用户中止了对话")
        return
      }

      callbacks.onIteration(iter, this.maxIterations)
      callbacks.onThinking()

      let assistantText = ""
      const toolCalls: ToolCall[] = []

      try {
        for await (const chunk of this.provider.chat({
          messages,
          tools,
          stream: true,
          temperature: this.temperature,
        })) {
          if (this.aborted) return

          if (chunk.type === "text_delta" && chunk.content) {
            assistantText += chunk.content
            callbacks.onToken(chunk.content)
          } else if (chunk.type === "tool_call_start" && chunk.toolCall?.id && chunk.toolCall.function) {
            callbacks.onToolCallStart({
              id: chunk.toolCall.id,
              name: chunk.toolCall.function.name ?? "",
              args: "",
            })
          } else if (chunk.type === "tool_call_end" && chunk.toolCall?.id && chunk.toolCall.function) {
            toolCalls.push({
              id: chunk.toolCall.id,
              type: "function",
              function: {
                name: chunk.toolCall.function.name ?? "",
                arguments: chunk.toolCall.function.arguments ?? "",
              },
            })
          } else if (chunk.type === "error") {
            callbacks.onError(chunk.error ?? "LLM 流出错")
            return
          }
        }
      } catch (e) {
        callbacks.onError(e instanceof Error ? e.message : String(e))
        return
      }

      // ── Day 8: Ollama 文本回退 ──────────────────────────────────────
      // 如果模型没产生结构化 tool_calls，但文本里嵌了 JSON tool 调用，则补救之。
      if (toolCalls.length === 0 && assistantText) {
        const recovered = parseToolCallsFromText(assistantText, registeredToolNames)
        if (recovered.length > 0) {
          toolCalls.push(...recovered)
          // 文本里嵌的 JSON 不应该再被当成最终回复。
          // 这里把 assistantText 清空；用户感知上是「直接执行了工具」。
          assistantText = ""
        }
      }

      if (toolCalls.length === 0) {
        // 没有工具调用，对话结束。
        finalText = assistantText
        messages.push({ role: "assistant", content: assistantText })
        break
      }

      // 把 assistant tool_calls 消息记入历史。
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls,
      })

      // 逐个执行工具调用。
      for (const tc of toolCalls) {
        if (this.aborted) return
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}")
        } catch (e) {
          parsedArgs = { __parse_error__: String(e) }
        }

        const result = await this.toolRegistry.execute(tc.function.name, parsedArgs, {
          workspacePath,
          onFileChange: callbacks.onFileChange, // Day 8: 透传到工具
        })

        const isError = result.startsWith("{") && result.includes('"error"')
        callbacks.onToolCallResult({ id: tc.id, name: tc.function.name, result, isError })

        // 工具结果回写为 tool 消息。
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        })
      }

      if (iter === this.maxIterations) {
        callbacks.onError(`已达到最大迭代次数 ${this.maxIterations}，强制终止。`)
        // 不 return：仍然把已累积的对话历史回传给 ChatService。
      }
    }

    // Day 8: 把对话历史（slice(1) 去掉系统提示）回传，供 ChatService 持久化。
    callbacks.onComplete(finalText, messages.slice(1))
  }
}

// ─── Day 8: Ollama 文本回退辅助 ──────────────────────────────────────

interface ParsedTextToolCall {
  name: string
  arguments: unknown
}

/** 从纯文本中扫出 {name, arguments} 形式的 JSON tool_call。 */
function parseToolCallsFromText(text: string, validNames: Set<string>): ToolCall[] {
  const calls: ToolCall[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf("{", i)
    if (open === -1) break
    const close = findMatchingBrace(text, open)
    if (close === -1) break
    const slice = text.slice(open, close + 1)
    try {
      const obj = JSON.parse(slice) as ParsedTextToolCall
      if (obj && typeof obj.name === "string" && validNames.has(obj.name)) {
        calls.push({
          id: `call_${Date.now()}_${calls.length}`,
          type: "function",
          function: {
            name: obj.name,
            arguments: JSON.stringify(obj.arguments ?? {}),
          },
        })
      }
    } catch {
      // 该候选片段不是合法 JSON，忽略
    }
    i = close + 1
  }
  return calls
}

/** 简单状态机：从 start 处的 '{' 出发，找到匹配的 '}' 索引；考虑字符串和转义。 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === "\\") { escape = true; continue }
      if (ch === '"') { inString = false }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
```

#### D. 解释 + 反例

- **`messages.slice(1)`**：去掉首个 system 消息。下一轮 `ChatService` 把它整体回灌时，AgentLoop 会再注入新的 system prompt（可能用户改了 SystemPrompt），避免 system 重复或污染。
- **解析到 toolCalls 后清空 assistantText**：不然「JSON 文本」会被当成最终回复推给 UI，用户看到一串结构化对象而非自然语言。
- **为什么 Ollama 回退要校验 `validNames`**：模型偶尔会输出无关的 JSON（例如示例代码片段）；只匹配已注册工具名才算真正的 tool_call，避免误执行。
- **`isError = result.startsWith('{') && includes('"error"')`**：约定俗成的轻量判断 —— 工具内部出错时返回 `JSON.stringify({ error })`，正常则返回纯字符串描述。
- **反例**：用 `JSON.parse(text)` 直接试解析整段文本作 tool_call —— 模型会在 JSON 周围加自然语言「OK，让我调用工具：{...}」，整段 parse 必失败；按子串扫才稳。
- **反例**：超过 maxIterations 直接 throw —— UI 收不到任何 onComplete，对话状态卡在 streaming 标志。我们这里用 onError + 仍 onComplete 的组合，让 UI 既能弹错也能恢复输入。

#### E. 立刻验证

把 maxIterations 设为 2，让 Agent 做需要多步骤的任务，最后能见到「已达到最大迭代次数」错误，UI 不卡死。

### 5.8 ChatService：默认 Ollama / 持久化对话 / 透传参数

#### A. 动机

承接 5.7：让 AgentLoop 拿到三参数；把回传的 conversationMessages 替换 `this.messages`；并在「无 settings 文件」时自动落一份默认 Ollama 配置，零成本冒烟。

#### B. 操作

修改 `electron/services/agent/chat.service.ts`。

#### C. 完整代码

```ts
// electron/services/agent/chat.service.ts
/**
 * Day 8: ChatService 扩展版。
 * - 构造 AgentLoop 时透传 maxIterations / systemPrompt / temperature
 * - onComplete 接收 conversationMessages 替换 this.messages（含 tool 上下文）
 * - 无配置时使用本地 Ollama 默认配置
 * - 增加 onFileChange 回调
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { app } from "electron"
import type { LLMProvider, ProviderConfig, Message } from "./providers/base.provider"
import OpenAIProvider from "./providers/openai.provider"
import ToolRegistry from "./tools/tool-registry"
import readFileTool from "./tools/read-file.tool"
import listFilesTool from "./tools/list-files.tool"
import searchFilesTool from "./tools/search.tool"
import writeFileTool from "./tools/write-file.tool"
import editFileTool from "./tools/edit-file.tool"
import runCommandTool from "./tools/run-command.tool"
import AgentLoop, { type AgentLoopCallbacks } from "./agent-loop"

export interface ChatCallbacks {
  onToken(token: string): void
  onThinking(): void
  onToolCallStart(info: { id: string; name: string; args: string }): void
  onToolCallResult(info: { id: string; name: string; result: string; isError: boolean }): void
  onComplete(fullText: string): void
  onError(error: string): void
  onIteration(current: number, max: number): void
  /** Day 8: 文件变更（编辑器 Inline Diff 用）。 */
  onFileChange?(info: { filePath: string; oldContent: string; newContent: string; toolName: string }): void
}

export default class ChatService {
  private provider: LLMProvider | null = null
  private providerConfig: ProviderConfig | null = null
  private messages: Message[] = []
  private settingsPath: string
  private toolRegistry: ToolRegistry
  private currentLoop: AgentLoop | null = null

  constructor() {
    this.settingsPath = join(app.getPath("userData"), "chat-settings.json")
    this.loadSettings()
    this.toolRegistry = new ToolRegistry()
    this.toolRegistry.register(readFileTool)
    this.toolRegistry.register(listFilesTool)
    this.toolRegistry.register(searchFilesTool)
    this.toolRegistry.register(writeFileTool)
    this.toolRegistry.register(editFileTool)
    this.toolRegistry.register(runCommandTool)
  }

  getSettings(): ProviderConfig | null { return this.providerConfig }

  updateSettings(config: ProviderConfig): void {
    this.providerConfig = config
    this.provider = new OpenAIProvider(config)
    this.saveSettings()
  }

  clearMessages(): void { this.messages = [] }

  abort(): void { this.currentLoop?.abort() }

  async sendMessage(userContent: string, workspacePath: string, callbacks: ChatCallbacks): Promise<void> {
    if (!this.provider) {
      callbacks.onError("未配置 LLM Provider，请打开设置填写 API Key 与模型名。")
      return
    }
    this.messages.push({ role: "user", content: userContent })

    this.currentLoop = new AgentLoop(this.provider, this.toolRegistry, {
      maxIterations: this.providerConfig?.maxIterations,
      systemPrompt: this.providerConfig?.systemPrompt,
      temperature: this.providerConfig?.temperature,
    })

    const loopCallbacks: AgentLoopCallbacks = {
      onThinking: () => callbacks.onThinking(),
      onToken: (token) => callbacks.onToken(token),
      onToolCallStart: (info) => callbacks.onToolCallStart(info),
      onToolCallResult: (info) => callbacks.onToolCallResult(info),
      onIteration: (cur, max) => callbacks.onIteration(cur, max),
      onFileChange: callbacks.onFileChange
        ? (info) => callbacks.onFileChange!(info)
        : undefined,
      onComplete: (fullText, conversationMessages) => {
        if (conversationMessages && conversationMessages.length > 0) {
          // Day 8: 用完整对话历史替换，保留 tool_calls / tool 上下文。
          this.messages = conversationMessages
        } else if (fullText) {
          this.messages.push({ role: "assistant", content: fullText })
        }
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
        const config = JSON.parse(readFileSync(this.settingsPath, "utf-8")) as ProviderConfig
        this.providerConfig = config
        this.provider = new OpenAIProvider(config)
      } else {
        // Day 8: 默认 Ollama 配置（无需 API Key，直连本地 Ollama 服务）。
        const defaultConfig: ProviderConfig = {
          apiKey: "ollama",
          baseURL: "http://localhost:11434/v1",
          model: "qwen2.5-coder:32b-instruct-q4_K_M",
        }
        this.providerConfig = defaultConfig
        this.provider = new OpenAIProvider(defaultConfig)
      }
    } catch { /* ignore */ }
  }

  private saveSettings(): void {
    if (!this.providerConfig) return
    try {
      const dir = dirname(this.settingsPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.settingsPath, JSON.stringify(this.providerConfig, null, 2), "utf-8")
    } catch { /* ignore */ }
  }
}
```

#### D. 解释 + 反例

- **替换 `this.messages` vs 追加**：旧实现只 `push({assistant, content: fullText})`，丢失了所有 tool_call / tool 消息；下一轮发问时，模型不知道上轮是否已读过某文件，可能重复 read。整段替换 = 复刻 OpenAI 官方 Function Calling 多轮 demo 的做法。
- **`[...this.messages]`**：传给 AgentLoop 的是浅拷贝，避免 AgentLoop 内部 push 时影响外部数组；最终通过 `onComplete(_, conversationMessages)` 一次性接管。
- **默认 Ollama 配置**：`apiKey: "ollama"` 不是空串，因为 OpenAI SDK 在客户端构造时若 apiKey 为空字符串会抛错；任意非空字符串即可。
- **反例**：在 `loadSettings` 里把默认 config 也写盘 —— 用户首次启动磁盘上就出现了一份可能不需要的配置；改成内存中持有，等用户主动「保存」时才落盘。

#### E. 立刻验证

删掉 `userData/chat-settings.json`，重启应用 → 不需任何配置即可发起对话（前提你本地 11434 跑着 Ollama）。

### 5.9 chat.ipc：转发 file-change + revert-file

#### A. 动机

把 ChatService 的 `onFileChange` 回调通过 `webContents.send` 推到 renderer；同时新增 `chat:revert-file` 处理 reject 时的写盘恢复。

#### B. 操作

修改 `electron/ipc/chat.ipc.ts`，在 ChatCallbacks 里增加 `onFileChange`，并 `ipcMain.handle("chat:revert-file", …)`。

#### C. 完整代码

```ts
// electron/ipc/chat.ipc.ts
/**
 * Day 8: Chat IPC 扩展。
 * 1. chat:file-change 事件 —— 工具修改文件后通知前端
 * 2. chat:revert-file 命令 —— Reject 时恢复文件
 */
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from "electron"
import { writeFileSync } from "fs"
import ChatService from "../services/agent/chat.service"

const chatService = new ChatService()

export function registerChatIpcHandlers(): void {
  ipcMain.removeHandler("chat:send-message")
  ipcMain.removeHandler("chat:abort")
  ipcMain.removeHandler("chat:get-settings")
  ipcMain.removeHandler("chat:update-settings")
  ipcMain.removeHandler("chat:clear")
  ipcMain.removeHandler("chat:revert-file")

  ipcMain.handle(
    "chat:send-message",
    async (event: IpcMainInvokeEvent, message: string, workspacePath: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      const safeSend = (channel: string, data: Record<string, unknown>): void => {
        if (!win.isDestroyed()) win.webContents.send(channel, data)
      }
      await chatService.sendMessage(message, workspacePath, {
        onToken(token) { safeSend("chat:stream", { token }) },
        onThinking() { safeSend("chat:thinking", {}) },
        onComplete(fullText) { safeSend("chat:complete", { message: fullText }) },
        onError(error) { safeSend("chat:error", { error }) },
        onToolCallStart(info) { safeSend("chat:tool-call", info) },
        onToolCallResult(info) { safeSend("chat:tool-result", info) },
        onIteration(current, max) { safeSend("chat:iteration", { current, max }) },
        // Day 8: 文件变更事件转发到渲染进程。
        onFileChange(info) { safeSend("chat:file-change", info) },
      })
    },
  )

  ipcMain.handle("chat:abort", () => chatService.abort())
  ipcMain.handle("chat:get-settings", () => chatService.getSettings())
  ipcMain.handle("chat:update-settings", (_event, config: ProviderConfig) => {
    chatService.updateSettings(config)
  })
  ipcMain.handle("chat:clear", () => chatService.clearMessages())

  // Day 8: 用户拒绝变更时恢复文件原始内容。
  ipcMain.handle("chat:revert-file", (_event, filePath: string, content: string) => {
    writeFileSync(filePath, content, "utf-8")
  })
}

// 上面用到的 ProviderConfig 直接从 service 文件 re-export 也可。
import type { ProviderConfig } from "../services/agent/providers/base.provider"
```

#### D. 解释 + 反例

- **`removeHandler` 在 register 之前**：开发模式 HMR 会重复 register，旧 handler 不清理 Electron 会抛 `Attempted to register a second handler`。
- **`writeFileSync` 而不是 promises 版**：handler 同步即可，简单可靠；recover 操作要么成功要么抛错给渲染端 await 拒绝，不需要复杂 await 链。
- **反例**：在 `chat:file-change` 里再做一次安全校验（路径必须在 workspace 内）—— 这是「变更通知」事件，路径已是工具内校验过的；额外校验 = 把信任边界放错位置。

#### E. 立刻验证

DevTools Console 见 `window.api.revertFileChange` 是 function；让 Agent 改文件 → 见到 `chat:file-change` 事件触发渲染端回调。

### 5.10 preload：暴露 onChatFileChange / revertFileChange

#### A. 动机

renderer 通过 `window.api` 调用 main 的能力，必须在 preload 显式声明。

#### B. 操作

修改 `electron/preload.ts`，在 `api` 对象里加两项。

#### C. 完整代码（关键改动）

```ts
// electron/preload.ts —— 在 api 对象内追加
const api = {
  // ... Day 2~7 已有的全部 API

  // Day 8: Inline Diff 文件变更事件
  onChatFileChange: (
    callback: (data: { filePath: string; oldContent: string; newContent: string; toolName: string }) => void,
  ) => {
    const handler = (_event: IpcRendererEvent, data: { filePath: string; oldContent: string; newContent: string; toolName: string }) =>
      callback(data)
    ipcRenderer.on("chat:file-change", handler)
    return () => { ipcRenderer.removeListener("chat:file-change", handler) }
  },
  // Day 8: 拒绝变更时恢复文件
  revertFileChange: (filePath: string, oldContent: string) =>
    ipcRenderer.invoke("chat:revert-file", filePath, oldContent),
}
```

#### D. 解释 + 反例

- **`return () => removeListener(handler)`**：把同一个 handler 引用还给调用方，`useEffect` 卸载时调一次即可移除；闭包模式确保 add 与 remove 用同一对象引用。
- **反例**：返回 `() => ipcRenderer.removeAllListeners("chat:file-change")` —— 多个组件订阅时一处卸载会把所有订阅都干掉。

#### E. 立刻验证

DevTools Console 输入 `typeof window.api.onChatFileChange` 应为 `"function"`。

### 5.11 vite-env.d.ts：补 FileChangeInfo

#### A. 动机

让渲染端 TS 知道 `window.api.onChatFileChange / revertFileChange` 的签名，并定义共享的 `FileChangeInfo` 类型。

#### B. 操作

在 `src/vite-env.d.ts` 增补 type，并在 `RendererApi` 接口里追加方法签名。

#### C. 完整代码（关键改动）

```ts
// src/vite-env.d.ts

// Day 8: 文件变更信息（Inline Diff 使用）
interface FileChangeInfo {
  filePath: string
  oldContent: string
  newContent: string
  toolName: string
}

interface RendererApi {
  // ... Day 2~7 已有方法

  // Day 8: Inline Diff
  onChatFileChange: (callback: (data: FileChangeInfo) => void) => () => void
  revertFileChange: (filePath: string, oldContent: string) => Promise<void>
}
```

#### D. 解释 + 反例

- 把 `FileChangeInfo` 提到全局接口，store / hook / 组件都直接用，避免 5 个文件各自重复声明同样字段。
- **反例**：在 `editor.store.ts` 里再 `interface FileChangeInfo`—— TS 并不会报「重复」（因为是 module-local），但实际上是另一个独立类型，跨模块传递会因为 structural typing 巧合工作直到字段差异时炸掉。

#### E. 立刻验证

`store.addPendingDiff({ filePath: "x", oldContent: "", newContent: "", toolName: "write_file" })` 不报 TS 错。

### 5.12 editor.store：pendingDiffs / activeDiff 状态机

#### A. 动机

承接 5.11，把变更队列和「正在审核中的那个」管理起来；同时为 Accept / Reject 提供原子动作。

#### B. 操作

修改 `src/stores/editor.store.ts`：在 `EditorState` 里加 `pendingDiffs` / `activeDiff` 与四个 action。

#### C. 完整代码

```ts
// src/stores/editor.store.ts
import { create } from 'zustand'

interface EditorState {
  isSidebarOpen: boolean
  isChatOpen: boolean
  openFilePath: string | null
  openFileContent: string
  activeSidebarPanel: 'files' | 'git'
  /** Day 8: 等待用户审核的文件变更队列。 */
  pendingDiffs: FileChangeInfo[]
  /** Day 8: 当前正在审核的 diff（决定是否渲染 InlineDiffView）。 */
  activeDiff: FileChangeInfo | null

  setSidebarOpen: (open: boolean) => void
  setChatOpen: (open: boolean) => void
  setOpenFile: (filePath: string, content: string) => void
  setOpenFileContent: (content: string) => void
  setActiveSidebarPanel: (panel: 'files' | 'git') => void

  /** Day 8: 添加一个待审核变更（同文件去重，保留最新）。 */
  addPendingDiff: (info: FileChangeInfo) => void
  /** Day 8: 开始审核某个 diff。 */
  reviewDiff: (filePath: string) => void
  /** Day 8: 接受当前 diff（文件已落盘，仅清理 UI 状态）。 */
  acceptDiff: () => void
  /** Day 8: 拒绝当前 diff（IPC 把旧内容写回，恢复 UI 状态）。 */
  rejectDiff: () => void
  /** Day 8: 清空所有 pending diff。 */
  clearDiffs: () => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  isSidebarOpen: true,
  isChatOpen: false,
  openFilePath: null,
  openFileContent: '',
  activeSidebarPanel: 'files',
  pendingDiffs: [],
  activeDiff: null,

  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  setChatOpen: (open) => set({ isChatOpen: open }),
  setOpenFile: (filePath, content) => set({ openFilePath: filePath, openFileContent: content }),
  setOpenFileContent: (content) => set({ openFileContent: content }),
  setActiveSidebarPanel: (panel) => set({ activeSidebarPanel: panel }),

  addPendingDiff: (info) =>
    set((state) => ({
      pendingDiffs: [
        ...state.pendingDiffs.filter((d) => d.filePath !== info.filePath),
        info,
      ],
    })),

  reviewDiff: (filePath) => {
    const diff = get().pendingDiffs.find((d) => d.filePath === filePath)
    if (diff) set({ activeDiff: diff })
  },

  acceptDiff: () => {
    const { activeDiff, pendingDiffs } = get()
    if (!activeDiff) return
    set({
      activeDiff: null,
      pendingDiffs: pendingDiffs.filter((d) => d.filePath !== activeDiff.filePath),
      openFileContent: activeDiff.newContent, // 编辑器同步显示新内容
    })
  },

  rejectDiff: () => {
    const { activeDiff, pendingDiffs } = get()
    if (!activeDiff) return
    // IPC 把旧内容写回磁盘。
    window.api.revertFileChange(activeDiff.filePath, activeDiff.oldContent)
    set({
      activeDiff: null,
      pendingDiffs: pendingDiffs.filter((d) => d.filePath !== activeDiff.filePath),
      openFileContent: activeDiff.oldContent,
    })
  },

  clearDiffs: () => set({ pendingDiffs: [], activeDiff: null }),
}))
```

#### D. 解释 + 反例

- **`addPendingDiff` 用 filter + spread 去重**：不是 push 后再 dedupe，而是构造新数组，符合 zustand 推荐的「不可变更新」。
- **Accept 不调 IPC**：因为 Agent 工具本来就已经把文件写盘了；Accept 只是「我承认这次写盘」。
- **Reject 调 IPC**：唯一一处真正回滚磁盘内容的地方。
- **`window.api.revertFileChange` fire-and-forget**：UI 不 await，先快速更新本地状态；恢复失败的小概率事件可下版本加 toast 兜底。
- **反例**：把 Accept 也做成 IPC「确认写盘」—— 浪费一次 round-trip，且 Agent 还在跑时可能撞上下一次写。

#### E. 立刻验证

DevTools 控制台 `useEditorStore.getState().addPendingDiff({ filePath: '/a', oldContent: 'x', newContent: 'y', toolName: 'write_file' })` → state 内 pendingDiffs 长度+1。

### 5.13 useChat：订阅 onChatFileChange

#### A. 动机

把 IPC 事件接到 store。

#### B. 操作

在 `src/hooks/useChat.ts` 已有的 useEffect 里追加 `unsub8` 订阅。

#### C. 完整代码（关键改动）

```ts
// src/hooks/useChat.ts
import { useEffect, useCallback } from "react"
import { useChatStore } from "../stores/chat.store"
import { useFileTreeStore } from "../stores/file-tree.store"
import { useEditorStore } from "../stores/editor.store"

export function useChat() {
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const newConversation = useChatStore((s) => s.newConversation)
  const abortChat = useChatStore((s) => s.abortChat)
  const workspaceRoot = useFileTreeStore((s) => s.workspaceRoot)

  useEffect(() => {
    const unsub1 = window.api.onChatStream((d) => useChatStore.getState().appendToken(d.token))
    const unsub2 = window.api.onChatComplete((d) => useChatStore.getState().handleComplete(d.message))
    const unsub3 = window.api.onChatError((d) => useChatStore.getState().handleError(d.error))
    const unsub4 = window.api.onChatToolCall((d) => useChatStore.getState().handleToolCall(d))
    const unsub5 = window.api.onChatToolResult((d) => useChatStore.getState().handleToolResult(d))
    const unsub6 = window.api.onChatThinking(() => useChatStore.getState().handleThinking())
    const unsub7 = window.api.onChatIteration((d) => useChatStore.getState().handleIteration(d.current, d.max))

    // Day 8: 文件变更事件 → 入队 + 自动展示审核视图
    const unsub8 = window.api.onChatFileChange((data) => {
      const store = useEditorStore.getState()
      store.addPendingDiff(data)
      store.reviewDiff(data.filePath)
    })

    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); unsub7(); unsub8() }
  }, [])

  const send = useCallback(
    async (content: string) => { await sendMessage(content, workspaceRoot ?? process.cwd()) },
    [sendMessage, workspaceRoot],
  )

  return { sendMessage: send, isStreaming, newConversation, abortChat }
}
```

#### D. 解释 + 反例

- **`useEditorStore.getState()` 直接拿**：避免 hook 写法导致 useChat 在每次 editor.store 变化时重渲染；store 作为「副作用接收方」用 getState 即可。
- **`addPendingDiff` 后立即 `reviewDiff`**：若已有一个 diff 在审核中，根据 store 实现 reviewDiff 会被新文件「抢占」展示。本日采用「最新优先」；若想保留旧 diff 不打断，把 `reviewDiff` 改成 `if (!state.activeDiff) reviewDiff(...)` 即可。
- **反例**：在 unmount 时只 `unsub1()` 漏掉 unsub8 —— HMR 频繁时会累积多个监听，触发重复入队。务必把所有 unsub 一并调用。

#### E. 立刻验证

让 Agent 写文件，editor 区出现 InlineDiffView。

### 5.14 InlineDiffView：LCS + UI

#### A. 动机

实现 diff 的核心视图：左旧右新双行号、绿增红删，顶栏 Accept / Reject。

#### B. 操作

新增 `src/components/editor/InlineDiffView.tsx`。

#### C. 完整代码

```tsx
// src/components/editor/InlineDiffView.tsx
/**
 * Day 8: Inline Diff 视图。
 * 用 LCS 计算逐行 diff，渲染左右双列行号 + 绿/红高亮。
 */
import { useMemo } from "react"
import { Check, X, FileEdit } from "lucide-react"
import { useEditorStore } from "../../stores/editor.store"

type DiffLine = {
  type: "unchanged" | "added" | "removed"
  text: string
  lineNo: { old: number | null; new: number | null }
}

function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const m = a.length, n = b.length

  // LCS DP 表
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // 回溯
  const out: DiffLine[] = []
  let i = m, j = n, oldNo = m, newNo = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ type: "unchanged", text: a[i - 1], lineNo: { old: oldNo, new: newNo } })
      i--; j--; oldNo--; newNo--
    } else if (dp[i][j - 1] >= dp[i - 1][j]) {
      out.push({ type: "added", text: b[j - 1], lineNo: { old: null, new: newNo } })
      j--; newNo--
    } else {
      out.push({ type: "removed", text: a[i - 1], lineNo: { old: oldNo, new: null } })
      i--; oldNo--
    }
  }
  while (i > 0) { out.push({ type: "removed", text: a[i - 1], lineNo: { old: oldNo, new: null } }); i--; oldNo-- }
  while (j > 0) { out.push({ type: "added", text: b[j - 1], lineNo: { old: null, new: newNo } }); j--; newNo-- }

  return out.reverse()
}

export default function InlineDiffView() {
  const activeDiff = useEditorStore((s) => s.activeDiff)
  const acceptDiff = useEditorStore((s) => s.acceptDiff)
  const rejectDiff = useEditorStore((s) => s.rejectDiff)

  const lines = useMemo(
    () => (activeDiff ? diffLines(activeDiff.oldContent, activeDiff.newContent) : []),
    [activeDiff],
  )
  const stats = useMemo(() => {
    let added = 0, removed = 0
    for (const l of lines) {
      if (l.type === "added") added++
      else if (l.type === "removed") removed++
    }
    return { added, removed }
  }, [lines])

  if (!activeDiff) return null

  const fileName = activeDiff.filePath.split(/[\\/]/).pop() ?? activeDiff.filePath

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)] animate-fade-in">
      {/* 顶部审核条 */}
      <div className="flex items-center justify-between px-4 h-10 min-h-10 border-b border-[var(--color-border)]
                      bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-fg-primary)]">
          <FileEdit size={14} className="text-[var(--color-warning)]" />
          <span className="font-medium">{fileName}</span>
          <span className="text-[11px] text-[var(--color-fg-muted)] font-mono">
            ({activeDiff.toolName})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-[var(--color-success)]">+{stats.added}</span>
          <span className="text-[11px] font-mono text-[var(--color-error)]">-{stats.removed}</span>
          <button
            onClick={rejectDiff}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded
                       bg-[rgba(248,113,113,0.08)] text-[var(--color-error)]
                       hover:bg-[rgba(248,113,113,0.18)] transition-base cursor-pointer"
          >
            <X size={12} />
            Reject
          </button>
          <button
            onClick={acceptDiff}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded
                       bg-[rgba(74,222,128,0.10)] text-[var(--color-success)]
                       hover:bg-[rgba(74,222,128,0.20)] transition-base cursor-pointer"
          >
            <Check size={12} />
            Accept
          </button>
        </div>
      </div>

      {/* diff 主体 */}
      <div className="flex-1 overflow-auto font-mono text-[12.5px] leading-[1.55]">
        {lines.map((line, idx) => {
          const bg =
            line.type === "added" ? "bg-[rgba(74,222,128,0.08)]" :
            line.type === "removed" ? "bg-[rgba(248,113,113,0.08)]" : ""
          const textColor =
            line.type === "added" ? "text-[var(--color-success)]" :
            line.type === "removed" ? "text-[var(--color-error)]" :
            "text-[var(--color-fg-primary)]"
          const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " "
          return (
            <div key={idx} className={`flex ${bg}`}>
              {/* 左行号 */}
              <span className="w-12 px-2 text-right text-[var(--color-fg-muted)] select-none">
                {line.lineNo.old ?? ""}
              </span>
              {/* 右行号 */}
              <span className="w-12 px-2 text-right text-[var(--color-fg-muted)] select-none">
                {line.lineNo.new ?? ""}
              </span>
              {/* 标记列 */}
              <span className={`w-4 text-center select-none ${textColor}`}>{sign}</span>
              {/* 内容 */}
              <span className={`flex-1 whitespace-pre ${textColor}`}>{line.text || " "}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

#### D. 解释 + 反例

- **`useMemo([activeDiff])`**：避免每次组件重渲染都重算 LCS（O(m·n) 不便宜）。
- **`while (i>0) push removed; while (j>0) push added`**：DP 回溯结束后还可能有「左侧剩余 = 全删」「右侧剩余 = 全增」未处理，必须扫尾。
- **`out.reverse()`**：回溯时是从尾向头加，最后翻转得到自然顺序。
- **`line.text || " "`**：空行直接渲染会折叠成 0 高度，给个空格保留行高。
- **`whitespace-pre`**：保留缩进与多个空格，diff 看代码必须的。
- **反例**：用 `text.split("\n").map((l, i) => <div>{l}</div>)` 不算 diff —— 能展示但没法标记增删，毫无审核价值。
- **反例**：直接 `JSON.stringify` 文件做 diff —— 二进制或长字符串会被压成单行，diff 无意义。

#### E. 立刻验证

手动在 store 注入一个 diff 对象（旧 `"a\nb\nc"`、新 `"a\nB\nc\nd"`），视图上能看到 1 红行（-b）+ 2 绿行（+B、+d）。

### 5.15 EditorArea：Pending 标签栏

#### A. 动机

多个文件等待审核时，给用户一个清单可切换。

#### B. 操作

新增 `src/components/editor/EditorArea.tsx`，包裹原有 MonacoWrapper。

#### C. 完整代码

```tsx
// src/components/editor/EditorArea.tsx
/**
 * Day 8: 编辑器区域组合容器。
 * - 顶部 Pending Diff 标签栏（多个待审核文件可切换）
 * - 主体根据 activeDiff 显示 InlineDiffView 或 MonacoWrapper
 */
import { FileWarning } from "lucide-react"
import { useEditorStore } from "../../stores/editor.store"
import MonacoWrapper from "./MonacoWrapper"

export default function EditorArea() {
  const openFilePath = useEditorStore((s) => s.openFilePath)
  const pendingDiffs = useEditorStore((s) => s.pendingDiffs)
  const activeDiff = useEditorStore((s) => s.activeDiff)
  const reviewDiff = useEditorStore((s) => s.reviewDiff)

  const showEmpty = !openFilePath && !activeDiff && pendingDiffs.length === 0

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      {/* 待审核标签栏（仅在有 pending 时显示） */}
      {pendingDiffs.length > 0 && (
        <div className="flex items-center gap-1 h-8 min-h-8 px-2 border-b border-[var(--color-border)]
                        bg-[var(--color-bg-secondary)] overflow-x-auto">
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-fg-muted)] mr-1 select-none">
            待审核
          </span>
          {pendingDiffs.map((d) => {
            const fileName = d.filePath.split(/[\\/]/).pop() ?? d.filePath
            const isActive = activeDiff?.filePath === d.filePath
            return (
              <button
                key={d.filePath}
                onClick={() => reviewDiff(d.filePath)}
                className={`flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded transition-base cursor-pointer
                  ${isActive
                    ? "bg-[var(--color-warning)]/15 text-[var(--color-warning)]"
                    : "text-[var(--color-fg-secondary)] hover:bg-[var(--color-bg-hover)]"}`}
                title={d.filePath}
              >
                <FileWarning size={11} />
                {fileName}
              </button>
            )
          })}
        </div>
      )}

      {/* 主体 */}
      <div className="flex-1 overflow-hidden">
        {showEmpty ? (
          <div className="h-full flex items-center justify-center text-sm text-[var(--color-fg-muted)] select-none">
            没有打开的文件
          </div>
        ) : (
          <MonacoWrapper />
        )}
      </div>
    </div>
  )
}
```

> 注：原 `AppLayout.tsx` 中引用 `MonacoWrapper` 的位置改为引用 `EditorArea`。

#### D. 解释 + 反例

- **空态 `showEmpty`**：只有同时无 openFile / activeDiff / pendingDiffs 时才显示「没有打开的文件」；只要有待审核也不算空。
- **标签上 `title={filePath}`**：fileName 重名时（如多个 index.ts），鼠标悬停可见完整路径。
- **反例**：不区分空态，直接渲染 `<MonacoWrapper />` —— 它内部会用空 path 报错或显示无意义灰底。

#### E. 立刻验证

手动连续触发两个不同文件的 addPendingDiff，标签栏出现两个按钮，点切换正常。

### 5.16 MonacoWrapper：activeDiff 时切换

#### A. 动机

让现有 Monaco 编辑器组件根据 store 状态自动切换到 InlineDiffView。

#### B. 操作

修改 `src/components/editor/MonacoWrapper.tsx`，函数体头部加判断；保留语言识别表。

#### C. 完整代码（关键改动）

```tsx
// src/components/editor/MonacoWrapper.tsx
import Editor from "@monaco-editor/react"
import { useEditorStore } from "../../stores/editor.store"
import InlineDiffView from "./InlineDiffView"

const langTable: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript",
  json: "json", md: "markdown",
  css: "css", html: "html",
  py: "python", rs: "rust", go: "go",
}

function getLanguageByFilePath(filePath: string | null): string {
  if (!filePath) return "plaintext"
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return langTable[ext] ?? "plaintext"
}

export default function MonacoWrapper() {
  const openFilePath = useEditorStore((s) => s.openFilePath)
  const openFileContent = useEditorStore((s) => s.openFileContent)
  const setOpenFileContent = useEditorStore((s) => s.setOpenFileContent)
  const activeDiff = useEditorStore((s) => s.activeDiff)

  // Day 8: 有待审核 diff 时优先显示 diff 视图
  if (activeDiff) return <InlineDiffView />

  return (
    <Editor
      theme="vs-dark"
      language={getLanguageByFilePath(openFilePath)}
      value={openFileContent}
      onChange={(v) => setOpenFileContent(v ?? "")}
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      }}
    />
  )
}
```

#### D. 解释 + 反例

- **`if (activeDiff) return <InlineDiffView />` 在 hooks 之后**：若把它放最顶端会触发「条件 hook」违规。
- **保留 `langTable`**：维持 Day 7 的多语言高亮能力。
- **反例**：把 InlineDiffView 嵌在 Monaco 之上做 overlay —— Monaco 自带的滚动/虚拟化会跟 overlay 打架，且 user 可能误编辑底层 buffer。

#### E. 立刻验证

切换 activeDiff 状态，编辑器主体在 Monaco 与 InlineDiffView 之间无闪烁切换。

### 5.17 SettingsDialog：System Prompt / Max Iterations / Temperature

#### A. 动机

把 5.5 的三个新 ProviderConfig 字段暴露给用户。

#### B. 操作

重写 `src/components/settings/SettingsDialog.tsx`：表单加 textarea + 两个滑杆；统一用 CSS 变量风格；入场动画 `animate-fade-in-scale`。

#### C. 完整代码

```tsx
// src/components/settings/SettingsDialog.tsx
import { useState, useEffect, useCallback } from "react"
import { X, Eye, EyeOff, Settings } from "lucide-react"

interface Props { isOpen: boolean; onClose: () => void }

interface SettingsForm {
  apiKey: string
  baseURL: string
  model: string
  systemPrompt: string
  maxIterations: number
  temperature: number
}

const DEFAULTS: SettingsForm = {
  apiKey: "", baseURL: "", model: "",
  systemPrompt: "", maxIterations: 10, temperature: 0.7,
}

export default function SettingsDialog({ isOpen, onClose }: Props) {
  const [form, setForm] = useState<SettingsForm>(DEFAULTS)
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const cfg = await window.api.getChatSettings()
      if (cfg) setForm({ ...DEFAULTS, ...cfg })
    } catch { /* 无配置时保持默认 */ }
  }, [])

  useEffect(() => {
    if (isOpen) { loadSettings(); setShowApiKey(false) }
  }, [isOpen, loadSettings])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.updateChatSettings(form as any)
      onClose()
    } finally { setSaving(false) }
  }

  const update = (key: keyof SettingsForm, value: string | number) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const inputClass = `w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)]
    rounded-md px-3 py-1.5 text-sm text-[var(--color-fg-primary)]
    placeholder-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-accent)]
    transition-base`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]
                      rounded-xl shadow-2xl overflow-hidden animate-fade-in-scale">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg-primary)]">
            <Settings className="w-4 h-4 text-[var(--color-accent)]" />
            <span>设置</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-fg-muted)]
                       hover:text-[var(--color-fg-primary)] transition-base cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 表单 */}
        <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          <div className="text-[11px] uppercase tracking-widest text-[var(--color-fg-muted)] font-semibold">
            API 连接
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs text-[var(--color-fg-secondary)] mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? "text" : "password"}
                value={form.apiKey}
                onChange={(e) => update("apiKey", e.target.value)}
                placeholder="sk-..."
                className={`${inputClass} pr-9`}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-fg-muted)]
                           hover:text-[var(--color-fg-secondary)] transition-base cursor-pointer"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Base URL */}
          <div>
            <label className="block text-xs text-[var(--color-fg-secondary)] mb-1.5">Base URL</label>
            <input
              type="text" value={form.baseURL}
              onChange={(e) => update("baseURL", e.target.value)}
              placeholder="https://api.openai.com/v1"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
              留空使用默认端点。支持兼容 OpenAI 格式的第三方 API。
            </p>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-[var(--color-fg-secondary)] mb-1.5">模型</label>
            <input
              type="text" value={form.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="gpt-4o" className={inputClass}
            />
          </div>

          <div className="text-[11px] uppercase tracking-widest text-[var(--color-fg-muted)] font-semibold mt-2">
            Agent 行为
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-xs text-[var(--color-fg-secondary)] mb-1.5">
              System Prompt <span className="text-[var(--color-fg-muted)]">（可选）</span>
            </label>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => update("systemPrompt", e.target.value)}
              placeholder="可以在此添加额外的系统指令，会追加到默认系统提示词后面。"
              rows={3}
              className={`${inputClass} resize-none`}
            />
          </div>

          {/* Max Iterations */}
          <div>
            <label className="block text-xs text-[var(--color-fg-secondary)] mb-1.5">最大迭代轮次</label>
            <div className="flex items-center gap-3">
              <input
                type="range" min={1} max={30}
                value={form.maxIterations}
                onChange={(e) => update("maxIterations", parseInt(e.target.value))}
                className="flex-1 accent-[var(--color-accent)]"
              />
              <span className="text-sm font-mono text-[var(--color-fg-primary)] w-8 text-right">
                {form.maxIterations}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
              Agent 单次对话中调用工具的最大循环次数。
            </p>
          </div>

          {/* Temperature */}
          <div>
            <label className="block text-xs text-[var(--color-fg-secondary)] mb-1.5">Temperature</label>
            <div className="flex items-center gap-3">
              <input
                type="range" min={0} max={200}
                value={Math.round(form.temperature * 100)}
                onChange={(e) => update("temperature", parseInt(e.target.value) / 100)}
                className="flex-1 accent-[var(--color-accent)]"
              />
              <span className="text-sm font-mono text-[var(--color-fg-primary)] w-10 text-right">
                {form.temperature.toFixed(2)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
              控制模型输出的随机性。0 = 确定性，2 = 最大随机。
            </p>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm text-[var(--color-fg-secondary)]
                       hover:bg-[var(--color-bg-hover)] transition-base cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={handleSave} disabled={saving}
            className="px-4 py-1.5 rounded-md text-sm bg-[var(--color-accent)]
                       hover:bg-[var(--color-accent-hover)] disabled:opacity-50
                       text-white font-medium transition-base cursor-pointer"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

> 其余组件（`ChatPanel.tsx`、`ChatInput.tsx`、`ChatMessage.tsx`、`ToolCallBlock.tsx`、`FileExplorer.tsx`、`FileTreeItem.tsx`、`GitPanel.tsx`、`DiffViewer.tsx`、`Sidebar.tsx`、`StatusBar.tsx`、`TerminalInstance.tsx`）只做了「色彩 token 化」的批量迁移：把 `bg-gray-*` / `text-amber-*` 等替换为 `bg-[var(--color-bg-*)]` / `text-[var(--color-accent)]` / `text-[var(--color-fg-*)]`，并按需添上 `transition-base` / `animate-fade-in`。这部分纯样式 diff 不在此处展开，请直接对照 `day8/` 与 `day7/` 同名文件查看。

#### D. 解释 + 反例

- **`maxIterations` 滑杆 1~30**：1 用来调试「立刻终止」效果；30 已能涵盖绝大多数复杂任务。
- **`temperature` 用 0~200 整数 / 100 转浮点**：HTML range 不支持小数 step 在某些浏览器精度差，整数 step 后除以 100 更稳。
- **`form as any`**：因为 `RendererApi.updateChatSettings` 当前签名只接受三字段；本日改后端接口前先用 any 兜过编译。生产里要补类型扩展。
- **`{ ...DEFAULTS, ...cfg }`**：旧配置文件无新字段时落入 DEFAULTS，避免 textarea 显示 `undefined`。
- **反例**：`temperature` 用 number input —— 不直观；用户更爱可视化拉杆。
- **反例**：保存后不关闭 dialog —— 保存成功后用户期望立刻看到效果，不关 dialog 反而要他们手动 X 掉。

#### E. 立刻验证

打开设置 → 改 Temperature → 保存 → 重新打开设置 → 滑杆停留在保存的值；关掉应用重启再打开，仍然保留。

## 6. 端到端走查

冒烟脚本：

1. **启动**：`pnpm dev` → 主窗口出现，色彩为深蓝灰 `#0f1117`，无控制台报错。
2. **空态**：未点任何文件 → 编辑器区显示「没有打开的文件」（CSS 变量颜色）。
3. **设置三参数**：齿轮 → 写 systemPrompt = "回答前先打 [Day8]"，maxIterations = 5，temperature = 0.2 → 保存 → `userData/chat-settings.json` 应同时含三新字段。
4. **首次写文件**：让 Agent「创建 hello.txt 内容 Hello」→ 工具调用块出现 → 完成后编辑器自动跳出 InlineDiffView，左侧空、右侧 1 行 +Hello。顶部「待审核」标签栏出现 1 个文件。
5. **Accept**：点 Accept → diff 视图关闭、标签栏消失、editor.openFileContent 变为 "Hello"。
6. **再修改**：让 Agent「把 hello.txt 改成 Hi」→ diff 出现：左 -Hello、右 +Hi。
7. **Reject**：点 Reject → diff 关闭；磁盘上 hello.txt 变回 "Hello"（`Get-Content` 验证）。
8. **多文件**：让 Agent「同时修改 a.txt b.txt c.txt」→ 标签栏并列 3 个，点击切换。
9. **多轮工具上下文**：先让 Agent 读 hello.txt（read_file），下一句问「上次你读到的内容首字母是什么」→ 应答正确（说明 ChatService.messages 保留了 tool 消息）。
10. **Ollama 文本回退**：切到 Ollama 配置（已默认），让 Agent 简单 list_files；若它输出 `{"name":"list_files","arguments":{...}}`，AgentLoop 应仍能解析并执行。
11. **maxIterations 限额**：把上限改成 1，发起需要多步操作的任务 → 第 1 轮后停止 + 显示「已达到最大迭代次数」错误。
12. **systemPrompt 生效**：保存 systemPrompt = "回答前先打 [Day8]" → 下一句对话回复以 "[Day8]" 开头。
13. **动画**：弹出设置时 dialog 有 fade-in-scale；ChatPanel 取消按钮 / 迭代徽标有 fade-in。

## 7. 完整运行流程追踪

以「让 Agent 把 README 第一行改成 # Hi」为例：

1. **renderer / `ChatInput`** → `useChat.sendMessage("...")` → `chat.store.sendMessage` → `window.api.sendChatMessage(message, workspaceRoot)`
2. **preload / `ipcRenderer.invoke`** → main `chat:send-message` handler → `chatService.sendMessage(...)`
3. **main / `ChatService`** push user message → `new AgentLoop(provider, registry, { maxIterations, systemPrompt, temperature })`
4. **AgentLoop.run** 注入 system prompt → 进入 `for (iter)` → `provider.chat({ messages, tools, stream, temperature })`
5. **OpenAIProvider** 流式解码 → `text_delta` chunk 一直发；最终 `tool_calls` 包含 `edit_file`：
   - `tool_call_start` → AgentLoop 透传 `callbacks.onToolCallStart` → ipc `chat:tool-call`
   - `tool_call_end` → 入 toolCalls
6. **AgentLoop** 检测 toolCalls 非空 → 跳过「Ollama 文本回退」 → push assistant tool_calls 到 messages → 调 `registry.execute("edit_file", args, { workspacePath, onFileChange })`
7. **edit_file.tool**：
   - 路径校验
   - `fs.readFile(absTarget)` → `content`
   - 唯一性校验
   - `fs.writeFile(absTarget, newContent)`
   - `context.onFileChange?.({ filePath, oldContent: content, newContent, toolName: "edit_file" })`
8. **回调链**：tool ➡️ AgentLoop.callbacks.onFileChange ➡️ ChatService.onFileChange ➡️ chat.ipc safeSend("chat:file-change", info)
9. **renderer / `useChat`** `onChatFileChange` → `useEditorStore.addPendingDiff(info)` → `reviewDiff(filePath)` → `activeDiff` 被设置
10. **EditorArea** 重渲染：标签栏出现该文件；MonacoWrapper 因 `activeDiff` 非空 → 切到 `<InlineDiffView />`
11. **InlineDiffView** `useMemo` 跑 LCS → 渲染左旧右新 + 高亮 + Accept/Reject
12. **同时**：AgentLoop 把工具结果 push 为 tool 消息 → 进入下一轮 → 模型给出最终自然语言回复 → `text_delta` 流入 ChatPanel
13. AgentLoop 出循环 → `callbacks.onComplete(finalText, messages.slice(1))`
14. **ChatService.onComplete** → `this.messages = conversationMessages` → safeSend("chat:complete", { message })
15. **renderer / chat.store** `handleComplete` → 标记 isStreaming=false
16. 用户看 diff，点 Accept → `useEditorStore.acceptDiff()` → 状态清理 + openFileContent=newContent
17. 或点 Reject → `useEditorStore.rejectDiff()` → `window.api.revertFileChange(filePath, oldContent)` → main `chat:revert-file` → `fs.writeFileSync(filePath, oldContent)` → 状态清理 + openFileContent=oldContent

## 9. 自测清单

逐条对应 §1 的目标产出：

- [ ] **G1**：让 Agent 写一个新文件 → 编辑器自动出现 InlineDiffView，行号双列、绿增红删。
- [ ] **G2**：Diff 视图顶部 Accept / Reject 可见且可点；Accept 关闭视图，Reject 关闭并回滚磁盘内容（`Get-Content` 验证）。
- [ ] **G3**：让 Agent 同时改 ≥2 个文件 → 顶部「待审核」标签栏出现对应数量按钮，点击切换。
- [ ] **G4**：DevTools Elements 选中任意按钮 → computed style 颜色来自 `var(--color-…)`；改 `:root` 一个变量值，刷新即可看到全局换色。
- [ ] **G5**：在控制台 `document.querySelectorAll('.animate-fade-in').length > 0` 为 true；触发设置 dialog 入场，肉眼可见动画。
- [ ] **G6**：SettingsDialog 显示 System Prompt textarea + Max Iterations 滑杆 + Temperature 滑杆。
- [ ] **G7**：保存设置后查看 `userData/chat-settings.json` 三新字段已写入。
- [ ] **G8**：删除 `chat-settings.json` 重启后无需配置即可发送对话（Ollama 在跑的前提下）。
- [ ] **G9**：先 read_file 一个文件，下一句基于其内容追问 → 模型答得出（说明对话历史保留了 tool 消息）。
- [ ] **G10**：用 Ollama，让 Agent 在文本中以 JSON 形式声明工具调用 → 工具仍被执行。

完成 ≥9/10 即可宣告 Day 8 通关。



# Day 7：Git 集成与高级工具（edit_file / run_command）

## 0. 前言

Day 6 完成之后，Agent 已经能够多轮调用工具完成复杂任务，但它手里的「写工具」仍然只有一把钝器：`write_file` —— 一次性整文件覆盖。这种粒度对修改大型源码非常不友好：模型必须把整个文件重新生成一遍，既浪费 token 又容易把无关代码写坏。

与此同时，作为一个「面向开发者」的 IDE，缺少 Git 是说不过去的：不能查看变更、不能暂存、不能提交，所有 Agent 写出来的代码都「无据可查」。

Day 7 要解决两件事：

1. **给 Agent 配两把更顺手的工具**：`edit_file`（精确字符串替换）和 `run_command`（在工作区里跑 Shell 命令）。
2. **把 Git 装进 IDE**：通过 `simple-git` 封装一套 main 进程服务，渲染端用一个独立的 GitPanel 完成 status / stage / commit / branch / diff 全流程；并且为了承载这个面板，把 Sidebar 改造成 VSCode 风格的「左侧 Activity Bar + 右侧面板」结构。顺便把之前散落在状态栏上的设置入口收拢到一个体面的 `SettingsDialog`。

## 1. 目标产出

完成本日代码后应当具备：

1. Agent 能够调用 `edit_file` 工具，对文件做精确字符串替换（要求 old_string 唯一匹配）。
2. Agent 能够调用 `run_command` 工具，在工作区中执行任意 Shell 命令并拿到 stdout/stderr。
3. main 进程提供 `GitService`，封装 `simple-git` 的 status / diff / add / commit / branch / checkout / log 七项操作。
4. 通过 `git:*` IPC 把上述能力暴露给渲染端。
5. 渲染端 `useGitStore` 对外提供异步 action（refreshStatus / stageFiles / commit / checkout / getDiff…）并缓存数据。
6. `GitPanel` 以 VSCode 源代码管理器风格展示分支、未暂存/已暂存文件、Diff、Commit 输入框。
7. `DiffViewer` 对 unified diff 文本做基础的语法高亮（+ 绿 / - 红 / @@ 蓝 / 文件头加粗）。
8. Sidebar 改造为「Activity Bar + 面板」双栏结构，可在「文件资源管理器」和「源代码管理」之间切换。
9. 提供 `SettingsDialog` 模态框，集中管理 API Key / Base URL / Model；入口位于 Activity Bar 底部。
10. StatusBar 显示当前 Git 分支。

## 2. 先跑起来

```powershell
cd GUIDE\day7
pnpm install
pnpm dev
```

冒烟流程：

1. 把 `GUIDE\day7` 目录用 `git init` 初始化（或用任意已有 Git 仓库作为工作区）。
2. 启动后点击左侧 Activity Bar 的 `GitBranch` 图标 → 进入 GitPanel，应能看到分支选择器和文件列表。
3. 在工作区随便修改一个文件 → 点 GitPanel 顶部的刷新按钮 → 文件出现在「未暂存的更改」中。
4. 点「全部暂存」→ 文件移动到「已暂存的更改」。
5. 写一句 commit 消息 → 点「提交」→ 列表清空，状态栏分支名仍然显示。
6. 在底部聊天面板让 Agent 「把 README.md 第一行改成 # Hello」，观察工具调用块出现 `edit_file` 而不是 `write_file`。
7. 让 Agent 「运行 `node -v`」，观察 `run_command` 的输出回到对话流。
8. 点击 Activity Bar 底部齿轮 → 弹出 SettingsDialog → 改密码可见性、保存配置。

## 3. 整体结构

### 3.1 目录树

```
day7/
├── package.json                      # 新增 simple-git 依赖
├── electron/
│   ├── preload.ts                    # 暴露 git:* 系列 API
│   ├── ipc/
│   │   ├── index.ts                  # 注册 registerGitIpcHandlers
│   │   └── git.ipc.ts                # ★ 新增：git:* 七个 handler
│   └── services/
│       ├── git.service.ts            # ★ 新增：simple-git 封装
│       └── agent/
│           ├── chat.service.ts       # 注册 editFile / runCommand 工具
│           └── tools/
│               ├── edit-file.tool.ts # ★ 新增：精确字符串替换
│               └── run-command.tool.ts # ★ 新增：Shell 命令执行
└── src/
    ├── vite-env.d.ts                 # 新增 GitStatus / GitBranch / GitLogEntry / git* API
    ├── stores/
    │   ├── editor.store.ts           # 新增 activeSidebarPanel 状态
    │   └── git.store.ts              # ★ 新增：Git 全局状态
    └── components/
        ├── git/
        │   ├── GitPanel.tsx          # ★ 新增：源代码管理面板
        │   └── DiffViewer.tsx        # ★ 新增：diff 高亮
        ├── settings/
        │   └── SettingsDialog.tsx    # ★ 新增：设置模态框
        └── layout/
            ├── Sidebar.tsx           # 改造为 Activity Bar + 面板
            └── StatusBar.tsx         # 显示当前 Git 分支
```

### 3.2 数据链路

#### Git 链路

```
GitPanel.tsx
  └─ useGitStore.refreshStatus(repoPath)
        └─ window.api.gitStatus(repoPath)            （preload）
              └─ ipcRenderer.invoke('git:status')    （IPC）
                    └─ git.ipc.ts handler
                          └─ GitService.status()
                                └─ simpleGit(repoPath).status()
                                      ↓ 返回 StatusResult
                          ↑ 映射为 GitStatus
              ↑ Promise<GitStatus>
        ↑ set({ status })
  ↑ 重渲染 → 文件列表 / 分支
```

#### 工具调用链路（Agent → edit_file）

```
LLM 流式响应 → tool_calls (name=edit_file)
  └─ AgentLoop.run() 收到 tool_calls
        └─ ToolRegistry.execute('edit_file', args, ctx)
              └─ editFileTool.execute(args, ctx)
                    ├─ 路径越界校验
                    ├─ fs.readFile
                    ├─ 唯一性校验（split count）
                    └─ fs.writeFile（替换后内容）
              ↑ 返回 "文件 xx 修改成功..."
        ↑ 作为 tool 消息塞进对话历史
  ↑ 进入下一轮 chat.completions
```

### 3.3 步骤索引

| # | 步骤 | 文件 | 类型 |
|---|------|------|------|
| 5.1 | 安装 simple-git 依赖 | `package.json` | 修改 |
| 5.2 | 编写 GitService（封装 simple-git） | `electron/services/git.service.ts` | 新增 |
| 5.3 | 注册 git:* IPC handler | `electron/ipc/git.ipc.ts` | 新增 |
| 5.4 | 在 IPC 总入口挂载 Git handler | `electron/ipc/index.ts` | 修改 |
| 5.5 | preload 暴露 gitXxx API | `electron/preload.ts` | 修改 |
| 5.6 | 在 vite-env.d.ts 补类型 | `src/vite-env.d.ts` | 修改 |
| 5.7 | 实现 edit_file 工具 | `electron/services/agent/tools/edit-file.tool.ts` | 新增 |
| 5.8 | 实现 run_command 工具 | `electron/services/agent/tools/run-command.tool.ts` | 新增 |
| 5.9 | ChatService 注册新工具 | `electron/services/agent/chat.service.ts` | 修改 |
| 5.10 | 编写 useGitStore | `src/stores/git.store.ts` | 新增 |
| 5.11 | editor.store 增加 activeSidebarPanel | `src/stores/editor.store.ts` | 修改 |
| 5.12 | 编写 DiffViewer | `src/components/git/DiffViewer.tsx` | 新增 |
| 5.13 | 编写 GitPanel | `src/components/git/GitPanel.tsx` | 新增 |
| 5.14 | 编写 SettingsDialog | `src/components/settings/SettingsDialog.tsx` | 新增 |
| 5.15 | 改造 Sidebar 为 Activity Bar 结构 | `src/components/layout/Sidebar.tsx` | 修改 |
| 5.16 | StatusBar 显示当前分支 | `src/components/layout/StatusBar.tsx` | 修改 |

## 4. 基础知识

### 4.1 simple-git

`simple-git` 是对系统 `git` 命令的轻量级 Promise 化封装。核心用法：

```ts
import simpleGit from 'simple-git'
const git = simpleGit('/path/to/repo')
const status = await git.status()       // StatusResult
await git.add(['file.ts'])
await git.commit('msg')
```

它要求宿主机上必须装有 `git` 可执行文件 —— 不像 `isomorphic-git` 那样自带实现。这是个权衡：依赖系统 git 意味着我们得到所有官方行为（包括 hooks、submodules、worktree…）的自然支持，代价是部署时需要确保用户机器有 git。

`status()` 返回的 `files` 数组，每个元素有 `index` 和 `working_dir` 两个字段，分别对应「暂存区状态」和「工作区状态」。它们是单字符代码：

| 字符 | 含义 |
|------|------|
| ` ` (空格) | 未变化 |
| `M` | 已修改 |
| `A` | 新增（仅 index 区出现） |
| `D` | 删除 |
| `R` | 重命名 |
| `?` | 未跟踪（仅 working_dir 区） |
| `!` | 被 .gitignore 忽略 |

GitPanel 里我们用这两个字段把文件分成「未暂存」和「已暂存」两组。

### 4.2 unified diff 格式

`git diff` 输出的是 unified diff，关键标记如下：

```
diff --git a/foo.ts b/foo.ts        ← diff 开头（元信息）
index abc1234..def5678 100644       ← 哈希（元信息）
--- a/foo.ts                         ← 旧文件（粗体白）
+++ b/foo.ts                         ← 新文件（粗体白）
@@ -10,5 +10,7 @@ context              ← 行号区段（蓝）
 unchanged line                      ← 上下文（灰）
-removed line                        ← 删除（红）
+added line                          ← 新增（绿）
```

DiffViewer 只需要按行首字符 switch 一下就能给出基础高亮，不必引入完整的 diff parser。

### 4.3 「精确字符串替换」vs「行号替换」

主流的代码编辑接口有两种思路：

- 行号替换：模型说「把 12-15 行换成 …」。简单直观，但行号在多次编辑后会漂移，模型必须拿到最新的行号才能正确工作 —— 这非常脆弱。
- 精确字符串替换：模型给出「old_string + new_string」，工具自己在文件里查找。只要保证 old_string 在文件中**唯一**出现，无论行号怎么变，定位都准确。

`edit_file` 选择第二种。唯一性是关键：出现 0 次说明模型记错了内容，应让它重读；出现 >1 次说明上下文不够，应让它附带更多前后行 —— 都是模型可以自我修正的错误。

### 4.4 `execSync` 与跨平台 shell

`run_command` 用 `child_process.execSync` 同步执行，因为 Agent Loop 本身是顺序步进的，没必要为单次工具调用引入异步流式输出。三个保护参数：

- `timeout: 30_000`：超过 30 秒强制 SIGTERM，防止挂死。
- `maxBuffer: 10MB`：避免输出缓冲区溢出抛错。
- 输出再做一次 10 000 字符的截断（保留头尾），防止 token 爆炸。
- `shell` 在 Windows 用 `powershell.exe`，其他平台用 `/bin/sh`，让命令字符串的语义跨平台一致。

### 4.5 VSCode 风格 Activity Bar

VSCode 的左侧栏分两层：最外层 40px 宽的 **Activity Bar**（图标列），右侧是当前激活面板（资源管理器 / 源代码管理 / 调试 / 扩展…）。我们把 Sidebar 拆成这两层，并在 `editor.store` 里用一个 `activeSidebarPanel: 'files' | 'git'` 状态做切换。这种结构方便后续继续加面板（搜索、调试…）。

## 5. 编码步骤

### 5.1 安装 simple-git

#### A. 动机

Git 操作需要一个稳定的 Promise 化封装；自己 spawn `git` 进程再 parse 输出既危险又冗长。

#### B. 操作

在 `package.json` 的 `dependencies` 里加上 `simple-git`，然后 `pnpm install`。

#### C. 完整代码（关键改动）

```jsonc
// package.json
{
  "dependencies": {
    "openai": "^4.80.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-resizable-panels": "^2.1.0",
    "simple-git": "^3.36.0",
    "zustand": "^5.0.0"
  }
}
```

#### D. 解释 + 反例

- `simple-git` 是 main 进程依赖（Node 侧），不能在渲染进程直接 import；所有调用必须穿过 IPC。
- **反例**：`import simpleGit from 'simple-git'` 写在 `src/components/git/GitPanel.tsx` 里 —— Vite 会把它打进渲染端 bundle，运行时报 `child_process` 找不到。

#### E. 立刻验证

```powershell
pnpm install
node -e "console.log(require('simple-git').simpleGit)"
```

应输出一个 function。

### 5.2 编写 GitService

#### A. 动机

把 `simple-git` 的细节封装在 main 进程内，渲染端只看到一组干净的方法 + 干净的 DTO。

#### B. 操作

新建 `electron/services/git.service.ts`，定义 4 个返回类型 + 1 个 `GitService` 类。每个方法都接收 `repoPath`，本身无状态，便于复用。

#### C. 完整代码

```ts
// electron/services/git.service.ts
import simpleGit from "simple-git"

export interface GitFileStatus {
  path: string
  /** index 区（暂存区）状态字符：' '=未改动 'M'=修改 'A'=新增 'D'=删除 '?'=未跟踪 */
  index: string
  /** working_dir 区（工作区）状态字符 */
  working_dir: string
}

export interface GitStatus {
  current: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  isClean: boolean
}

export interface GitBranch {
  name: string
  current: boolean
  commit: string
}

export interface GitLogEntry {
  hash: string
  date: string
  message: string
  author: string
}

export default class GitService {
  async status(repoPath: string): Promise<GitStatus> {
    const git = simpleGit(repoPath)
    const result = await git.status()
    return {
      current: result.current,
      ahead: result.ahead,
      behind: result.behind,
      files: result.files.map((f) => ({
        path: f.path,
        index: f.index,
        working_dir: f.working_dir,
      })),
      isClean: result.isClean(),
    }
  }

  async diff(repoPath: string, filePath?: string): Promise<string> {
    const git = simpleGit(repoPath)
    return filePath ? git.diff([filePath]) : git.diff()
  }

  async add(repoPath: string, files: string[]): Promise<void> {
    await simpleGit(repoPath).add(files)
  }

  async commit(repoPath: string, message: string): Promise<string> {
    const result = await simpleGit(repoPath).commit(message)
    return result.commit
  }

  async branches(repoPath: string): Promise<GitBranch[]> {
    const result = await simpleGit(repoPath).branch()
    return Object.values(result.branches).map((b) => ({
      name: b.name,
      current: b.current,
      commit: b.commit,
    }))
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    await simpleGit(repoPath).checkout(branch)
  }

  async log(repoPath: string, maxCount = 20): Promise<GitLogEntry[]> {
    const result = await simpleGit(repoPath).log({ maxCount })
    return result.all.map((e) => ({
      hash: e.hash.slice(0, 7),
      date: e.date,
      message: e.message,
      author: e.author_name,
    }))
  }
}
```

#### D. 解释 + 反例

- **DTO 与原始返回值解耦**：`simple-git` 的 `StatusResult` 含有大量我们用不到的字段（也夹杂方法），直接 return 的话经过 IPC 序列化会掉方法、留奇怪字段。我们手工映射到自己的 `GitStatus`，类型清晰、契约明确。
- 每个方法都现 new 一个 `simpleGit(repoPath)` 实例 —— 它是廉价对象，且让 GitService 自身保持无状态、可被多个 IPC handler 共用。
- **反例**：`return result`（直接把 `StatusResult` 透传）—— 渲染端拿到的对象上 `isClean()` 方法已丢失，相关 UI 会崩。

#### E. 立刻验证

后续 5.3 注册 IPC 后再统一验证。

### 5.3 注册 git:* IPC handler

#### A. 动机

把 GitService 的 7 个方法暴露成 7 个 `git:*` IPC 频道。

#### B. 操作

新建 `electron/ipc/git.ipc.ts`。仿照 `chat.ipc.ts` 的写法：先 `removeHandler` 再 `handle`，避免 HMR 重注册时报「duplicate handler」。

#### C. 完整代码

```ts
// electron/ipc/git.ipc.ts
import { ipcMain, type IpcMainInvokeEvent } from "electron"
import GitService from "../services/git.service"

const gitService = new GitService()

export function registerGitIpcHandlers(): void {
  ipcMain.removeHandler("git:status")
  ipcMain.removeHandler("git:diff")
  ipcMain.removeHandler("git:add")
  ipcMain.removeHandler("git:commit")
  ipcMain.removeHandler("git:branches")
  ipcMain.removeHandler("git:checkout")
  ipcMain.removeHandler("git:log")

  ipcMain.handle("git:status", (_e: IpcMainInvokeEvent, repoPath: string) =>
    gitService.status(repoPath),
  )
  ipcMain.handle("git:diff", (_e: IpcMainInvokeEvent, repoPath: string, filePath?: string) =>
    gitService.diff(repoPath, filePath),
  )
  ipcMain.handle("git:add", (_e: IpcMainInvokeEvent, repoPath: string, files: string[]) =>
    gitService.add(repoPath, files),
  )
  ipcMain.handle("git:commit", (_e: IpcMainInvokeEvent, repoPath: string, message: string) =>
    gitService.commit(repoPath, message),
  )
  ipcMain.handle("git:branches", (_e: IpcMainInvokeEvent, repoPath: string) =>
    gitService.branches(repoPath),
  )
  ipcMain.handle("git:checkout", (_e: IpcMainInvokeEvent, repoPath: string, branch: string) =>
    gitService.checkout(repoPath, branch),
  )
  ipcMain.handle("git:log", (_e: IpcMainInvokeEvent, repoPath: string, maxCount?: number) =>
    gitService.log(repoPath, maxCount),
  )
}
```

#### D. 解释 + 反例

- **`removeHandler` 先于 `handle`**：electron-vite 的 HMR 会重新执行 main 模块；不先移除，第二次启动就会抛 `Attempted to register a second handler for 'git:status'`。
- **共享 `gitService` 单例**：因为它无状态，没必要每个 handler new 一个。
- **反例**：直接 `ipcMain.handle('git:status', gitService.status)` —— `this` 丢失（虽然这里 `status()` 内部没用到 `this`，但养成「显式包一层箭头函数」的习惯可避免坑）。

#### E. 立刻验证

`electron-vite dev` 启动时若控制台未报「duplicate handler」即为成功；功能验证留到 5.10 之后。

### 5.4 在 IPC 总入口挂载 Git handler

#### A. 动机

`registerIpcHandlers` 是 main 启动时一次性调用的总开关，新模块必须在这里登记一笔。

#### B. 操作

修改 `electron/ipc/index.ts`，加一行 `registerGitIpcHandlers()`。

#### C. 完整代码

```ts
// electron/ipc/index.ts
import { registerFileSystemIpcHandlers } from './file-system.ipc'
import { registerTerminalIpcHandlers } from './terminal.ipc'
import { registerChatIpcHandlers } from './chat.ipc'
import { registerGitIpcHandlers } from './git.ipc'

export function registerIpcHandlers(): void {
  registerTerminalIpcHandlers()
  registerFileSystemIpcHandlers()
  registerChatIpcHandlers()
  registerGitIpcHandlers()
}
```

#### D. 解释 + 反例

- 新模块漏注册是「沉默失败」最常见的来源 —— 渲染端调用 `gitStatus`，主进程没人接，最终 Promise reject 且消息是「No handler registered for 'git:status'」。
- **反例**：把 `registerGitIpcHandlers()` 写在 `app.whenReady` 之外但 `BrowserWindow` 之后 —— 渲染端在第一次 invoke 时仍能成功（IPC 监听是同步注册），但代码组织上让人迷惑。

#### E. 立刻验证

启动后开 DevTools：`await window.api.gitStatus('.')` 应能拿到一个 `null` 或异常对象（取决于工作区是否 Git 仓库），不应当报「No handler」。

### 5.5 preload 暴露 gitXxx API

#### A. 动机

渲染端要靠 `window.api.gitXxx` 来调用 IPC；preload 是 main 与 renderer 之间唯一的桥梁。

#### B. 操作

修改 `electron/preload.ts`，在 `api` 对象末尾追加 7 个方法。

#### C. 完整代码（增量）

```ts
// electron/preload.ts （在 api 对象末尾追加）
const api = {
  // ...Day 2~6 的方法保持不变...

  // Git (Day 7 新增)
  gitStatus: (repoPath: string) => ipcRenderer.invoke("git:status", repoPath),
  gitDiff: (repoPath: string, filePath?: string) => ipcRenderer.invoke("git:diff", repoPath, filePath),
  gitAdd: (repoPath: string, files: string[]) => ipcRenderer.invoke("git:add", repoPath, files),
  gitCommit: (repoPath: string, message: string) => ipcRenderer.invoke("git:commit", repoPath, message),
  gitBranches: (repoPath: string) => ipcRenderer.invoke("git:branches", repoPath),
  gitCheckout: (repoPath: string, branch: string) => ipcRenderer.invoke("git:checkout", repoPath, branch),
  gitLog: (repoPath: string, maxCount?: number) => ipcRenderer.invoke("git:log", repoPath, maxCount),
}
```

#### D. 解释 + 反例

- **方法名小驼峰，频道名 kebab-case**：约定俗成的 IPC 命名分工 —— 频道字符串易于通信层 grep，TS API 名称符合 JS 习惯。
- **反例**：`gitStatus: ipcRenderer.invoke.bind(ipcRenderer, 'git:status')` —— 看起来更短，但失去 `repoPath` 参数的类型推断，调用处会被推成 `(...args: any[])`。

#### E. 立刻验证

DevTools 中输入 `window.api.gitBranches` 应当返回一个函数。

### 5.6 在 vite-env.d.ts 补类型

#### A. 动机

为新增的 `RendererApi` 方法和 DTO 提供类型，让组件代码享受自动补全和类型校验。

#### B. 操作

在 `src/vite-env.d.ts` 中补上 4 个 Git DTO + 7 个 git API。

#### C. 完整代码（增量）

```ts
// src/vite-env.d.ts （新增片段）

// Git 类型（Day 7 新增）
interface GitFileStatus {
  path: string
  index: string
  working_dir: string
}

interface GitStatus {
  current: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  isClean: boolean
}

interface GitBranch {
  name: string
  current: boolean
  commit: string
}

interface GitLogEntry {
  hash: string
  date: string
  message: string
  author: string
}

interface RendererApi {
  // ...省略 Day 2~6 字段...

  // Git (Day 7 新增)
  gitStatus: (repoPath: string) => Promise<GitStatus>
  gitDiff: (repoPath: string, filePath?: string) => Promise<string>
  gitAdd: (repoPath: string, files: string[]) => Promise<void>
  gitCommit: (repoPath: string, message: string) => Promise<string>
  gitBranches: (repoPath: string) => Promise<GitBranch[]>
  gitCheckout: (repoPath: string, branch: string) => Promise<void>
  gitLog: (repoPath: string, maxCount?: number) => Promise<GitLogEntry[]>
}
```

#### D. 解释 + 反例

- 这里的 `interface GitStatus` 必须和 `GitService.status()` 的返回类型字段一致 —— 它们是同一份契约的两个声明（main 和 renderer 两侧各看一份）。
- **反例**：把这些类型 `import type` 自 `electron/services/git.service.ts` —— 渲染端 tsconfig 通常不允许跨 `electron/` 目录 import，且会让 vite-env.d.ts 失去「全局声明」的语义。

#### E. 立刻验证

随便打 `const x: GitStatus = ...`，TS 应能识别。

### 5.7 实现 edit_file 工具

#### A. 动机

让 Agent 不再需要把整个文件重新生成一遍，而是「指哪打哪」地做局部修改 —— 既省 token 也降低误改风险。

#### B. 操作

新建 `electron/services/agent/tools/edit-file.tool.ts`。三道关卡：路径越界 → 文件存在 → old_string 唯一性。

#### C. 完整代码

```ts
// electron/services/agent/tools/edit-file.tool.ts
import { promises as fs } from "fs"
import * as path from "path"
import type { AgentTool } from "./tool-registry"

const editFileTool: AgentTool = {
  name: "edit_file",
  description:
    "通过精确字符串匹配，将文件中的 old_string 替换为 new_string。" +
    "old_string 必须在文件中唯一出现（包含足够的上下文行）。" +
    "修改前建议先用 read_file 读取文件内容，确保 old_string 与实际内容完全一致（含缩进/空格）。",

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "相对于工作区根目录的文件路径。",
      },
      old_string: {
        type: "string",
        description:
          "要被替换的精确文本（区分大小写，含空白字符）。" +
          "必须包含足够多的上下文行（通常 3~5 行）以保证唯一匹配。",
      },
      new_string: {
        type: "string",
        description: "替换后的新文本。可以为空字符串（相当于删除 old_string）。",
      },
    },
    required: ["path", "old_string", "new_string"],
  },

  async execute(args, context): Promise<string> {
    const relativePath = String(args.path ?? "")
    const oldString = String(args.old_string ?? "")
    const newString = String(args.new_string ?? "")

    if (!relativePath) return JSON.stringify({ error: "参数 path 不能为空。" })
    if (!oldString) return JSON.stringify({ error: "参数 old_string 不能为空。" })

    // ── 路径安全校验（防止路径穿越） ─────────────────────────────────────
    const absTarget = path.resolve(context.workspacePath, relativePath)
    const rel = path.relative(path.resolve(context.workspacePath), absTarget)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return JSON.stringify({ error: "安全错误：不允许编辑工作区目录之外的文件。" })
    }

    // ── 读取文件 ───────────────────────────────────────────────────────
    let content: string
    try {
      content = await fs.readFile(absTarget, "utf-8")
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === "ENOENT") {
        return JSON.stringify({ error: `文件不存在：${rel}` })
      }
      return JSON.stringify({ error: `读取文件失败：${err.message}` })
    }

    // ── 唯一性校验 ─────────────────────────────────────────────────────
    const occurrences = content.split(oldString).length - 1

    if (occurrences === 0) {
      return JSON.stringify({
        error:
          `在 ${rel} 中未找到 old_string。` +
          "请用 read_file 重新读取文件内容，确保文本（含缩进/换行）与文件实际内容完全一致。",
      })
    }

    if (occurrences > 1) {
      return JSON.stringify({
        error:
          `old_string 在 ${rel} 中出现了 ${occurrences} 次，无法唯一定位修改位置。` +
          "请在 old_string 中包含更多上下文行（前后各 3~5 行）以确保唯一匹配。",
      })
    }

    // ── 执行替换 ───────────────────────────────────────────────────────
    const newContent = content.replace(oldString, newString)
    await fs.writeFile(absTarget, newContent, "utf-8")

    const oldLines = oldString.split("\n").length
    const newLines = newString.split("\n").length
    const delta = newLines - oldLines
    const sign = delta >= 0 ? "+" : ""
    return `文件 ${rel} 修改成功。替换了 ${oldLines} 行 → ${newLines} 行（${sign}${delta} 行）。`
  },
}

export default editFileTool
```

#### D. 解释 + 反例

- **唯一性 = 0 与 > 1 给不同错误**：让模型知道是「内容对不上」还是「需要更多上下文」，可以做出不同的自我修正。
- **`split(s).length - 1` 替代 `matchAll`**：避免对正则元字符做转义；纯字符串语义最稳。
- **报告替换行数**：模型在多次 edit 后会自检「我到底改了几行」，给它一个数字便于推理。
- **反例**：用正则 `new RegExp(escape(oldString), 'g')` 然后 `replace` —— 若 old_string 包含大量特殊字符或 Unicode，转义易写错；况且我们已经断言唯一，根本不需要全局替换。
- **反例**：在唯一性 = 0 时返回「成功，无变化」—— 模型会以为它的修改生效了，导致后续基于错误前提做下一步操作。

#### E. 立刻验证

DevTools 让 Agent：「把 README.md 中的 `Day 6` 改为 `Day 6 (edited)`」。观察 ToolCallBlock 出现 `edit_file` 调用并返回成功消息。

### 5.8 实现 run_command 工具

#### A. 动机

许多任务（运行测试、查 git、装包）让 Agent 自己 spawn 子进程比让用户手动复制命令贴到终端要顺畅得多。

#### B. 操作

新建 `electron/services/agent/tools/run-command.tool.ts`。三道安全闸门：cwd 越界、超时、输出截断。

#### C. 完整代码

```ts
// electron/services/agent/tools/run-command.tool.ts
import { execSync } from "child_process"
import * as path from "path"
import type { AgentTool } from "./tool-registry"

/** 命令执行超时（毫秒）。 */
const TIMEOUT_MS = 30_000
/** 返回给模型的最大输出字符数（防止撑爆上下文）。 */
const MAX_OUTPUT = 10_000

/** 输出超长时截取头尾各一半并插入省略提示。 */
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT) return output
  const half = Math.floor(MAX_OUTPUT / 2)
  return (
    output.slice(0, half) +
    `\n\n--- 输出已截断（原始长度 ${output.length} 字符）---\n\n` +
    output.slice(-half)
  )
}

const runCommandTool: AgentTool = {
  name: "run_command",
  description:
    "在工作区目录（或指定子目录）中执行 Shell 命令，返回 stdout / stderr 合并输出。" +
    "适用于：运行测试、执行构建、安装依赖、查看 Git 状态等。" +
    "命令超时上限：30 秒。",

  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 Shell 命令，例如 'npm test' 或 'git status'。",
      },
      cwd: {
        type: "string",
        description:
          "可选。命令执行目录（相对于工作区根目录）。默认为工作区根目录。",
      },
    },
    required: ["command"],
  },

  async execute(args, context): Promise<string> {
    const command = String(args.command ?? "").trim()
    if (!command) return JSON.stringify({ error: "参数 command 不能为空。" })

    // ── cwd 路径安全校验 ────────────────────────────────────────────────
    let cwd: string
    if (args.cwd) {
      const absTarget = path.resolve(context.workspacePath, String(args.cwd))
      const rel = path.relative(path.resolve(context.workspacePath), absTarget)
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return JSON.stringify({ error: "安全错误：不允许在工作区目录之外执行命令。" })
      }
      cwd = absTarget
    } else {
      cwd = context.workspacePath
    }

    // ── 执行命令 ────────────────────────────────────────────────────────
    try {
      const output = execSync(command, {
        cwd,
        timeout: TIMEOUT_MS,
        encoding: "utf-8",
        shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      })
      return truncate(output?.trim() ?? "(命令执行完毕，无输出)")
    } catch (error) {
      const err = error as {
        killed?: boolean
        signal?: string
        status?: number
        stdout?: string
        stderr?: string
        message?: string
      }

      if (err.killed || err.signal === "SIGTERM") {
        return `命令执行超时（超过 ${TIMEOUT_MS / 1000} 秒）。请考虑使用更快速的命令或减小工作量。`
      }

      const parts: string[] = []
      if (err.stdout?.trim()) parts.push(err.stdout.trim())
      if (err.stderr?.trim()) parts.push(err.stderr.trim())
      const output = parts.length > 0 ? parts.join("\n") : (err.message ?? "未知错误")
      const exitInfo = err.status != null ? `\n(退出码: ${err.status})` : ""
      return truncate(output + exitInfo)
    }
  },
}

export default runCommandTool
```

#### D. 解释 + 反例

- **失败也要把 stderr/stdout 给模型**：`npm test` 失败时模型必须看到完整报错才能定位问题；只返回 `err.message` 等于把它蒙住眼睛。
- **平台差异内建在 `shell` 选项**：PowerShell 和 sh 的语法差异由 OS shell 自己处理，工具层不掺和。
- **截断头尾保留**：长输出（如 build 日志）通常「开头有上下文、结尾有错误」，所以两端各保留一半比只保留前 N 字符更有用。
- **反例**：用 `spawn` + 流式 pipe 把输出实时推给前端 —— 我们的 Agent Loop 是同步推进的，每一轮等到工具完成才进下一轮，没有「实时输出」的消费者，反而引入并发复杂度。
- **反例**：不设 `timeout`，让 `npm install`（首次拉包很慢）卡住 Agent —— 整轮对话陷入沉默直到用户手动取消。30 秒不算激进，可视场景调高。

#### E. 立刻验证

让 Agent 「跑 `node -v` 并告诉我版本」，应当看到工具结果直接返回 `v22.x.x` 类似字符串。

### 5.9 ChatService 注册新工具

#### A. 动机

`AgentLoop` 通过 `ToolRegistry` 路由调用，新工具必须先注册才会出现在「functions list」里。

#### B. 操作

修改 `electron/services/agent/chat.service.ts`，import 两个新工具并 `register`。

#### C. 完整代码（关键改动）

```ts
// electron/services/agent/chat.service.ts （顶部 import 区）
import editFileTool from "./tools/edit-file.tool"
import runCommandTool from "./tools/run-command.tool"

// constructor 内
constructor() {
  this.settingsPath = join(app.getPath("userData"), "chat-settings.json")
  this.loadSettings()
  this.toolRegistry = new ToolRegistry()
  // Day 6 基础工具
  this.toolRegistry.register(readFileTool)
  this.toolRegistry.register(listFilesTool)
  this.toolRegistry.register(searchFilesTool)
  this.toolRegistry.register(writeFileTool)
  // Day 7 高级工具（精修改 + 跑命令）
  this.toolRegistry.register(editFileTool)
  this.toolRegistry.register(runCommandTool)
}
```

#### D. 解释 + 反例

- 注册顺序不影响行为，但**约定按照「读 → 列 → 搜 → 写 → 改 → 跑」的危险性递增排序**，便于人脑读 system prompt。
- **反例**：忘记注册却已在 preload 暴露 / 在 prompt 中提到 —— 模型调用时 ToolRegistry 找不到，返回 `Tool xxx not found`，模型一脸懵。

#### E. 立刻验证

DevTools 启动后让 Agent 列出它有哪些工具，应当能说出 6 个名字。

### 5.10 编写 useGitStore

#### A. 动机

把 IPC 调用 + 状态缓存抽象到一个 Zustand store，让 GitPanel 只关心 UI。

#### B. 操作

新建 `src/stores/git.store.ts`，state 4 项 + action 8 项。

#### C. 完整代码

```ts
// src/stores/git.store.ts
import { create } from "zustand"

interface GitState {
  status: GitStatus | null
  branches: GitBranch[]
  log: GitLogEntry[]
  diff: string
  loading: boolean

  refreshStatus: (repoPath: string) => Promise<void>
  refreshBranches: (repoPath: string) => Promise<void>
  refreshLog: (repoPath: string) => Promise<void>
  stageFiles: (repoPath: string, files: string[]) => Promise<void>
  unstageFiles: (repoPath: string, files: string[]) => Promise<void>
  commit: (repoPath: string, message: string) => Promise<void>
  checkout: (repoPath: string, branch: string) => Promise<void>
  getDiff: (repoPath: string, filePath?: string) => Promise<void>
}

export const useGitStore = create<GitState>((set) => ({
  status: null,
  branches: [],
  log: [],
  diff: "",
  loading: false,

  refreshStatus: async (repoPath: string) => {
    try {
      set({ loading: true })
      const status = await window.api.gitStatus(repoPath)
      set({ status, loading: false })
    } catch {
      // 不是 Git 仓库 / git 命令缺失：把 status 置 null，UI 据此提示
      set({ status: null, loading: false })
    }
  },

  refreshBranches: async (repoPath: string) => {
    try {
      const branches = await window.api.gitBranches(repoPath)
      set({ branches })
    } catch {
      set({ branches: [] })
    }
  },

  refreshLog: async (repoPath: string) => {
    try {
      const log = await window.api.gitLog(repoPath, 20)
      set({ log })
    } catch {
      set({ log: [] })
    }
  },

  stageFiles: async (repoPath: string, files: string[]) => {
    await window.api.gitAdd(repoPath, files)
  },

  // simple-git 的 unstage 需要 git reset HEAD <file>，Day 7 暂不实现，留接口占位
  unstageFiles: async (_repoPath: string, _files: string[]) => {
    // TODO: 实现 git reset HEAD <file>
  },

  commit: async (repoPath: string, message: string) => {
    await window.api.gitCommit(repoPath, message)
  },

  checkout: async (repoPath: string, branch: string) => {
    await window.api.gitCheckout(repoPath, branch)
  },

  getDiff: async (repoPath: string, filePath?: string) => {
    try {
      const diff = await window.api.gitDiff(repoPath, filePath)
      set({ diff })
    } catch {
      set({ diff: "" })
    }
  },
}))
```

#### D. 解释 + 反例

- **`refreshStatus` 失败时把 `status` 置 `null`**：UI 把 `null` 视作「不是 Git 仓库」分支，渲染一个友好的占位页。这比抛错让组件 try/catch 优雅得多。
- **`unstageFiles` 留 TODO**：Day 7 不实现，但保留接口契约，下一日补 `git reset` 时 UI 不需要改。
- **action 内**只 set 数据，不做副作用编排（如刷新别的 store）—— 编排留给组件层（`handleCommit` 自己调 `commit` 后再调 `refreshStatus`）。
- **反例**：`commit` 之后内部再 `await refreshStatus` —— 看起来贴心，但当组件想「批量做几件事再统一刷新」时，每个 action 都自动刷新会导致 UI 闪烁多次。

#### E. 立刻验证

DevTools 中 `useGitStore.getState().refreshStatus('.').then(()=>console.log(useGitStore.getState().status))`。

### 5.11 editor.store 增加 activeSidebarPanel

#### A. 动机

Sidebar 改造后需要「当前激活面板」状态，保存在 editor.store 里以便后续别处也能读到（例如 StatusBar 显示「当前面板：Git」）。

#### B. 操作

修改 `src/stores/editor.store.ts`，加 `activeSidebarPanel` 字段和对应 setter。

#### C. 完整代码

```ts
// src/stores/editor.store.ts
import { create } from 'zustand'

// Day 7: 新增侧边栏活动面板（files | git）状态
interface EditorState {
  isSidebarOpen: boolean
  isChatOpen: boolean
  openFilePath: string | null
  openFileContent: string
  activeSidebarPanel: 'files' | 'git'
  setSidebarOpen: (open: boolean) => void
  setChatOpen: (open: boolean) => void
  setOpenFile: (filePath: string, content: string) => void
  setOpenFileContent: (content: string) => void
  setActiveSidebarPanel: (panel: 'files' | 'git') => void
}

export const useEditorStore = create<EditorState>((set) => ({
  isSidebarOpen: true,
  isChatOpen: false,
  openFilePath: null,
  openFileContent: '',
  activeSidebarPanel: 'files',
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  setChatOpen: (open) => set({ isChatOpen: open }),
  setOpenFile: (filePath, content) =>
    set({
      openFilePath: filePath,
      openFileContent: content
    }),
  setOpenFileContent: (content) => set({ openFileContent: content }),
  setActiveSidebarPanel: (panel) => set({ activeSidebarPanel: panel }),
}))
```

#### D. 解释 + 反例

- 用字符串字面量联合类型 `'files' | 'git'` 而非 enum —— 序列化天然友好，TS 推断直接，未来加面板只需扩展联合类型。
- **反例**：在 Sidebar 组件内部用 `useState` 管理激活面板 —— 那么 StatusBar、命令面板等其他位置就读不到这个状态，需要 props 一路透传。

#### E. 立刻验证

启动后 DevTools `useEditorStore.getState().activeSidebarPanel` 应输出 `'files'`。

### 5.12 编写 DiffViewer

#### A. 动机

`git diff` 是纯文本，原样显示几乎不可读；做最小化的语法高亮就能极大提升可读性。

#### B. 操作

新建 `src/components/git/DiffViewer.tsx`，按行首字符 switch 颜色。

#### C. 完整代码

```tsx
// src/components/git/DiffViewer.tsx
interface Props {
  diff: string
}

export default function DiffViewer({ diff }: Props) {
  if (!diff.trim()) {
    return (
      <div className="px-3 py-6 text-center text-xs text-gray-500 select-none">
        当前无未提交改动
      </div>
    )
  }

  const lines = diff.split("\n")

  return (
    <div className="overflow-auto text-xs font-mono leading-5 select-text">
      {lines.map((line, i) => {
        let textClass = "text-gray-300"
        let bgClass = ""

        if (line.startsWith("+++") || line.startsWith("---")) {
          textClass = "text-white font-bold"
        } else if (line.startsWith("+")) {
          textClass = "text-green-400"
          bgClass = "bg-green-400/10"
        } else if (line.startsWith("-")) {
          textClass = "text-red-400"
          bgClass = "bg-red-400/10"
        } else if (line.startsWith("@@")) {
          textClass = "text-blue-400"
          bgClass = "bg-blue-400/5"
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          textClass = "text-gray-500"
        }

        return (
          <div key={i} className={`flex items-start px-2 py-px ${bgClass}`}>
            <span className="text-gray-600 select-none w-8 text-right mr-3 shrink-0 tabular-nums">
              {i + 1}
            </span>
            <span className={textClass}>{line || " "}</span>
          </div>
        )
      })}
    </div>
  )
}
```

#### D. 解释 + 反例

- **`+++` / `---` 必须先于 `+` / `-` 判断**，否则文件头会被错染成「行新增/删除」。
- **`leading-5` + `tabular-nums`**：固定行高 + 等宽数字，让左侧行号列对齐美观。
- **`line || " "`**：空行渲染成空 `<span>` 高度会塌陷，用一个空格占位。
- **反例**：使用 `dangerouslySetInnerHTML` 拼字符串 —— diff 内容含用户代码，HTML 注入风险；React 文本节点天然安全。
- **反例**：`if (line.startsWith('+'))` 在前 —— 文件头 `+++ b/foo.ts` 会被染成绿色加粗变成「新增行」，语义错乱。

#### E. 立刻验证

把任意一段 `git diff` 输出粘到 props 中，目测红绿黄三色齐全。

### 5.13 编写 GitPanel

#### A. 动机

把 store 的能力拼成一个「VSCode 源代码管理器」级别的可用面板。

#### B. 操作

新建 `src/components/git/GitPanel.tsx`。结构：顶部刷新按钮 → 分支选择器 → 未暂存 / 已暂存文件列表 → Diff 折叠区 → Commit 输入框。

#### C. 完整代码

```tsx
// src/components/git/GitPanel.tsx
import { useState, useEffect, useCallback } from "react"
import { GitBranch, GitCommit, RefreshCw, ChevronDown, ChevronRight, Eye } from "lucide-react"
import { useGitStore } from "../../stores/git.store"
import { useFileTreeStore } from "../../stores/file-tree.store"
import DiffViewer from "./DiffViewer"

export default function GitPanel() {
  const repoPath = useFileTreeStore((s) => s.workspaceRoot)
  const { status, branches, diff, loading, refreshStatus, refreshBranches, stageFiles, commit, checkout, getDiff } =
    useGitStore()

  const [commitMsg, setCommitMsg] = useState("")
  const [showDiff, setShowDiff] = useState(false)
  const [committing, setCommitting] = useState(false)

  // ── 加载数据 ────────────────────────────────────────────────────────────
  const loadAll = useCallback(() => {
    if (!repoPath) return
    refreshStatus(repoPath)
    refreshBranches(repoPath)
  }, [repoPath, refreshStatus, refreshBranches])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // ── 无工作区 ────────────────────────────────────────────────────────────
  if (!repoPath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-500 p-4 text-center">
        请先打开工作区目录
      </div>
    )
  }

  // ── Git 不可用 ───────────────────────────────────────────────────────────
  if (!loading && status === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-xs text-gray-500 p-4 gap-2 text-center">
        <GitBranch className="w-6 h-6 opacity-30" />
        <span>当前目录不是 Git 仓库</span>
      </div>
    )
  }

  // ── 文件分类 ────────────────────────────────────────────────────────────
  const stagedFiles = (status?.files ?? []).filter(
    (f) => f.index !== " " && f.index !== "?" && f.index !== "!",
  )
  const unstagedFiles = (status?.files ?? []).filter(
    (f) => f.working_dir !== " " && f.working_dir !== "!",
  )

  // ── 提交 ────────────────────────────────────────────────────────────────
  const handleCommit = async () => {
    if (!commitMsg.trim() || stagedFiles.length === 0) return
    setCommitting(true)
    try {
      await commit(repoPath, commitMsg.trim())
      setCommitMsg("")
      await refreshStatus(repoPath)
    } finally {
      setCommitting(false)
    }
  }

  // ── 暂存全部 ────────────────────────────────────────────────────────────
  const handleStageAll = async () => {
    const files = unstagedFiles.map((f) => f.path)
    if (files.length === 0) return
    await stageFiles(repoPath, files)
    await refreshStatus(repoPath)
  }

  // ── 查看 diff ───────────────────────────────────────────────────────────
  const handleToggleDiff = async () => {
    if (!showDiff) {
      await getDiff(repoPath)
    }
    setShowDiff((v) => !v)
  }

  // ── 切换分支 ────────────────────────────────────────────────────────────
  const handleCheckout = async (branch: string) => {
    await checkout(repoPath, branch)
    await refreshStatus(repoPath)
  }

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">源代码管理</span>
        <button
          onClick={loadAll}
          disabled={loading}
          title="刷新"
          className="p-1 rounded hover:bg-gray-700 text-gray-400 disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* 当前分支 */}
      <div className="px-3 py-2 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-1 text-xs text-gray-400 mb-1">
          <GitBranch className="w-3 h-3" />
          <span>分支</span>
        </div>
        <select
          value={status?.current ?? ""}
          onChange={(e) => handleCheckout(e.target.value)}
          className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500"
        >
          {branches.length > 0 ? (
            branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))
          ) : (
            <option value={status?.current ?? ""}>{status?.current ?? "（加载中）"}</option>
          )}
        </select>
        {(status?.ahead ?? 0) > 0 || (status?.behind ?? 0) > 0 ? (
          <div className="mt-1 text-xs text-gray-500">
            ↑ {status?.ahead} ↓ {status?.behind}
          </div>
        ) : null}
      </div>

      {/* 变更文件列表 */}
      <div className="flex-1 overflow-y-auto">
        {/* 未暂存 */}
        <div className="px-3 pt-2 pb-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400 font-medium">
              未暂存的更改 ({unstagedFiles.length})
            </span>
            {unstagedFiles.length > 0 && (
              <button
                onClick={handleStageAll}
                className="text-xs text-amber-400 hover:text-amber-300 px-1"
              >
                全部暂存
              </button>
            )}
          </div>
          {unstagedFiles.length === 0 ? (
            <div className="text-xs text-gray-600 py-1">无</div>
          ) : (
            unstagedFiles.map((f) => (
              <div
                key={f.path}
                className="flex items-center justify-between py-0.5 px-1 rounded hover:bg-gray-800 group"
              >
                <span
                  className={`text-xs truncate ${f.working_dir === "?" ? "text-green-400" : "text-amber-400"}`}
                  title={f.path}
                >
                  {f.path}
                </span>
                <span className="text-xs text-gray-600 ml-1 shrink-0">
                  {f.working_dir === "?" ? "U" : f.working_dir}
                </span>
              </div>
            ))
          )}
        </div>

        {/* 已暂存 */}
        <div className="px-3 pt-2 pb-1 border-t border-gray-800">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400 font-medium">
              已暂存的更改 ({stagedFiles.length})
            </span>
          </div>
          {stagedFiles.length === 0 ? (
            <div className="text-xs text-gray-600 py-1">无</div>
          ) : (
            stagedFiles.map((f) => (
              <div
                key={f.path}
                className="flex items-center justify-between py-0.5 px-1 rounded hover:bg-gray-800"
              >
                <span className="text-xs text-green-400 truncate" title={f.path}>
                  {f.path}
                </span>
                <span className="text-xs text-gray-600 ml-1 shrink-0">{f.index}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Diff 查看区 */}
      <div className="shrink-0 border-t border-gray-700">
        <button
          onClick={handleToggleDiff}
          className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800"
        >
          {showDiff ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Eye className="w-3 h-3" />
          <span>查看 Diff</span>
        </button>
        {showDiff && (
          <div className="max-h-48 overflow-auto border-t border-gray-800 bg-gray-950">
            <DiffViewer diff={diff} />
          </div>
        )}
      </div>

      {/* Commit 输入区 */}
      <div className="shrink-0 px-3 py-2 border-t border-gray-700">
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="提交消息..."
          rows={2}
          className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500 resize-none"
        />
        <button
          onClick={handleCommit}
          disabled={!commitMsg.trim() || stagedFiles.length === 0 || committing}
          className="mt-1.5 w-full flex items-center justify-center gap-1 py-1 rounded text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium"
        >
          <GitCommit className="w-3.5 h-3.5" />
          {committing ? "提交中..." : "提交"}
        </button>
      </div>
    </div>
  )
}
```

#### D. 解释 + 反例

- **三段式 early-return（无工作区 / 非 Git 仓库 / 正常）** 让主渲染体保持单一结构，可读性远好于在主 JSX 中 `{cond && (...)}` 满天飞。
- **`f.working_dir === "?"` 判定为新文件**（用绿色 + "U"）—— 与 VSCode 的视觉语义一致。
- **`getDiff` 仅在展开时拉取**，避免每次刷新都跑一次潜在很大的 diff。
- **`select.value = status?.current ?? ""`**：受控组件值必须始终为字符串；`null` 会触发 React 警告。
- **反例**：把 `select` 写成「把所有 branches 当成 button list」—— 分支多时占用大量纵向空间挤压文件列表。
- **反例**：`handleCommit` 不放 `try/finally` —— commit 抛错时按钮永远卡在「提交中...」。

#### E. 立刻验证

按 §2 冒烟流程跑通分支切换 + 暂存 + 提交。

### 5.14 编写 SettingsDialog

#### A. 动机

之前的设置入口散落在状态栏 / Sidebar 里，没有集中的「全局设置」对话框。Day 7 把它独立出来，由 Activity Bar 底部的齿轮触发。

#### B. 操作

新建 `src/components/settings/SettingsDialog.tsx`。受控表单，Esc 关闭，遮罩点击关闭。

#### C. 完整代码

```tsx
// src/components/settings/SettingsDialog.tsx
import { useState, useEffect, useCallback } from "react"
import { X, Eye, EyeOff, Settings } from "lucide-react"

interface Props {
  isOpen: boolean
  onClose: () => void
}

interface SettingsForm {
  apiKey: string
  baseURL: string
  model: string
}

export default function SettingsDialog({ isOpen, onClose }: Props) {
  const [form, setForm] = useState<SettingsForm>({ apiKey: "", baseURL: "", model: "" })
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)

  // 打开时加载当前配置
  const loadSettings = useCallback(async () => {
    try {
      const cfg = await window.api.getChatSettings()
      if (cfg) setForm(cfg)
    } catch {
      // 无配置时保持空白
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      loadSettings()
      setShowApiKey(false)
    }
  }, [isOpen, loadSettings])

  // Escape 关闭
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
      await window.api.updateChatSettings(form)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const update = (key: keyof SettingsForm, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
            <Settings className="w-4 h-4 text-amber-400" />
            <span>设置</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 表单 */}
        <div className="px-4 py-4 flex flex-col gap-4">
          {/* API Key */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? "text" : "password"}
                value={form.apiKey}
                onChange={(e) => update("apiKey", e.target.value)}
                placeholder="sk-..."
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 pr-9 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Base URL */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Base URL</label>
            <input
              type="text"
              value={form.baseURL}
              onChange={(e) => update("baseURL", e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
            />
            <p className="mt-1 text-xs text-gray-600">留空则使用默认 OpenAI 端点。</p>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">模型</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="gpt-4o"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-gray-400 hover:bg-gray-700">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

#### D. 解释 + 反例

- **`onClick={(e) => if (e.target === e.currentTarget) onClose()}`**：点击遮罩关闭，但点击对话框内部不关闭。判断 `target === currentTarget` 是经典写法，避免事件冒泡误关。
- **`isOpen ? loadSettings()` 在打开时加载** 而不是组件挂载时一次：这样下次打开能拿到最新配置（用户可能从外部更改过）。
- **API Key `type="password"` + 显隐切换**：基本的隐私防护，避免共享屏幕时一览无余。
- **反例**：直接 `onClick={onClose}` 在外层 div 上 —— 点对话框任何位置都会关。
- **反例**：把 `useEffect(keydown)` 放在 `if (!isOpen) return null` 之前的第一个 effect 也 OK，但**`if (!isOpen) return null` 必须在 hook 之后**，否则 hook 顺序在不同渲染里不一致，React 报错。

#### E. 立刻验证

打开后按 Esc / 点遮罩 / 点 X 三种方式都应能关闭。

### 5.15 改造 Sidebar 为 Activity Bar 结构

#### A. 动机

承载 GitPanel 与 SettingsDialog 入口，并为后续多面板留出扩展空间。

#### B. 操作

改写 `src/components/layout/Sidebar.tsx`：左侧 40px 图标列 + 右侧面板内容。图标点击切换 `activeSidebarPanel`；底部齿轮触发 SettingsDialog。

#### C. 完整代码

```tsx
// src/components/layout/Sidebar.tsx
import { useState } from "react"
import { FolderTree, GitBranch, Settings, X } from "lucide-react"
import { useEditorStore } from "../../stores/editor.store"
import FileExplorer from "../file-explorer/FileExplorer"
import GitPanel from "../git/GitPanel"
import SettingsDialog from "../settings/SettingsDialog"

export default function Sidebar() {
  const { activeSidebarPanel, setActiveSidebarPanel, setSidebarOpen } = useEditorStore()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const navItems = [
    { id: "files" as const, icon: <FolderTree className="w-5 h-5" />, title: "文件资源管理器" },
    { id: "git" as const, icon: <GitBranch className="w-5 h-5" />, title: "源代码管理" },
  ]

  return (
    <>
      <div className="h-full flex flex-row bg-gray-900 border-r border-gray-700">
        {/* Activity Bar */}
        <div className="w-10 flex flex-col items-center py-2 gap-1 border-r border-gray-700 bg-gray-950">
          {navItems.map((item) => {
            const active = activeSidebarPanel === item.id
            return (
              <button
                key={item.id}
                title={item.title}
                onClick={() => setActiveSidebarPanel(item.id)}
                className={[
                  "w-8 h-8 flex items-center justify-center rounded",
                  "hover:bg-gray-700 transition-colors",
                  active
                    ? "text-white border-l-2 border-amber-500 pl-px"
                    : "text-gray-500 hover:text-gray-300",
                ].join(" ")}
              >
                {item.icon}
              </button>
            )
          })}

          {/* Settings 放到底部 */}
          <div className="flex-1" />
          <button
            title="设置"
            onClick={() => setSettingsOpen(true)}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-700 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>

        {/* 面板内容区 */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700 shrink-0">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide select-none">
              {activeSidebarPanel === "files" ? "资源管理器" : "源代码管理"}
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-0.5 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 面板主体 */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeSidebarPanel === "files" ? <FileExplorer /> : <GitPanel />}
          </div>
        </div>
      </div>

      {/* Settings 模态框 */}
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}
```

#### D. 解释 + 反例

- **`flex-1` 占位** 把 Settings 按钮挤到底部，是 flex 列布局的标准技巧。
- **`overflow-hidden` + `min-w-0`** 在 flex 子项里很关键 —— 否则当 GitPanel 内部出现长文件名时，整个 Sidebar 会被撑开把编辑区压缩。
- **激活态用左 2px 高亮 + 文字白色**：模仿 VSCode；保留 `pl-px` 抵消 border 对内容偏移。
- **反例**：把 SettingsDialog 渲染在某个面板组件内部 —— 切走面板时模态框被卸载，体验割裂；放在 Sidebar 顶层用 fragment 兄弟节点最稳。

#### E. 立刻验证

点击 GitBranch 图标，右侧面板切换；底部齿轮弹出对话框；按 X 折叠侧边栏。

### 5.16 StatusBar 显示当前 Git 分支

#### A. 动机

把当前所在分支放到状态栏，让用户始终能看到「我在哪个分支上工作」。

#### B. 操作

修改 `src/components/layout/StatusBar.tsx`：从 `useGitStore` 读取 `status.current`，与文件名一起渲染。

#### C. 完整代码

```tsx
// src/components/layout/StatusBar.tsx
import { useMemo } from 'react'
import { useEditorStore } from '../../stores/editor.store'
import { useGitStore } from '../../stores/git.store'

export default function StatusBar() {
  const { openFilePath } = useEditorStore()
  const status = useGitStore((s) => s.status)

  const fileLabel = useMemo(() => {
    if (!openFilePath) return 'No file opened'
    const parts = openFilePath.split(/[/\\]/)
    return `Opened: ${parts[parts.length - 1]}`
  }, [openFilePath])

  return (
    // Day 7 状态栏：高级工具 + Git 集成 + 设置面板
    <div className="h-6 bg-amber-600 text-white text-xs flex items-center px-4 shrink-0 transition-colors">
      <span className="font-semibold">Day 7 Advanced Tools + Git</span>
      <span className="mx-4 opacity-50">|</span>
      {status?.current && (
        <>
          <span className="opacity-80">⎇ {status.current}</span>
          <span className="mx-4 opacity-50">|</span>
        </>
      )}
      <span>{fileLabel}</span>
    </div>
  )
}
```

#### D. 解释 + 反例

- **只在 `status?.current` 存在时渲染分支段** —— 非 Git 仓库或还没刷新时，状态栏不出现「⎇ undefined」尴尬字样。
- **`useGitStore((s) => s.status)` 选择器订阅**：StatusBar 只关心 status 字段变化，不关心 branches/log，避免不必要的重渲染。
- **反例**：`const { status } = useGitStore()` 解构 —— 整个 store 任何字段变化都触发 StatusBar 重渲染，性能损失。

#### E. 立刻验证

切换分支后状态栏文字应同步变化。

## 6. 端到端走查

以「让 Agent 修改一个文件并提交」为例：

1. 用户在 ChatInput 说：「把 README.md 第一行改成 # Hello」。
2. ChatPanel → useChatStore.sendMessage → preload `sendChatMessage` → IPC `chat:send-message`。
3. main 进程 ChatService 委托 AgentLoop。AgentLoop 第 1 轮：模型 stream 出 `read_file` 工具调用。
4. ToolRegistry 路由到 readFileTool，返回 README.md 内容；onToolCallResult 推回前端，对话流出现工具块「completed」。
5. AgentLoop 第 2 轮：模型基于读到的内容生成 `edit_file` 调用，args `{ path: 'README.md', old_string: '# Day 7', new_string: '# Hello' }`。
6. editFileTool 走完三关（路径校验通过 / 文件存在 / old_string 唯一）→ 写入新内容 → 返回「文件 README.md 修改成功。替换了 1 行 → 1 行（+0 行）。」
7. AgentLoop 第 3 轮：模型不再产生 tool_calls，直接以 finish_reason="stop" 结束。
8. 用户切到 GitPanel，点刷新 → useGitStore.refreshStatus → IPC `git:status` → simple-git → README.md 出现在「未暂存的更改」。
9. 用户「全部暂存」→ `git:add` → README.md 移入「已暂存」；写「Update title」→ 提交按钮触发 `git:commit`。
10. commit 完成后 `refreshStatus` 再跑一次，列表清空；StatusBar 上的 `⎇ main` 仍然在。

## 7. 完整运行流程追踪

冷启动 → Agent 调 run_command 跑 `git status` → 用户在 GitPanel 暂存并提交：

```
[main]   electron 主进程启动
[main]   registerIpcHandlers() 串行注册：terminal/file-system/chat/git
[main]     ↳ git.ipc.ts: removeHandler×7 → handle×7 注册成功
[main]   BrowserWindow 创建，loadURL(dev server)
[render] App 初始化 → file-tree.store.refreshTree → workspaceRoot 已知
[render] Sidebar 渲染：Activity Bar 默认 'files' → FileExplorer 显示
[user]   点击 Activity Bar 的 GitBranch 图标
[render] setActiveSidebarPanel('git') → 重渲染 → GitPanel 挂载
[render] GitPanel useEffect → loadAll() → refreshStatus + refreshBranches 并发
[render]   ↳ window.api.gitStatus(repoPath) → ipcRenderer.invoke('git:status')
[main]    git.ipc.ts handler → GitService.status() → simpleGit(repoPath).status()
[main]    返回 StatusResult → 映射 GitStatus → resolve
[render] set({ status, loading: false }) → 文件列表渲染
[user]   在底部聊天问：「跑一下 git status 给我看」
[render] sendChatMessage → IPC chat:send-message
[main]   AgentLoop 第 1 轮 → onThinking → onToken("我来执行...")
[main]   stream finish_reason='tool_calls'：name='run_command' args={command:'git status'}
[main]   ToolRegistry → runCommandTool.execute
[main]     ↳ cwd = workspacePath（无 args.cwd）
[main]     ↳ execSync('git status', { shell: powershell.exe, timeout: 30000 })
[main]   返回 stdout 截断后 → 推 chat:tool-result 到前端
[render] ToolCallBlock 状态切换 running → completed，显示输出
[main]   AgentLoop 第 2 轮 → 模型基于结果生成总结回答 → onToken 流式
[main]   finish_reason='stop' → onComplete → setIsThinking(false)
[user]   切到 GitPanel 点刷新 → 列表更新 → 全部暂存 → 输入 "Test" → 提交
[main]   git:add → simpleGit.add(files)
[main]   git:commit → simpleGit.commit('Test') → 返回 commit hash
[render] 再次 refreshStatus → 列表清空
[render] StatusBar 'status?.current' 不变 → "⎇ main" 持续显示
```

## 9. 自测清单

- [ ] `pnpm install` 成功安装 `simple-git`，启动 `pnpm dev` 控制台无 IPC handler 重注册警告。
- [ ] DevTools 中 `window.api.gitStatus('.')` 能拿到 `GitStatus`（或在非 Git 目录下 reject）。
- [ ] GitPanel 在非 Git 目录显示「当前目录不是 Git 仓库」占位。
- [ ] GitPanel 能列出未暂存文件、用绿色标识 untracked、用黄色标识 modified。
- [ ] 「全部暂存」按钮可把所有未暂存文件移入「已暂存」。
- [ ] 写 commit 消息 + 点提交后，列表清空，commit 实际写入 git log。
- [ ] 分支选择器列出所有本地分支，切换后 `git branch --show-current` 同步变化。
- [ ] 「查看 Diff」展开后 DiffViewer 正确高亮 +/-/@@/文件头。
- [ ] Agent 让其调用 `edit_file` 修改文件：唯一匹配成功；模型给出错误的 old_string 时返回「未找到」错误并能自我修正重试。
- [ ] Agent 让其调用 `run_command` 跑 `node -v`：返回版本号；跑一个故意失败的命令时返回 stderr + 退出码。
- [ ] `run_command` 的 `cwd` 参数尝试穿越（如 `..`）会被拒绝。
- [ ] 点击 Activity Bar 底部齿轮弹出 SettingsDialog；按 Esc / 点遮罩 / 点 X 都能关闭；保存后刷新仍生效。
- [ ] StatusBar 在打开 Git 仓库时显示「⎇ <分支名>」段，非 Git 仓库时不显示。

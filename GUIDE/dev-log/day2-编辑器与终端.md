# Day 2：接入 Monaco 编辑器、Xterm 终端与第一条 IPC

## 0. 前言

Day 1 我们搭好了 Electron + React + TypeScript 三层骨架，但编辑器与终端区还只是占位文字。Day 2 要把它们换成真实可交互的模块：编辑区跑起 VS Code 同款的 Monaco 编辑器，终端区跑起 xterm.js，并打通**第一条** renderer ↔ main 的 IPC 通道——`window.api.runCommand(cmd)` 把命令送到主进程 `child_process.exec` 执行后回传输出。本日不会再写「占位」，所以 §4 基础知识铺垫仍按规范要求完整撰写（这是规范允许的最后一日「Day 1/2 必写」，从 Day 3 起 §4 仅讲新概念）。本日不引入大模型 / Agent 概念，依然属于「IDE 工程层」。

---

## 1. 本日目标与产出

### 1.1 功能目标

1. 编辑区显示一个可输入、可滚动、带 TypeScript 语法高亮的 Monaco 编辑器（默认装入一段示例代码）。
2. 终端区呈现 xterm.js 终端：有提示符 `PS > `、支持输入回显、退格、Ctrl+C 中断；按回车后命令通过 IPC 在主进程执行并把 stdout / stderr 写回终端。
3. Day 1 的所有交互（侧栏折叠、面板拖动、StatusBar）保持工作正常，没有任何回归。

### 1.2 工程目标

1. 引入 4 个新依赖：`@monaco-editor/react`、`@xterm/xterm`、`@xterm/addon-fit`、（无 `node-pty`，本日故意避开原生模块构建以降低门槛）。
2. 在 `electron/main.ts` 注册第一个 `ipcMain.handle` 通道；在 `electron/preload.ts` 通过 `contextBridge` 暴露第一个业务 API；并用 `window.api.runCommand` 的形式让 renderer 调用它。
3. 通过 `vite-env.d.ts` 的全局接口扩展，让 renderer 端 `window.api.runCommand` 拥有完整 TypeScript 类型推断——不出现 `any`。
4. 终端组件正确处理 React 18+ 严格模式下 `useEffect` 双调用导致的重复挂载问题（dispose 干净）。

---

## 2. 先跑起来（Smoke Run）

```powershell
Set-Location .\GUIDE\day2
npm install
npm run dev
```

预期窗口现象（替代 Day 1 的占位文字）：

1. 上 70% 的编辑区显示 Monaco 编辑器，加载着一段 4 行的 TypeScript `greet` 函数；行号、当前行高亮、滚动条都正常。
2. 下 30% 的终端区顶部仍是 `TERMINAL` 标签，下方是 xterm 终端，第一行写着 `Day 2 Terminal Ready`，第二行是 `PS > ` 等待输入。
3. 在终端输入 `node -v` 然后回车，几十毫秒后能看到 Node 版本号被打印出来，再次出现 `PS > ` 提示符。
4. 输入 `xxxxx`（非命令）回车，`stderr` 通道返回的「不是内部或外部命令」会被写入终端。
5. 输入到一半按 Ctrl+C，行尾出现 `^C`，缓冲被丢弃，回到提示符。

如果你直接在终端输入 `node -v`、`whoami`、`dir` 都能正常运行，§1 的全部目标即达成。

---

## 3. 项目结构与变更总览

### 3.1 项目目录树（ASCII）

```text
day2/
├─ .vscode/
│  └─ settings.json
├─ electron/
│  ├─ main.ts                            # 修改：注册 terminal:run-command IPC handler
│  └─ preload.ts                         # 修改：暴露 window.api.runCommand
├─ src/
│  ├─ components/
│  │  ├─ editor/
│  │  │  └─ MonacoWrapper.tsx            # 新增：包裹 @monaco-editor/react
│  │  ├─ terminal/
│  │  │  └─ TerminalInstance.tsx         # 新增：xterm 实例、行缓冲、IPC 调用
│  │  └─ layout/
│  │     ├─ AppLayout.tsx                # 修改：占位区域换成真实组件
│  │     ├─ Sidebar.tsx                  # 不变
│  │     └─ StatusBar.tsx                # 修改：文案更新
│  ├─ stores/
│  │  └─ editor.store.ts                 # 不变
│  ├─ App.tsx                            # 不变
│  ├─ main.tsx                           # 不变
│  ├─ main.css                           # 不变
│  ├─ index.html                         # 不变
│  └─ vite-env.d.ts                      # 修改：声明 window.api 全局类型
├─ electron.vite.config.ts               # 不变
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json  # 不变
└─ package.json                          # 修改：新增 4 个依赖
```

本日**完全不修改** `tsconfig*.json` 与 `electron.vite.config.ts`——Day 1 的配置已经足够支撑 Day 2 的新文件。

### 3.2 构建 / 运行链路图

下图聚焦 Day 2 新出现的运行时回路（终端命令往返）。Day 1 的"启动到首屏"链路依然成立，本图叠加在它之上：

```text
[ 用户在 xterm 输入 node -v\r ]
            │
            ▼
TerminalInstance.tsx :: terminal.onData(data)
   └─ buffer 收集字符；遇到 '\r' 表示回车
            │ command = "node -v"
            ▼
window.api.runCommand("node -v")     ← preload 注入到 renderer 的方法
            │ ipcRenderer.invoke("terminal:run-command", "node -v")
            ▼  IPC 通过 Electron 内部 socket 跨进程
ipcMain.handle("terminal:run-command", handler)   electron/main.ts
            │
            ▼
util.promisify(child_process.exec)("node -v", { cwd: process.cwd(), maxBuffer: 1MB })
            │ Node 调用 OS API 启动子进程；子进程 stdout/stderr 被捕获
            ▼
{ stdout: "v22.x.x\n", stderr: "", code: 0 }
            │ 通过 IPC 返回值穿回 renderer
            ▼
TerminalInstance.tsx :: result 处理
   ├─ terminal.writeln(stdout)
   ├─ terminal.writeln(stderr)（若非空）
   └─ terminal.write(PROMPT)
            ▼
[ xterm 渲染输出，光标停在新提示符后 ]
```

### 3.3 编码步骤索引（依赖顺序）

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `package.json` | 修改 | 增加 4 个 dependencies |
| 2 | `electron/main.ts` | 修改 | 注册 terminal:run-command |
| 3 | `electron/preload.ts` | 修改 | 通过 contextBridge 暴露 runCommand |
| 4 | `src/vite-env.d.ts` | 修改 | 声明 window.api 类型 |
| 5 | `src/components/editor/MonacoWrapper.tsx` | 新增 | Monaco 包裹组件 |
| 6 | `src/components/terminal/TerminalInstance.tsx` | 新增 | xterm 终端组件 |
| 7 | `src/components/layout/AppLayout.tsx` | 修改 | 把占位换成真实组件 |
| 8 | `src/components/layout/StatusBar.tsx` | 修改 | 文案 |

依赖顺序原则：先底层（依赖、IPC、preload、类型声明），再叶子组件（Monaco、Terminal），最后组合层（AppLayout、StatusBar）。

---

## 4. 基础知识铺垫

按 LOG-SPEC §3.4bis，Day 2 仍需把当日新概念全部铺垫，让读者进 §5 时不必再查外部资料。

### 4.1 Electron IPC：`handle / invoke` 与 `send / on` 的区别

Electron 提供两套渲染↔主进程通信 API。我们本日使用的是较新的 **请求-响应式**：

| 方向 | 主进程 API | 渲染进程 API | 适用场景 |
|---|---|---|---|
| 渲染 → 主 → 渲染（请求-响应） | `ipcMain.handle(channel, async fn)` | `ipcRenderer.invoke(channel, ...args)` | 「我需要一个返回值」，等价 RPC |
| 主 → 渲染（推送） | `webContents.send(channel, ...args)` | `ipcRenderer.on(channel, fn)` | 「主进程主动通知」（如流式 token） |
| 渲染 → 主（无返回） | `ipcMain.on(channel, fn)` | `ipcRenderer.send(channel, ...args)` | fire-and-forget |

- `invoke(...)` 返回 `Promise<T>`，可直接 `await`。
- `handle` 的回调可以是 `async`，返回值被序列化（结构化克隆）穿回 renderer——不能传函数 / DOM 节点 / Symbol。
- `handle(channel, ...)` 在同一 channel **只能注册一次**——重复注册会抛 `Attempted to register a second handler for 'xxx'`。所以本项目从 Day 2 开始就把所有 `ipcMain.handle` 集中在主进程入口或专门的 ipc 模块里。

最小示例（与本日代码同构）：

```ts
// 主进程
ipcMain.handle('add', async (_event, a: number, b: number) => a + b)

// preload
contextBridge.exposeInMainWorld('api', {
  add: (a: number, b: number) => ipcRenderer.invoke('add', a, b)
})

// renderer
const sum: number = await window.api.add(1, 2) // 3
```

### 4.2 `child_process.exec` 与 `util.promisify`

Node 自带的 `child_process` 模块暴露多个启动子进程的方法：

- `exec(cmd, options, cb)`：通过 shell 执行整条命令字符串（Windows 上是 `cmd.exe /c <cmd>`，类 Unix 上是 `/bin/sh -c <cmd>`）。stdout / stderr 被一次性 buffer 起来到回调里。**本日选它的理由**：单次命令、不需要交互、实现最简——足以演示 IPC 闭环。
- `spawn(file, args, options)`：低级 API，不走 shell，需要把可执行文件与参数分开传，stdout / stderr 是流。**未来 Day** 当我们要做真终端（持续会话、保留环境变量）时会换成 `spawn` 或 `node-pty`。
- `execFile(file, args)`：跳过 shell 直接运行可执行文件，比 `exec` 安全（不会被 shell 注入）。

`exec` 的回调式签名不利于 `async/await`；Node 提供 `util.promisify(exec)` 把它转成 `Promise` 形式：

```ts
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const { stdout, stderr } = await execAsync('node -v')
```

异常情况：当退出码非 0 时，`execAsync` 会 **抛出** 一个错误对象，错误对象上同时挂着 `stdout / stderr / code`——所以本日 IPC handler 用 try/catch 把错误"扁平化"成 `{ stdout, stderr, code }` 返回值，让 renderer 不必区分成功失败两个分支。

> **安全提示**：`exec` 拼接命令字符串、走 shell，如果命令来自不可信输入（比如 LLM 自动生成的），可以被注入 `&& rm -rf ...`。本日命令来源是用户自己手敲，OK；从 Day 5 工具调用开始，所有 LLM 产生的命令都必须改成 `execFile` / `spawn` 并走白名单。

### 4.3 Monaco Editor 与 `@monaco-editor/react`

Monaco 是 VS Code 用的同一份编辑器内核，由微软维护，体积约 2 MB。它的核心抽象是「Model / Editor / Provider」三件套：

- **Model**：一段被编辑的文本 + 撤销栈 + 语言绑定，可独立于 UI 存在。一个文件对应一个 Model。
- **Editor**：把 Model 渲染到 DOM 的视图实例；同一 Model 可以被多个 Editor 共享（比如分屏）。
- **Provider**：完成「补全、悬浮、格式化」等智能行为的注册函数。

直接用 `monaco-editor` npm 包需要自己处理 4 个 web worker（TS / CSS / HTML / JSON 的 IntelliSense 在 worker 里跑），配置颇繁琐。社区维护的 `@monaco-editor/react` 封装做了三件事：

1. 通过 CDN（默认 jsDelivr）按需加载 Monaco 主体与 worker 文件，不需要项目里手动配 `MonacoEnvironment.getWorkerUrl`。
2. 提供 `<Editor />` React 组件，自动管理 Editor 与 Model 的生命周期。
3. 暴露 `useMonaco()` hook 让你在挂载后拿到 Monaco 命名空间对象，注册自定义 Provider。

最小用法（和本日 §5.5 几乎一致）：

```tsx
import Editor from '@monaco-editor/react'

<Editor height="100%" defaultLanguage="typescript" defaultValue="// hello" theme="vs-dark" />
```

`automaticLayout: true` 选项让 Monaco 内部用 `ResizeObserver` 监听容器尺寸变化自动重排——配合 `react-resizable-panels` 拖动面板时不会出现"编辑器宽度不更新"的现象。

### 4.4 xterm.js：终端模拟器与「伪终端协议」

xterm.js 是把终端**渲染**到浏览器的库——它**不**自带"启动 shell 子进程"的能力。它的职责是：

1. 接收原始字节流（包含可见字符、控制字符、ANSI 转义序列），转换成颜色化、布局化的字符网格。
2. 接收用户键盘输入，触发 `onData(callback)` 回调，把用户敲的字符（包括 `\r`、`\u0003` 等控制字节）传出去。

「真实终端」需要把 `onData` 拿到的字节送到一个 PTY（伪终端，pseudo-terminal）子进程里，再把子进程 stdout 通过 `terminal.write(data)` 喂回 xterm。本日我们**简化**：不做 PTY，而是「**按行模式**」自己在 renderer 里做：

- 一个 `commandBufferRef`（React ref，不触发重渲染）保存正在输入的行。
- `\r`（用户回车）→ 把 buffer 当作完整命令送 IPC 执行 → 收到结果后 `writeln` 出来。
- `\u007f`（退格）→ buffer 末尾砍一个字符 + 屏幕上 `\b \b`（回退、写空格、再回退）擦掉光标位置。
- `\u0003`（Ctrl+C）→ 丢弃 buffer + 屏幕显示 `^C`。
- 其他可见字符（`>= ' '`）→ 追加到 buffer + `terminal.write(data)` 回显。

addon-fit 是 xterm.js 官方插件，提供 `fitAddon.fit()` 把终端按容器实际宽高自动 resize 到合适的行 / 列数。我们在 mount 时调用一次、`window` resize 时再调用一次。

### 4.5 React 严格模式下的 `useEffect` 双调用

我们在 `main.tsx` 用 `<StrictMode>` 包裹整棵树。在开发模式（生产模式不生效），React 会**故意**让组件第一次挂载时立刻执行 mount → unmount → mount 三次——这是为了暴露"effect 没写 cleanup 函数"或"cleanup 不幂等"导致的 bug。

对 xterm 这种"创建一个真实 DOM 实例"的副作用而言，这意味着：

- 如果 `useEffect` 里 `new Terminal(...)` 但忘了在 cleanup 里 `terminal.dispose()`，第二次挂载时 DOM 容器里会出现两个 xterm，光标错位、事件双触发。
- 必须把 `terminal.dispose()`、`onDataDisposable.dispose()`、`window.removeEventListener('resize', ...)` 全部放进 cleanup。

本日 §5.6 的 TerminalInstance 严格遵守了这条。

### 4.6 TypeScript 全局类型扩展（`declare global` + `Window` 接口合并）

我们在 preload 里通过 `contextBridge.exposeInMainWorld('api', ...)` 把 `window.api` 挂出来——这是运行时行为，TypeScript **看不到**。如果 renderer 里写 `await window.api.runCommand(...)`，TS 默认会报 `Property 'api' does not exist on type 'Window & typeof globalThis'`。

解决办法是在 `vite-env.d.ts`（任意一个被 `tsconfig.web.json` 的 include 覆盖到的 `.d.ts` 文件均可）里写：

```ts
interface RendererApi {
  runCommand: (command: string) => Promise<TerminalCommandResult>
}

declare global {
  interface Window {
    api: RendererApi
  }
}
```

`declare global` 进入全局类型空间；`interface Window` 用 TypeScript 的「**接口合并**」机制把我们声明的字段并入全局 `Window` 接口（标准库已有 `interface Window`）。完成后 IDE 里输入 `window.api.` 就能跳出 `runCommand` 自动补全，参数 / 返回值类型完全显式。

文件中还顺带定义 `interface TerminalCommandResult { stdout, stderr, code }`——把"主进程返回的结构"用类型固化，preload 与 renderer 双方共享同一个形状契约。

---

## 5. 编码步骤

### 5.1 步骤 1：在 `package.json` 增加依赖

#### A. 动机

四个新模块（`@monaco-editor/react`、`@xterm/xterm`、`@xterm/addon-fit`）必须在写第一行业务代码前完成 `npm install`，否则 IDE 立刻报「Cannot find module」。本日仍**不引入** `node-pty`：node-pty 需要本机 Python + C++ 编译工具链，对教学环境是高门槛；我们用 `child_process.exec` 「按命令分轮」模拟，在 Day 2 这一步够用。

#### B. 你将要做的操作

复制 Day 1 的 `package.json` 作为起点，把 `name / description` 改成 Day 2 的字样，并在 `dependencies` 里追加 3 个 xterm/monaco 模块。

#### C. 完整代码

*文件 `package.json`：*

```json
{
  "name": "my-agent-ide-day2",
  "version": "1.0.0",
  "description": "Day 2: Monaco Editor + Xterm Terminal + IPC",
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

- `@monaco-editor/react ^4.7.0`：提供 `<Editor />` React 组件，内部通过 `loader.config({ paths })` 决定从哪儿加载 Monaco 主体。默认 CDN 是 jsDelivr。
- `@xterm/xterm ^5.5.0`：xterm.js 5.x 的 npm 主包名（旧版叫 `xterm`，5.5 起重命名到 `@xterm/` scope），导出 `Terminal` 类与 CSS。
- `@xterm/addon-fit ^0.10.0`：autosize 插件。`Terminal` 实例 `.loadAddon(new FitAddon())`，再调用 `fitAddon.fit()` 即可让终端按容器尺寸自适应行 / 列。
- 这三个库都放在 `dependencies` 而不是 `devDependencies`，因为它们在最终用户机器上（生产构建后）也得运行——renderer bundle 里会直接引用它们。
- `node-pty` **故意不加**。当我们以后 Day 7+ 需要"持续 shell session" 时再加。把"是否引入原生模块"作为单独的工程决定，不要捆绑在"接终端"这一步。

> **反例对比**：如果一上来就加 `node-pty: ^1.0.0`，`npm install` 会触发 node-gyp → 找 Python → 找 C++ 编译器，Windows 下还要 Visual Studio Build Tools。一个 Day 2 教学环境就得花半小时装环境，且容易在某些 Node 版本上失败。**渐进式引入原生依赖**是 Electron 教学项目的常见做法。

#### E. 立刻验证

```powershell
Set-Location .\GUIDE\day2
npm install
```

完成后 `node_modules/@monaco-editor/react/`、`node_modules/@xterm/xterm/`、`node_modules/@xterm/addon-fit/` 三个目录都应存在。

---

### 5.2 步骤 2：修改 `electron/main.ts` 注册 IPC handler

#### A. 动机

第一条业务 IPC 落在主进程：渲染进程把命令字符串送过来，主进程在 Node 环境里调用 `child_process.exec` 跑出来。**为什么必须先写主进程而不是 preload？** 因为如果 preload 里 `ipcRenderer.invoke('terminal:run-command', ...)` 被调用、但主进程没注册对应 `ipcMain.handle`，Electron 会抛 `No handler registered for 'terminal:run-command'`——必须先建好"接收端"再去搭"发送端"。

#### B. 你将要做的操作

打开 Day 1 复制过来的 `electron/main.ts`，在 import 头追加 `ipcMain`、`exec`、`promisify` 三个符号，并在 `app.whenReady().then(...)` 块内 `createWindow()` 之前注册新的 `ipcMain.handle('terminal:run-command', ...)`。

#### C. 完整代码

*文件 `electron/main.ts`：*

```ts
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

function createWindow(): void {
  // 创建主窗口：Day 1 只负责搭建可运行骨架，不注入业务逻辑。
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // preload 负责桥接安全 API（渲染进程不能直接拿到 Node 高权限能力）。
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 等待页面资源准备好再显示窗口，避免用户看到白屏闪烁。
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 阻止新窗口在应用内打开，统一交给系统浏览器处理外链。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发环境走 Vite dev server，生产环境加载打包后的 html。
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Day 1 默认打开开发者工具，便于教学阶段观察运行状态。
  if (is.dev) {
    mainWindow.webContents.openDevTools()
  }
}

app.whenReady().then(() => {
  // Windows 平台任务栏与通知等系统行为依赖该 AppUserModelId。
  electronApp.setAppUserModelId('com.electron')

  // 注册开发期快捷键行为（例如 F12 / Ctrl+R）以贴合本地调试习惯。
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Day 2: 提供最小可用终端命令执行能力，供渲染进程通过 IPC 调用。
  ipcMain.handle('terminal:run-command', async (_event, command: string) => {
    if (!command || !command.trim()) {
      return { stdout: '', stderr: '命令为空。', code: 1 }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.cwd(),
        windowsHide: true,
        maxBuffer: 1024 * 1024
      })

      return { stdout, stderr, code: 0 }
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message?: string; code?: number }

      return {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message ?? '命令执行失败。',
        code: execError.code ?? 1
      }
    }
  })

  createWindow()

  app.on('activate', function () {
    // macOS 上关闭所有窗口后，点击 Dock 图标通常会重新创建窗口。
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 遵循 macOS 约定：仅非 darwin 平台在关窗后直接退出进程。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

#### D. 这段代码做了什么

- `import { ... ipcMain ... } from 'electron'`：从 Electron 拉入 `ipcMain` 单例。`ipcMain` 与 `ipcRenderer` 是同一条逻辑通道的两个端口，通过 channel 字符串配对。
- `import { exec } from 'child_process'` + `import { promisify } from 'util'`：Node 标准库，前者是回调式 API，后者把它升格成 Promise 形式。
- `const execAsync = promisify(exec)`：模块顶层只 promisify 一次，后面所有 `await execAsync(...)` 都复用这同一个函数实例。
- `ipcMain.handle('terminal:run-command', async (_event, command: string) => { ... })`：注册 channel `terminal:run-command` 的处理器。callback 第一个参数是 `IpcMainInvokeEvent`（本日没用，所以前缀 `_` 表示故意忽略），第二个开始才是 renderer 通过 `invoke(channel, ...args)` 传过来的参数。
- 注意位置：handler **写在 `app.whenReady().then(...)` 内部** 而不是模块顶层。如果写在顶层，Electron 还没 ready 时就尝试访问内部 IPC bus，行为未定义；惯例都是放在 ready 之后。
- 第一段 `if (!command || !command.trim())` 是基本健壮性：renderer 不应该送空命令，但万一送了，给它个明确的错误信息而不是抛异常。
- `execAsync(command, { cwd, windowsHide, maxBuffer })`：
  - `cwd: process.cwd()`：在 Electron 启动时的工作目录里执行——Day 2 这就是 `GUIDE/day2/`。Day 7 我们会替换成「项目根目录」。
  - `windowsHide: true`：Windows 上不弹出 cmd 黑窗口（exec 默认会闪一下）。
  - `maxBuffer: 1024 * 1024`（1 MiB）：stdout / stderr 的内存上限。超过会抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，被外面的 try/catch 捕到。Day 2 只跑短命令所以 1 MB 足够。
- `try / catch` 把"命令成功"与"命令失败"两条路径**都返回正常 JSON**，不让 promise reject——这样 renderer 端不需要写 try/catch，只看 `result.code` 就能判断成败。
- 错误对象的类型断言 `error as { stdout?, stderr?, message?, code? }`：因为 promisify 后的 `exec` 抛出的错误在 Node 类型定义里是 `Error & { stdout?, stderr?, code? }`，但严格 TS 下还是要显式断言一下；`??` 兜底空值。
- 注册顺序：`ipcMain.handle(...)` 写在 `createWindow()` **之前**。理由：如果窗口先建好，renderer 立刻执行 preload 与渲染脚本，可能在 handler 注册前就已经触发首次 invoke——正常情况下 renderer 启动到第一次 invoke 之间会经过几十毫秒的 React 挂载时间，但养成「先注册 handler 再开窗」的纪律最稳妥。

> **反例对比**：如果用 `ipcMain.on('terminal:run-command', (event, command) => { ... event.reply(...) })` + renderer 端 `ipcRenderer.send + ipcRenderer.on`，要走两条 channel 才能完成一次往返，且要自己处理"哪条 reply 对应哪次请求"的关联——`handle/invoke` 是 Electron 7 新增的 RPC 风格 API，专门解决这种麻烦，新项目应优先使用。

#### E. 立刻验证

本步骤无法独立验证（renderer 还没在调用它）。但可以做一次 sanity check：保存后运行 `npm run dev`，主进程终端不应有任何关于 IPC 的报错。如果想立刻测，DevTools Console 可以输入：

```js
await electron.ipcRenderer.invoke('terminal:run-command', 'node -v')
```

应该返回 `{ stdout: 'v22.x.x\n', stderr: '', code: 0 }`。这一步走的是 Day 1 已经挂载的 `window.electron`（toolkit 的安全 API），不依赖步骤 3。

---

### 5.3 步骤 3：修改 `electron/preload.ts` 暴露 `runCommand`

#### A. 动机

Day 1 的 preload 里 `const api = {}` 是空对象，等待今天填进第一个方法。我们把 `runCommand` 挂到 `window.api` 而不是直接让 renderer 用 `window.electron.ipcRenderer.invoke('terminal:run-command', ...)`，是为了：

1. **API 收敛**：renderer 业务代码不需要知道 channel 字符串，避免拼写错误（`terminal:run-command` vs `terminal:runCommand`）。
2. **类型友好**：`runCommand(command: string)` 一目了然，配合步骤 4 的全局类型扩展，IDE 给出完整签名。
3. **未来重命名 / 迁移成本低**：哪天 channel 改名，只改 preload 一处，所有 renderer 调用方零改动。

#### B. 你将要做的操作

打开 `electron/preload.ts`，在 `import` 行追加 `ipcRenderer`，并把 `const api = {}` 改成包含 `runCommand` 的对象。

#### C. 完整代码

*文件 `electron/preload.ts`：*

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Day 2: 暴露最小终端能力，后续会逐步扩展文件与搜索等工具。
const api = {
  runCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command)
}

if (process.contextIsolated) {
  try {
    // 将 toolkit 提供的安全 API 显式挂载到 window.electron。
    contextBridge.exposeInMainWorld('electron', electronAPI)
    // 将业务 API 挂载到 window.api，后续通过 IPC 能力逐步填充。
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // 仅在关闭 contextIsolation 的兜底场景下直接赋值，正常项目不建议依赖该分支。
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
```

#### D. 这段代码做了什么

- `import { ... ipcRenderer } from 'electron'`：preload 是少数能直接 `import 'electron'` 的位置（renderer 在 contextIsolation 下不能）。
- `runCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command)`：箭头函数即时创建一个调用，把 channel 字符串硬编码在这里。
  - `ipcRenderer.invoke` 返回 `Promise<unknown>`（Electron 类型上是 unknown，因为它无法预测 handler 的返回类型）。我们靠步骤 4 的全局接口给它套上具体类型 `Promise<TerminalCommandResult>`。
- 整个 if / else 结构与 Day 1 完全一致——只是 `api` 对象的内容从 `{}` 变成了 `{ runCommand }`。`contextBridge.exposeInMainWorld('api', api)` 这一行**不需要改**：它把整个对象搬过隔离边界一次性挂到 `window.api` 上，对象内的字段无论多少都自动跟过去。
- 暴露后，renderer 端通过 `window.api.runCommand(...)` 触发的整条调用链是：renderer → exposed 函数 → `ipcRenderer.invoke` → 主进程 IPC bus → `ipcMain.handle` 回调 → 返回值经 IPC bus 序列化回 renderer → `invoke` Promise resolve。

> **反例对比**：如果直接 `contextBridge.exposeInMainWorld('runCommand', (cmd) => ipcRenderer.invoke('terminal:run-command', cmd))`，那 renderer 端要写 `window.runCommand(...)`，全局命名空间被业务 API 污染，下次再加 `readFile` 又得占一个顶级名。统一挂在 `window.api` 下作命名空间是社区惯例。

#### E. 立刻验证

`npm run dev` 后在 DevTools Console：

```js
await window.api.runCommand('node -v')
```

应当返回 `{ stdout, stderr, code: 0 }`。如果报 `window.api is undefined`，检查 preload 路径是否正确（参见 Day 1 的 §5.7）；如果报 `window.api.runCommand is not a function`，说明 `api` 对象写错了。

---

### 5.4 步骤 4：修改 `src/vite-env.d.ts` 声明全局类型

#### A. 动机

虽然步骤 3 已经让 `window.api.runCommand` 在运行时可用，但 TypeScript **不知道** `window.api` 存在——renderer 里写 `window.api.runCommand(...)` 会立刻被 TS 报红。我们需要用「全局类型扩展」告诉 TS：「`window` 上有 `api`，`api` 上有 `runCommand`，参数和返回值是这样的形状」。这一步的产出物就是 IDE 里完美的自动补全 + 编译期类型保护。

#### B. 你将要做的操作

打开 `src/vite-env.d.ts`，在 Day 1 的两行下面追加 `TerminalCommandResult`、`RendererApi` 接口与 `declare global { interface Window }` 块。

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

interface RendererApi {
	runCommand: (command: string) => Promise<TerminalCommandResult>
}

declare global {
	interface Window {
		api: RendererApi
	}
}
```

#### D. 这段代码做了什么

- `interface TerminalCommandResult`：把主进程 handler 的返回结构「形状化」。三个字段必填——`stdout` 即使空也是空字符串而非 `undefined`，匹配 §5.2 handler 的实现。
- `interface RendererApi`：把 preload 里 `const api = { runCommand }` 对象的 TypeScript 形状描述出来。后续 Day 3 加 `readFile` 时，只在这个接口里多加一行即可。
- `declare global { interface Window { api: RendererApi } }`：
  - **`declare global`** 是 TypeScript 在 `.d.ts` 或带 `import / export` 的 `.ts` 文件里"穿透到全局类型作用域"的关键字。`vite-env.d.ts` 因为含 `///` 三斜线指令，它在 TypeScript 看来是"非模块文件"，里面顶层声明本来就是全局；但配合 `declare global` 块写法在任何文件都能工作，习惯用统一形式。
  - **`interface Window`** 是 TypeScript 内置 lib（`lib.dom.d.ts`）已声明过的接口。同名 `interface` 会触发 **接口合并（declaration merging）**——TS 把我们声明的字段并入它已有的字段集合里，于是全局 `Window` 类型上既有 `document / location / ...`，也有 `api`。
- TypeScript 严格模式（我们 `tsconfig.web.json` 开了 `strict: true`）下，没有这段声明，`window.api.runCommand(...)` 会立刻被 `Object is of type 'unknown'` 或 `Property 'api' does not exist` 拒绝。
- 这个文件**没有 `export` / `import`**，是个全局脚本风格的 `.d.ts`——内部 `declare global` 与裸 `interface` 都进入全局类型空间。如果以后写成 `export {}` 让它变成模块，那"裸 `interface`"就只在本模块可见，必须把它们挪进 `declare global` 块里。

> **反例对比**：很多人遇到 `Property 'api' does not exist on type 'Window'` 的第一反应是写 `(window as any).api.runCommand(...)`——能编译通过但**永远失去**类型保护，下次 `runCommand` 改名 / 改签名，调用方不会被 TS 抓住。`declare global + interface Window` 是一次性投入、长期收益的标准方案。

#### E. 立刻验证

保存文件后回到任何 `.tsx`，输入 `window.api.` 应该弹出 `runCommand` 自动补全；点击参数提示能看到 `(command: string) => Promise<TerminalCommandResult>`。

---

### 5.5 步骤 5：新增 `src/components/editor/MonacoWrapper.tsx`

#### A. 动机

Monaco 编辑器是「叶子组件」中最简单的一个：没有外部状态依赖、没有 props、不需要 IPC。我们先把它写完，后面 §5.7 在 AppLayout 里直接 import 即可替换 Day 1 的占位文字。`@monaco-editor/react` 的 `<Editor />` 组件已经包揽了「Monaco loader、worker URL、容器 div、自动布局」全部脏活，我们只要给它合理的 props。

#### B. 你将要做的操作

新建目录 `src/components/editor/`，在其中新建 `MonacoWrapper.tsx`。

#### C. 完整代码

*文件 `src/components/editor/MonacoWrapper.tsx`：*

```tsx
import Editor from '@monaco-editor/react'

const INITIAL_CODE = `function greet(name: string): string {
  return \`Hello, ${name}!\`
}

console.log(greet('Day2'))
`

export default function MonacoWrapper() {
  return (
    <Editor
      height="100%"
      defaultLanguage="typescript"
      defaultValue={INITIAL_CODE}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        wordWrap: 'on',
        scrollBeyondLastLine: false
      }}
    />
  )
}
```

#### D. 这段代码做了什么

- `import Editor from '@monaco-editor/react'`：包的默认导出是已封装好生命周期的 React 组件，第一次渲染时会异步从 CDN 拉 Monaco 主体，加载期间显示一个 loading 占位（也可以通过 `loading` prop 自定义）。
- `INITIAL_CODE` 用模板字符串多行书写。注意里面 `\`Hello, ${name}!\`` 的反引号需要转义——因为外层模板字符串本身用反引号包裹，里层的反引号必须 `\``。同理 `${name}` 不需要转义，因为它在外层的 `${}` 里也是合法占位（但这里我们**故意**让外层不展开 `name`，直接让它原样作为字符串字面量被 Monaco 显示），所以 `\${name}` 写不写转义都行——本日没有转义、依赖外层无 `name` 变量，会原样保留。
- `<Editor />` 的关键 props：
  - `height="100%"`：让编辑器撑满父容器高度。父容器（AppLayout 里的 `<div className="h-full ...">`）必须有具体高度，否则会塌成 0。
  - `defaultLanguage="typescript"`：决定语法高亮 + IntelliSense 的语言模式。
  - `defaultValue={INITIAL_CODE}`：仅首次挂载时使用。如果以后改成受控（`value=...`），改值会通过 Monaco 的 model.setValue 同步到编辑器。
  - `theme="vs-dark"`：与 IDE 暗色 UI 一致。
- `options`：直接透传给 `monaco.editor.create` 的配置对象。
  - `minimap.enabled: false`：关掉右侧缩略图，省屏幕空间。
  - `fontSize: 14`：偏大字号，DPI 高的屏幕看着舒服。
  - **`automaticLayout: true`**：核心配置。Monaco 内部用 `ResizeObserver` 监听 DOM 容器尺寸变化自动重排——不然当用户拖动 `react-resizable-panels` 改变面板大小时，Monaco 会保持初始尺寸出现"右侧空白条 / 文字被裁"的现象。
  - `wordWrap: 'on'`：超长行折行显示。
  - `scrollBeyondLastLine: false`：滚动到底部后不允许继续滚出文档末尾下方的"假空白"，避免观感怪异。
- 组件不接收 props、不读 store——下次 Day 3 接入文件树后，会改成 `function MonacoWrapper({ filePath, content, onChange })` 受控形态。

> **反例对比**：如果不设置 `automaticLayout: true`，且**也不**自己监听 resize 事件主动调用 `editor.layout()`，那么用户拖动面板时 Monaco 不知道容器变了，会出现"内容显示不全 / 光标点击位置错位"的诡异 bug——是接 Monaco 时最常见的踩坑。`automaticLayout` 的代价是 Monaco 启用一个 100 ms 间隔的 ResizeObserver 轮询，CPU 占用极小，几乎都该开。

#### E. 立刻验证

本步骤无法独立验证（还没在 AppLayout 里挂上）。

---

### 5.6 步骤 6：新增 `src/components/terminal/TerminalInstance.tsx`

#### A. 动机

终端组件是 Day 2 最复杂的一个文件。它要：① 挂载时创建 xterm `Terminal` 实例并绑定到 DOM；② 实现一个最小的 "行编辑器"（缓冲、退格、Ctrl+C、回车）；③ 回车时通过 `window.api.runCommand` 把命令送到主进程；④ 把结果写回 xterm；⑤ 卸载时干净 dispose 所有资源（避免 React StrictMode 双调用泄漏）。

#### B. 你将要做的操作

新建目录 `src/components/terminal/`，在其中新建 `TerminalInstance.tsx`。

#### C. 完整代码

*文件 `src/components/terminal/TerminalInstance.tsx`：*

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const PROMPT = 'PS > '

export default function TerminalInstance() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const commandBufferRef = useRef('')

  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      convertEol: true,
      theme: {
        background: '#252526',
        foreground: '#cccccc'
      }
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    terminal.writeln('Day 2 Terminal Ready')
    terminal.write(PROMPT)

    const runCommand = async (command: string) => {
      const result = await window.api.runCommand(command)

      if (result.stdout) {
        terminal.writeln(result.stdout.replace(/\r?\n/g, '\r\n'))
      }

      if (result.stderr) {
        terminal.writeln(result.stderr.replace(/\r?\n/g, '\r\n'))
      }

      terminal.write(PROMPT)
    }

    const onDataDisposable = terminal.onData(async (data) => {
      if (data === '\r') {
        const command = commandBufferRef.current.trim()
        terminal.write('\r\n')

        if (command.length > 0) {
          await runCommand(command)
        } else {
          terminal.write(PROMPT)
        }

        commandBufferRef.current = ''
        return
      }

      if (data === '\u0003') {
        commandBufferRef.current = ''
        terminal.write('^C\r\n')
        terminal.write(PROMPT)
        return
      }

      if (data === '\u007f') {
        if (commandBufferRef.current.length > 0) {
          commandBufferRef.current = commandBufferRef.current.slice(0, -1)
          terminal.write('\b \b')
        }
        return
      }

      if (data >= ' ') {
        commandBufferRef.current += data
        terminal.write(data)
      }
    })

    const onResize = () => {
      fitAddon.fit()
    }

    window.addEventListener('resize', onResize)

    return () => {
      onDataDisposable.dispose()
      window.removeEventListener('resize', onResize)
      terminal.dispose()
    }
  }, [])

  return <div ref={containerRef} className="h-full w-full" />
}
```

#### D. 这段代码做了什么

- `import 'xterm/css/xterm.css'`：xterm 自带的样式表，**必须 import**，否则字符网格、光标、滚动条都没样式。Vite 看到 `import 'xxx.css'` 会自动注入到 `<head>`。
- 四个 `useRef`：
  - `containerRef`：指向真实 DOM 节点（return 的那个 `<div>`），xterm 需要它来 `.open(container)` 把字符网格挂上去。
  - `terminalRef / fitAddonRef`：保留 `Terminal` 与 `FitAddon` 实例的引用——本日没有用到（cleanup 直接走闭包变量），但留作未来扩展（比如外部按钮"清屏"调用 `terminal.clear()` 时会从 ref 读取实例）。
  - `commandBufferRef`：当前正在编辑的行内容。**用 ref 而不是 state 是关键**——state 改变会触发 React 重渲染，导致 `useEffect` cleanup → re-init，xterm 实例被销毁重建，所有历史输出消失。ref 的 `.current` 修改不触发渲染。
- `useEffect(() => { ... }, [])`：空依赖数组，只在挂载执行一次（StrictMode 下开发模式会执行 mount→unmount→mount 三次，但 cleanup 写对就不会泄漏）。
- 进入 effect 后第一行 `if (!containerRef.current) return`：理论上 effect 跑时 ref 一定已绑定，但这条守卫是 React 严格模式下的廉价保险。
- `new Terminal({ ... })`：创建 xterm 实例。
  - `cursorBlink: true`：光标闪烁，让用户知道焦点。
  - `convertEol: true`：自动把单独的 `\n` 转成 `\r\n`——因为 xterm 内部光标移动严格按真实终端协议，单 `\n` 只换行不回车，会出现"阶梯文字"。我们的 `runCommand` 里**仍然**手动 `replace(/\r?\n/g, '\r\n')` 是双重保险（exec 在 Windows 上有时会输出纯 `\n`）。
  - `theme`：背景与 Day 1 暗色色板一致；前景灰白与 `--color-foreground` 同色。
- `terminal.loadAddon(fitAddon)` + `terminal.open(container)` + `fitAddon.fit()`：xterm 标准三连——挂插件、绑容器、按容器尺寸 resize 行/列。**顺序重要**：`fit()` 必须在 `open()` 之后，因为它要读真实容器宽高。
- `terminal.writeln('Day 2 Terminal Ready')`：内部相当于 `write('Day 2 Terminal Ready\r\n')`。`writeln` 适合一行完整文本；`write` 适合不带换行的提示符。
- `runCommand`：把"调用 IPC + 写回结果"封装成本地异步函数。结果里 stdout/stderr 都做了 `\n → \r\n` 替换；之后 `terminal.write(PROMPT)` 重新打提示符。
- `terminal.onData(callback)`：xterm 的核心输入回调。返回一个 `IDisposable`（带 `.dispose()` 方法），cleanup 时调用以移除监听。回调 `data` 是用户键入产生的"原始字节字符串"——不是 keydown 事件，而是经过 xterm 内部处理后的"终端协议字节"。
- 四个分支按真实终端协议：
  - `'\r'`（用户按回车）：取出 buffer 修剪、屏幕上写 `\r\n`、buffer 非空则跑命令、清 buffer。
  - `'\u0003'`（Ctrl+C，ASCII 3 = ETX）：终止当前输入，屏幕显示 `^C` + 换行 + 新提示符。
  - `'\u007f'`（退格，ASCII 127 = DEL；现代终端按 Backspace 发的就是 0x7F 而非 0x08）：buffer 砍尾，屏幕用 `\b \b`（光标左移、写空格盖掉、再左移）擦字符。
  - `data >= ' '`（任何空格 ASCII 32 及以上的可见字符）：追加到 buffer + 屏幕回显。这条排除了上面三个分支没明确处理的所有控制字符（Tab、方向键 ESC 序列等）——本日终端是"行编辑器"，故意不支持光标移动，简单可靠。
- `onResize` + `window.addEventListener('resize', onResize)`：Electron 窗口尺寸变化时，让 fitAddon 重新计算行 / 列。注意没有监听 `react-resizable-panels` 的拖动——本日宽度变化主要靠手动拉窗口边；面板内拖动一般会触发 window resize 事件吗？不一定。**这是 Day 2 的已知简化**，未来 Day 7 接 GitPanel 时会引入 `ResizeObserver` 直接监听容器。
- `return () => { ... }`：cleanup 三件套——`onDataDisposable.dispose()` 解绑输入回调、`removeEventListener` 解绑 resize、`terminal.dispose()` 摧毁 xterm 实例。在 StrictMode 下 React 会立刻执行一次 cleanup → 再 init，三件齐全才不会泄漏。
- `<div ref={containerRef} className="h-full w-full" />`：什么都没有的容器 div。`h-full w-full` 让它继承父容器尺寸；xterm 在 `terminal.open()` 时会往里面注入 `.xterm` 样式的子节点。

> **反例对比 1**：如果把 `commandBufferRef` 换成 `useState('')`：每按一个键调用 `setBuffer(prev + data)` → 触发组件重渲染 → `useEffect([])` 依赖未变所以不会重跑（OK）……但 `terminal.onData` 回调里通过闭包捕获的 `commandBuffer`（state 值）永远是首次渲染时的空字符串——因为 effect 只跑一次，回调闭包绑定的就是首帧的 state。这是 React + 长生命周期外部对象（xterm、Monaco）最常见的"陈旧闭包"陷阱，**ref 是标准解法**。

> **反例对比 2**：如果省略 `terminal.dispose()`，StrictMode 下 mount → unmount → mount 后，第一个 Terminal 实例还在监听 `containerRef` 那个 DOM 节点，第二个 Terminal 实例又往同一节点注入字符网格——你会看到**两套提示符**叠在一起，每按一个键回显两次。dispose 不可省。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.7 步骤 7：修改 `src/components/layout/AppLayout.tsx` 接入真实组件

#### A. 动机

把 Day 1 的两段占位文字（编辑区 / 终端区的 "Will Be Here"）替换成 `<MonacoWrapper />` 与 `<TerminalInstance />`。布局结构不变——上 70% / 下 30%、可拖动分隔仍然成立。

#### B. 你将要做的操作

打开 `src/components/layout/AppLayout.tsx`，加两行 import；把占位 `<p className="text-gray-500 italic">Day 1: ... Will Be Here</p>` 换成对应组件；终端那一节里把内层 `<div className="flex-1 flex items-center justify-center">` 改成 `<div className="flex-1 overflow-hidden">` 后塞进 `<TerminalInstance />`。

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

export default function AppLayout() {
  // 从全局状态读取侧边栏开关。
  const { isSidebarOpen } = useEditorStore()

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* 主内容区：活动栏 + 侧边栏 + 主工作区 */}
      <div className="flex-1 flex overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* 活动栏：Day 1 仅展示图标，不绑定实际功能。 */}
          <div className="w-12 shrink-0 bg-surface border-r border-border flex flex-col items-center py-2 gap-4">
            <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
              <FileCode size={24} />
            </button>
            <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
              <MessageSquare size={24} />
            </button>
          </div>

          {/* 可折叠侧边栏：通过 Zustand 状态控制是否渲染。 */}
          {isSidebarOpen && (
            <>
              <Panel defaultSize={20} minSize={15} maxSize={30}>
                <Sidebar />
              </Panel>
              <PanelResizeHandle className="w-1 bg-border hover:bg-blue-500 transition-colors" />
            </>
          )}

          {/* 主工作区：上方 Monaco 编辑器 + 下方 Xterm 终端。 */}
          <Panel defaultSize={80}>
            <PanelGroup direction="vertical">
              {/* Day 2: 接入 Monaco 编辑器。 */}
              <Panel defaultSize={70}>
                <div className="h-full bg-background border-b border-border">
                  <MonacoWrapper />
                </div>
              </Panel>

              <PanelResizeHandle className="h-1 bg-border hover:bg-blue-500 transition-colors" />

              {/* Day 2: 接入 Xterm 终端。 */}
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
        </PanelGroup>
      </div>

      {/* 状态栏固定在底部。 */}
      <StatusBar />
    </div>
  )
}
```

#### D. 这段代码做了什么

- 顶部新增两行 import：从 `'../editor/MonacoWrapper'` 与 `'../terminal/TerminalInstance'` 拉入两个新组件。
- 编辑区 Panel 内部从 `<p>...Will Be Here</p>` 换成 `<MonacoWrapper />`。外层 `<div className="h-full bg-background border-b border-border">` 保留——MonacoWrapper 内部 `<Editor height="100%" />` 需要父容器有具体高度。
- 终端区结构调整：原来内部是 `flex flex-col` 带"标题栏 + 居中占位"，现在改为 `flex flex-col` 带"标题栏 + `<div className="flex-1 overflow-hidden"><TerminalInstance /></div>`"。
  - `flex-1`：占满除标题栏（h-8）以外的所有高度。
  - `overflow-hidden`：xterm 内部会自己渲染滚动条，外层不再允许溢出。
- 没有任何 store 改动——`useEditorStore` 用法保持不变；侧栏折叠 / 拖动 / 活动栏图标全部保持 Day 1 行为。
- 关键：MonacoWrapper 与 TerminalInstance **没有 props**，所以这里调用极简。第一次接入 Monaco 总忍不住想"传 fileContent 进去"——本日故意推迟到 Day 3，避免在编辑器接入这一步混入"文件系统"概念。**单步只引入一个新维度**是教程式日志的关键纪律。

> **反例对比**：如果把终端外层包成 `<div className="flex-1 flex items-center justify-center">`（保留 Day 1 用于居中占位文字的 flex），TerminalInstance 内部的 `<div className="h-full w-full">` 会因为父容器是 `flex items-center` 而**塌陷**——flex 子项默认 `align-items: stretch` 是被居中策略覆盖的，宽高变成内容尺寸（0）。改成 `flex-1 overflow-hidden` 让父容器正常块级、子容器拉满才正确。

#### E. 立刻验证

`npm run dev`。如果之前还没启动，这次会触发完整重新编译。窗口里：上半应当是 Monaco；下半应当是 xterm（带 Day 2 Terminal Ready 字样）。如果上半空白：检查 MonacoWrapper 与 import 路径；如果下半空白：检查 TerminalInstance 的 cleanup 是否完整、`xterm.css` 是否被 import。

---

### 5.8 步骤 8：更新 `src/components/layout/StatusBar.tsx`

#### A. 动机

StatusBar 文字标识"我们处于哪一天"，便于在不同 day 的快照之间切换运行时一眼区分。本步骤只是改文案——技术上无新内容，但作为"每日的一个小仪式"也列入步骤。

#### B. 你将要做的操作

打开 `src/components/layout/StatusBar.tsx`，把两段 `<span>` 文本改成 Day 2 字样。

#### C. 完整代码

*文件 `src/components/layout/StatusBar.tsx`：*

```tsx
export default function StatusBar() {
  return (
    // Day 2 状态栏用于展示当前阶段和接入能力。
    <div className="h-6 bg-blue-600 text-white text-xs flex items-center px-4 shrink-0 transition-colors">
      <span className="font-semibold">Day 2 Monaco + Xterm</span>
      <span className="mx-4 opacity-50">|</span>
      <span>Editor & Terminal Integrated</span>
    </div>
  )
}
```

#### D. 这段代码做了什么

- 与 Day 1 唯一区别是两行 `<span>` 内的文字，DOM 结构、Tailwind 类、注释行均保持同步。
- 无 props、无 state，仍是 100% 纯展示组件。

> **反例对比**：可以把"当前 day"做成 store 字段（`useEditorStore` 加一个 `currentDay`），让 StatusBar 自动读——但 Day N 之间是"不同代码快照"而不是"同一份代码的运行时切换"，做成 store 反而把"运行时变量"与"项目身份"耦合。硬编码字符串是更简单清晰的表达。

#### E. 立刻验证

窗口底部蓝条应显示 "Day 2 Monaco + Xterm | Editor & Terminal Integrated"。

---

## 6. 端到端串联走查

以「在终端输入 `node -v` 回车」这一条具体操作为例，跨 8 个跳转点追一次：

| 跳转 | 文件 / 位置 | 关键代码 |
|---|---|---|
| ① 用户键盘事件 | xterm 内部 | xterm 把 keydown 事件按 VT100 协议转换成字符序列 `'n','o','d','e',' ','-','v','\r'` |
| ② onData 回调 | `TerminalInstance.tsx` :: `terminal.onData(async (data) => ...)` | 7 个可见字符走 `if (data >= ' ')` 分支：buffer 追加、屏幕回显；最后 `'\r'` 触发回车分支 |
| ③ 行处理 | `TerminalInstance.tsx` 同回调 | `commandBufferRef.current.trim()` 拿到 `"node -v"`；`terminal.write('\r\n')` 换行 |
| ④ IPC 调用 | `TerminalInstance.tsx` :: `runCommand("node -v")` → `window.api.runCommand(...)` | 跳到 preload 暴露的箭头函数 |
| ⑤ preload 桥接 | `electron/preload.ts` :: `runCommand: (cmd) => ipcRenderer.invoke('terminal:run-command', cmd)` | `invoke` 通过 Electron 内部 socket 序列化参数跨进程 |
| ⑥ 主进程执行 | `electron/main.ts` :: `ipcMain.handle('terminal:run-command', async (_e, command) => ...)` | `execAsync(command, { cwd, windowsHide, maxBuffer })` 调 OS API 启动 `node -v` 子进程 |
| ⑦ 结果回穿 | 同 main.ts | 子进程 stdout `"v22.x.x\n"` 收到、main 把 `{ stdout, stderr, code: 0 }` return；Electron IPC 把对象结构化克隆送回 renderer |
| ⑧ 写回 xterm | `TerminalInstance.tsx` :: `runCommand` 后续 | `terminal.writeln(stdout.replace(/\r?\n/g, '\r\n'))` 然后 `terminal.write(PROMPT)` |

整条链路涉及 **2 个进程、4 个文件、1 条 IPC channel**——与 Day 7+ 的 Git / FileSystem / Search 全部走完全一致的形状（仅 channel 名与 handler 内容不同）。掌握 Day 2 这条最小往返就掌握了未来所有"工具调用"的骨架。

---

## 7. 完整运行流程追踪

`npm run dev` 之后，机器内部按时间顺序发生的事（Day 2 在 Day 1 链路上叠加，仅列出**新增 / 改变**的环节）：

1. **配置解析阶段**：electron-vite 读 `electron.vite.config.ts`，三端入口与 Day 1 完全一致；renderer plugins 仍是 `react()` + `tailwindcss()`。`@monaco-editor/react`、`@xterm/xterm` 是普通 npm 包，没有 Vite 插件。
2. **TS 双端编译**：
   - 主进程：`electron/main.ts` 因增加了 `child_process` / `util` import，被 esbuild 转成 CJS 放进 `out/main/index.js`。`externalizeDepsPlugin()` 让 Node 内置模块自动 external。
   - preload：`electron/preload.ts` 编译为 `out/preload/index.js`，新增的 `ipcRenderer.invoke` 调用被原样保留（Electron 在 preload 上下文注入它）。
   - renderer：`src/components/editor/MonacoWrapper.tsx` 触发 `@monaco-editor/react` 被 Vite 收入 dep optimize；`src/components/terminal/TerminalInstance.tsx` 触发 `@xterm/xterm`、`@xterm/addon-fit` 同样被预构建。预构建产物缓存在 `node_modules/.vite/`。
3. **主进程冷启动**：与 Day 1 相同直到 `app.whenReady().then(...)`。新增的 `ipcMain.handle('terminal:run-command', ...)` 在 `createWindow()` **之前**注册——保证窗口建好时 handler 已就绪。
4. **preload 加载**：与 Day 1 相同，`window.electron` + `window.api` 都挂上去。区别是 `window.api.runCommand` 现在是真实可调用的函数（Day 1 是 `{}`）。
5. **renderer 启动**：React 18+ StrictMode → `<App />` → `<AppLayout />`。AppLayout 内：
   - 首次 commit 阶段挂载 `<MonacoWrapper />`：`@monaco-editor/react` 内部 `loader.init()` **异步**从 `cdn.jsdelivr.net` 拉 Monaco 主体（约 2 MB）+ 4 个 worker 文件。这个加载是非阻塞的，期间 `<Editor>` 显示一个简短的"Loading"占位。
   - 同步挂载 `<TerminalInstance />`：`useEffect` 里 `new Terminal(...)`、`fit()`、写第一行欢迎 + 提示符；StrictMode 在开发模式下立刻触发一次 cleanup（`terminal.dispose()`）然后再次 init——所以**首次屏幕上短暂出现两次 ReadyPrompt 也属正常**，看到的最终就是第二次 init 的产物。
6. **首次 IPC 往返**：用户在终端敲 `node -v\r` 后约 30~80 ms 收到响应。这条往返是 Day 2 引入的"第一条业务回路"。耗时分布：
   - xterm 输入处理 < 1 ms
   - IPC 序列化 + 跨进程跳转 < 5 ms
   - `child_process.exec` 启动 Node 进程 ≈ 20~50 ms（Windows 上启动一个 Node 进程的固定开销）
   - 子进程执行 `node -v` < 5 ms
   - 结果回穿 < 5 ms
7. **`react-resizable-panels` 拖动重排**：用户拖动编辑区与终端区之间的横线，PanelGroup 内部 setState 改变两个 Panel 的尺寸 → CSS flex-basis 变化 → DOM 容器高度变 → Monaco 的 `automaticLayout` 通过 ResizeObserver 监听到 → 调用 `editor.layout()` 重排；xterm 的 `fitAddon.fit()` **不会自动触发**（我们只监听了 `window.resize`），所以 xterm 在拖动后行 / 列数不变但内容仍能滚动——已知简化。

---

## 8. 必学知识点深化

### 8.1 Monaco 在 Electron 里的"懒加载 vs 预打包"

`@monaco-editor/react` 默认 CDN 加载是为 web 项目设计的，Electron 应用断网或离线场景下 Monaco 永远 loading。**生产可选优化**：通过 `loader.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } })` 让它从本地 node_modules 加载。本日教学版采用默认 CDN，省掉打包配置；Day 8 的设计系统升级时会一并切换为本地路径。

### 8.2 xterm 的"伪终端协议简介"

xterm 实现的是 **xterm + VT100 + ANSI** 协议子集。终端的"光标移动 / 颜色 / 清屏 / 标题栏"全部是 ASCII 控制字符 + ESC 序列：

| 序列 | 含义 |
|---|---|
| `\r` (0x0D) | 回到行首 |
| `\n` (0x0A) | 下移一行（不回行首） |
| `\b` (0x08) | 光标左移一格 |
| `\u001b[2J` | 清屏 |
| `\u001b[31m...\u001b[0m` | 红色文字 |
| `\u001b]0;Title\u0007` | 设置窗口标题 |

未来 Day 4 流式输出 LLM 文本时，如果 LLM 返回 `\u001b[1m**...**\u001b[0m`（粗体提示），xterm 会"原生"渲染加粗。理解这点能帮助调试"xterm 输出乱码"——通常是某个流没做协议转换。

### 8.3 `ipcMain.handle` 的生命周期

`ipcMain.handle(channel, fn)` 注册的处理器**与窗口无关**——它绑定在 main 进程上，多个 `BrowserWindow` 共享。Day 2 我们只有一个窗口，没差别；多窗口（Day 8 文件 diff 弹窗）时所有窗口都能 invoke 同一 channel。如需按窗口区分，handler 内通过 `event.sender.id` 或 `BrowserWindow.fromWebContents(event.sender)` 取窗口实例。

### 8.4 React `useRef` vs `useState`

| 用途 | useState | useRef |
|---|---|---|
| 改变后是否触发重渲染 | ✅ 是 | ❌ 否 |
| 适合存储 | 需要在 UI 反映的值 | 不需要触发渲染的可变值（如 DOM 引用、外部库实例、临时缓冲） |
| 闭包陷阱 | 严重（旧 state 被捕获） | 不存在（永远访问 `.current` 取最新） |

Day 2 的 `commandBufferRef` 是后者最经典的用法。

---

## 9. 自测清单

- [ ] `npm install` 顺利，无 native build 报错（因为我们没引入 node-pty）。
- [ ] `npm run dev` 启动后窗口里上半显示 Monaco 编辑器，里面有 `function greet(name: string)` 示例代码（对应 § 1.1 目标 1）。
- [ ] 在 Monaco 里输入文字、滚动、按 Ctrl+Z 撤销都正常。
- [ ] 拖动上下面板分隔线，Monaco 自动重排，文字不超出（验证 `automaticLayout`）。
- [ ] 下半 xterm 显示 `Day 2 Terminal Ready` + `PS > `（对应 § 1.1 目标 2）。
- [ ] 输入 `node -v` 回车，几十毫秒内显示 Node 版本（对应 § 1.1 目标 2 + § 1.2 目标 2）。
- [ ] 输入到一半按 Backspace，能正确删除字符（光标位置正确）。
- [ ] 输入到一半按 Ctrl+C，行被丢弃，新提示符出现。
- [ ] 输入一个不存在的命令（如 `notarealcmd`），stderr 被红字打印（取决于 shell，Windows 上是黑字）。
- [ ] DevTools Console 输入 `window.api.runCommand` 自动补全签名 `(command: string) => Promise<TerminalCommandResult>`（对应 § 1.2 目标 3）。
- [ ] 点侧栏 ✕ 折叠 / 拖侧栏宽度，全部正常（验证 Day 1 无回归，对应 § 1.1 目标 3）。

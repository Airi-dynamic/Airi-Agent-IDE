# Day 1：基础设施搭建（Electron + React + TypeScript 三层骨架）

## 0. 前言

我们要做的是一个 "Agent IDE" —— 一个能让 LLM 自主理解任务、调用工具、修改代码并把结果反馈给你的桌面开发环境。后续 27 天会在它身上长出文件树、终端、对话面板、工具调用、Agent 主循环、Git、设计系统、MCP 客户端等能力。Day 1 一行业务逻辑都不写，只做一件事：**搭好后续 27 天都赖以生长的工程地基** —— Electron 主进程 / 预加载桥 / React 渲染进程的三层结构、Vite 构建管线、TypeScript 编译配置、最小可见的 IDE 骨架界面。

请把今天理解为「打钢筋混凝土」——它本身不解决任何用户问题，但它的每一根钢筋都要为后面 Day 2 接编辑器、Day 4 接 LLM、Day 6 接 Agent 主循环这些「上层装修」承重。

> **本日不引入任何 AI / Agent 相关的运行时概念**，但 § 4 会一次性把后续每一天都会反复用到的基础知识（Node 项目结构、TypeScript 语法、Electron 三进程、关键外部库、Agent 应用全景）打包讲清楚。已经熟练这些内容的读者可以直接跳过 § 4。
>
> 本日志的写作规范见 [LOG-SPEC.md](LOG-SPEC.md)。

---

## 1. 本日目标与产出

### 1.1 功能目标

1. 启动 `npm run dev` 后弹出一个桌面窗口。
2. 窗口里能看到 IDE 的骨架界面：左侧 Activity Bar 图标条 + 可拖动宽度的侧边栏 + 右上「编辑器占位」区域 + 右下「终端占位」区域 + 底部蓝色状态栏。
3. 点击侧边栏右上角的 ✕ 能折叠侧栏，状态栏始终显示「Day 1 Framework」。

### 1.2 工程目标

1. 启用 `contextIsolation` + `sandbox: false` + 独立 `preload.ts`，把 Node 高权限隔离在主进程一侧。
2. 用 `electron-vite` 一份配置驱动 main / preload / renderer 三套构建。
3. TypeScript 严格模式开启 `strict + noUnusedLocals + noUnusedParameters`，Renderer 与 Node 分别使用 `tsconfig.web.json` 与 `tsconfig.node.json`。
4. 引入 Tailwind CSS v4 的 Vite 插件，使用 CSS 变量定义最小色板，确保 Day 8 引入完整设计系统时只需扩展不需重构。
5. 用 Zustand 创建一个全局状态原子，作为后续所有 store 的样板。

---

## 2. 先跑起来（Smoke Run）

在动手之前，先把已经准备好的快照跑一遍，建立「我要做出什么」的视觉印象。

```powershell
Set-Location .\GUIDE\day1
npm install
npm run dev
```

预期现象：

1. 终端输出 `electron-vite dev` 字样，几秒后弹出窗口。
2. 窗口标题区下方依次为：
   - 左侧 48 px 宽的活动栏，显示两个 lucide 图标（文件与对话）。
   - 紧邻活动栏的侧边栏，标题 `EXPLORER`，正文位置为占位字 `Day 1: File Tree Will Be Here`。
   - 中间一道可拖动的细边框，能改变侧栏宽度。
   - 右侧上方 70 % 高度区域显示 `Day 1: Monaco Editor Will Be Here`，下方 30 % 区域显示 `Day 1: Xterm.js Will Be Here`。
   - 底部一行蓝色状态栏：`Day 1 Framework | React 19 + Electron 35 Base`。
3. 点击侧栏右上角的 ✕，侧栏整体卷起，编辑器占位区随之扩展。
4. DevTools 默认打开，Console 没有红色错误。

确认上述全部满足后，再回过头来看下面 § 5 是怎么一步步把它从空目录构造出来的。

---

## 3. 项目结构与变更总览

### 3.1 项目目录树（ASCII）

```text
GUIDE/day1/
├─ .vscode/
│  └─ settings.json              # 新增：工作区编辑器配置
├─ electron/                     # 新增：Electron 主进程 + 预加载脚本
│  ├─ main.ts                    # 新增：主进程入口
│  └─ preload.ts                 # 新增：预加载桥
├─ src/                          # 新增：渲染进程
│  ├─ index.html                 # 新增：HTML 入口
│  ├─ main.tsx                   # 新增：React 挂载入口
│  ├─ App.tsx                    # 新增：根组件
│  ├─ main.css                   # 新增：Tailwind 入口 + CSS 变量
│  ├─ vite-env.d.ts              # 新增：Vite + CSS 模块类型声明
│  ├─ stores/
│  │  └─ editor.store.ts         # 新增：Zustand 全局状态原子
│  └─ components/
│     └─ layout/
│        ├─ AppLayout.tsx        # 新增：IDE 骨架布局
│        ├─ Sidebar.tsx          # 新增：侧边栏
│        └─ StatusBar.tsx        # 新增：底部状态栏
├─ package.json                  # 新增：依赖与 dev 脚本
├─ electron.vite.config.ts       # 新增：三端构建配置
├─ tsconfig.json                 # 新增：TS 总入口
├─ tsconfig.node.json            # 新增：主进程 / preload 的 TS 配置
└─ tsconfig.web.json             # 新增：渲染进程的 TS 配置
```

由于 Day 1 是从空目录起步，所有文件都标 `# 新增`。从 Day 2 开始，已存在的文件会改标 `# 修改`。

### 3.2 构建 / 运行链路图

```text
npm run dev
  └─ package.json scripts.dev = "electron-vite dev"
       └─ electron-vite 读取 electron.vite.config.ts
            ├─ ① Vite 构建主进程：electron/main.ts → out/main/index.js（CommonJS，依赖 external）
            ├─ ② Vite 构建 preload：electron/preload.ts → out/preload/index.js
            └─ ③ 启动 renderer Vite dev server（默认端口 5173）：root = src/，入口 src/index.html
                 ↓ 三件事完成后
                 spawn Electron 子进程，注入环境变量 ELECTRON_RENDERER_URL=http://localhost:5173/
                    └─ Electron 加载 package.json 的 "main" 字段 → out/main/index.js
                         ├─ app.whenReady() → createWindow()
                         ├─ new BrowserWindow({ webPreferences.preload = ../preload/index.js, contextIsolation: true })
                         └─ mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
                              ↓ Chromium 渲染进程被创建
                              ├─ 先执行 out/preload/index.js → 通过 contextBridge 挂载 window.electron / window.api
                              └─ 再请求 http://localhost:5173/index.html
                                   ├─ <script type="module" src="./main.tsx"> 被解析
                                   ├─ Vite dev server 即时将 .tsx → ESM JS 返回
                                   ├─ src/main.tsx → import './main.css' + createRoot(...).render(<App/>)
                                   └─ <App/> → <AppLayout/> → 输出 Sidebar / 编辑器占位 / 终端占位 / StatusBar
                                        ↓ React 完成首次提交
                                        mainWindow 'ready-to-show' 触发 → mainWindow.show() → 用户看到 § 2 的画面
```

### 3.3 编码步骤索引（依赖顺序）

下面是我们今天要敲键盘的全部 17 个文件，**按「依赖在前、使用在后」的教程顺序排好**。第 N 步引用的所有符号，都来自 1..N-1 步已经创建的文件。

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `package.json` | 新增 | 声明依赖与 `dev` 脚本 |
| 2 | `tsconfig.json` | 新增 | TS 编译总入口（聚合 web + node） |
| 3 | `tsconfig.node.json` | 新增 | 主进程 / preload 的 TS 配置 |
| 4 | `tsconfig.web.json` | 新增 | 渲染进程的 TS 配置 |
| 5 | `electron.vite.config.ts` | 新增 | 三端构建配置 |
| 6 | `.vscode/settings.json` | 新增 | 工作区编辑器配置 |
| 7 | `electron/main.ts` | 新增 | 主进程，创建 BrowserWindow |
| 8 | `electron/preload.ts` | 新增 | 预加载桥，暴露空的 `window.api` |
| 9 | `src/index.html` | 新增 | 渲染进程 HTML 入口 |
| 10 | `src/main.css` | 新增 | Tailwind 入口 + CSS 变量 |
| 11 | `src/vite-env.d.ts` | 新增 | Vite + CSS 模块类型声明 |
| 12 | `src/stores/editor.store.ts` | 新增 | Zustand 全局状态原子 |
| 13 | `src/components/layout/StatusBar.tsx` | 新增 | 叶子组件，无依赖 |
| 14 | `src/components/layout/Sidebar.tsx` | 新增 | 依赖 store |
| 15 | `src/components/layout/AppLayout.tsx` | 新增 | 组合 Sidebar + StatusBar + 占位 |
| 16 | `src/App.tsx` | 新增 | 加载 AppLayout |
| 17 | `src/main.tsx` | 新增 | React 入口，挂载 App |

---

## 4. 基础知识铺垫

> 本节是为「第一次接触 Node 项目 / TypeScript / Electron / Agent 工程」的读者准备的预备知识。已经熟悉的读者可以直接跳到 § 5。本节出现的代码都是**最小演示片段**，与 Day 1 的实际源码无直接对应。

### 4.1 Node.js / npm / package.json 三件套

#### 4.1.1 Node.js 是什么

Node.js 是一个能在操作系统上**直接运行 JavaScript** 的运行时（不依赖浏览器）。它最常见的两类用途是「写后端服务」和「跑构建工具」。我们今天不写后端，但 Electron 的主进程本身就是一个 Node.js 进程，所有的构建器（Vite、esbuild、TypeScript 编译器）也都是 Node 程序——所以**理解 Node 是理解整个工程的前提**。

确认你装好了 Node：

```powershell
node --version
npm --version
```

本项目要求 Node ≥ 18。

#### 4.1.2 npm 与 node_modules

`npm`（Node Package Manager）是 Node 自带的依赖管理工具。当你执行 `npm install xxx`，它做三件事：

1. 把 `xxx` 包及其全部传递依赖下载到当前目录的 `node_modules/`。
2. 在 `package.json` 的 `dependencies` 字段记录一笔。
3. 在 `package-lock.json` 写入精确版本与下载哈希，保证别人重装时拿到完全一样的依赖树。

#### 4.1.3 package.json 关键字段

```json
{
  "name": "my-agent-ide-day1",       // 包名（仅本机用，不会发到 npm 中央仓库）
  "version": "1.0.0",                 // 版本号
  "main": "./out/main/index.js",      // 当 Electron 以打包模式启动时，会读这个字段去找入口
  "scripts": {                         // 可执行的命名命令
    "dev": "electron-vite dev"        // npm run dev 等价于在项目内执行 electron-vite dev
  },
  "dependencies": { },                // 运行时必须安装的库
  "devDependencies": { }              // 仅开发 / 构建期需要的库
}
```

### 4.2 TypeScript 入门

TypeScript 是 JavaScript 的「加了类型系统」的方言，文件后缀 `.ts` 或 `.tsx`（带 JSX 的 TS）。它在编译期做类型检查，最终被编译成普通 JS 才能跑。在 Electron + Agent 这种**多边界、多模块**的工程里，TS 能在编译期就抓住 80 % 的低级错误。

#### 4.2.1 类型注解（Type Annotation）

```ts
function add(a: number, b: number): number {
  return a + b
}
let count: number = 0
const enabled: boolean = true
```

冒号后面写类型，函数参数、返回值、变量都可以注。如果你不写，TS 会做「类型推断」——能推就推、不出错才报错。

#### 4.2.2 接口（interface）

描述「对象的形状」。

```ts
interface User {
  id: number
  name: string
  email?: string  // ? 表示可选
}
function greet(u: User) { console.log(u.name) }
```

#### 4.2.3 泛型（Generics）

「参数化类型」——让一个函数 / 类对多种类型都成立。

```ts
function first<T>(arr: T[]): T | undefined { return arr[0] }
const n: number | undefined = first([1, 2, 3])
const s: string | undefined = first(['a', 'b'])
```

我们后面会写 `create<EditorState>(...)`，意思是「创建一个内容必须符合 `EditorState` 的 store」。

#### 4.2.4 模块（ES Module）

```ts
// a.ts
export const x = 1                  // 命名导出
export default function y() {}      // 默认导出

// b.ts
import y, { x } from './a'          // 默认 + 命名混合导入
import { x as alias } from './a'    // 重命名导入
```

我们整个项目用 ES Module，不用 CommonJS。

#### 4.2.5 JSX / TSX

JSX 是「在 JS / TS 里直接写类似 HTML 的语法」，最终被编译为 React 元素创建调用。`.tsx` = `.ts` + JSX。

```tsx
const elem = <div className="foo">Hello {name}</div>
// 等价于：React.createElement('div', { className: 'foo' }, 'Hello ', name)
```

注意：HTML 的 `class` 在 JSX 里写 `className`（因为 `class` 是 JS 关键字）。

#### 4.2.6 非空断言 `!` 与可选链 `?.`

```ts
const root = document.getElementById('root')   // 类型 HTMLElement | null
const root2 = document.getElementById('root')! // 用 ! 断言「我保证它不是 null」
const len = user?.name?.length                  // user 或 name 为 null/undefined 时整体返回 undefined
```

#### 4.2.7 声明文件 `.d.ts`

只含类型、不含运行时代码的文件。用来「告诉 TS 某些导入或全局变量是合法的」。我们用 `vite-env.d.ts` 声明 `import './main.css'` 不报错。

#### 4.2.8 严格模式

`tsconfig.json` 里的 `"strict": true` 一次性打开 8 个子选项（`strictNullChecks`、`noImplicitAny` 等），强迫你写出「不依赖 `any`、不漏判 null」的代码。后面 Agent 工具的复杂度会让任何放松的检查变成调试噩梦。

### 4.3 Electron 三进程模型

Electron = Chromium（浏览器内核）+ Node.js + 原生窗口绑定，把「网页技术」打包成桌面应用。它把代码分到三种进程里：

| 进程 | 数量 | 运行环境 | 能力 | 在我们项目里 |
|---|---|---|---|---|
| 主进程 main | 1 个 | Node.js | 全部：文件、命令行、网络、原生窗口 | `electron/main.ts` |
| 预加载脚本 preload | 每个窗口 1 个 | 受控 Node + 共享 renderer 的 `window` | 受控 Node 能力 + `contextBridge` | `electron/preload.ts` |
| 渲染进程 renderer | 每个窗口 1 个 | Chromium | 浏览器 API；**不能**直接 `require('fs')` | `src/**` |

#### 4.3.1 为什么要三层

设想我们让 LLM Agent「执行 `rm -rf /`」——如果它运行在渲染层并能直接访问 Node，那就是直接灾难。Electron 通过 `contextIsolation: true` 把 renderer 的 JS 上下文与高权限上下文物理隔离；renderer **必须**通过 preload 显式暴露的方法去 IPC（进程间通信）请求主进程做事；主进程对每个请求做权限检查后才执行。这给我们留下了「加白名单、加二次确认」的工程位置。

#### 4.3.2 IPC 模型最小示例（不在 Day 1 写，但要先建立模型）

```ts
// main.ts
ipcMain.handle('fs:read', (_, p: string) => fs.readFileSync(p, 'utf8'))

// preload.ts
contextBridge.exposeInMainWorld('api', {
  readFile: (p: string) => ipcRenderer.invoke('fs:read', p)
})

// renderer
const text = await window.api.readFile('/etc/hosts')
```

Day 3 我们就开始干这件事。Day 1 只是**把上面的「插槽」占好**——`window.api = {}`。

### 4.4 当日新增外部库速览

| 库 | 是什么 / 干什么 | 本日用到的 API | 可替代品 |
|---|---|---|---|
| `electron` | 桌面应用运行时 | `app`, `BrowserWindow`, `shell`, `contextBridge` | Tauri、NW.js |
| `electron-vite` | 把 Vite 一份配置应用到 main/preload/renderer 三端的胶水 | `defineConfig`, `externalizeDepsPlugin` | webpack + 自写脚本 |
| `vite` | 现代前端构建器（dev 极快；build 用 Rollup） | 间接通过 electron-vite 使用 | webpack、Parcel |
| `@vitejs/plugin-react` | 让 Vite 支持 React 与 Fast Refresh | 在 renderer.plugins 里启用 | swc/react |
| `tailwindcss` v4 | 原子化 CSS 框架 | `@import "tailwindcss"`、`bg-blue-600` 等类名 | 手写 CSS、UnoCSS |
| `@tailwindcss/vite` | Tailwind v4 的 Vite 插件 | 在 renderer.plugins 里启用 | postcss-tailwindcss（v3 写法） |
| `react` 19 + `react-dom` | UI 库与 DOM 渲染器 | `createRoot(...).render(...)`, 函数组件, `StrictMode` | Vue、Svelte、Solid |
| `zustand` v5 | 极简全局状态管理 | `create<State>((set) => ({ ... }))` | Redux、Jotai、Recoil |
| `lucide-react` | 轻量 SVG 图标组件库 | `<FileCode />`、`<X />` 等 | heroicons、tabler-icons |
| `react-resizable-panels` | 可拖动分隔的 Panel 布局 | `<PanelGroup>`、`<Panel>`、`<PanelResizeHandle>` | 自实现 + react-split-pane |
| `clsx` | 条件拼接 className 的工具 | 本日未直接使用，先安装备用 | classnames |
| `@electron-toolkit/preload` | Electron 推荐的 preload 工具集 | `electronAPI` | 自实现封装 |
| `@electron-toolkit/utils` | 主进程惯用工具 | `is.dev`, `electronApp.setAppUserModelId`, `optimizer.watchWindowShortcuts` | 自实现封装 |

### 4.5 Agent 应用全景与 Day 1 的位置

一个完整的 Coding Agent 应用通常分四层：

```text
┌─────────────────────────────────────────────────────────┐
│  ④ 展示层（Renderer / React UI）                          │
│     聊天面板 / 工具调用日志 / 文件树 / 编辑器 / 终端      │
├─────────────────────────────────────────────────────────┤
│  ③ 执行层（Agent Loop）                                   │
│     模型决策 → 调工具 → 回灌结果 → 继续决策（多轮）        │
├─────────────────────────────────────────────────────────┤
│  ② 工具层（Tool Registry）                                │
│     read_file / write_file / search / git / run_cmd …    │
├─────────────────────────────────────────────────────────┤
│  ① 模型层（LLM Provider）                                 │
│     OpenAI / Ollama / Anthropic / 本地推理               │
└─────────────────────────────────────────────────────────┘
```

工具层和模型层都跑在主进程（高权限），渲染层跑在 Chromium（低权限），preload 是它们之间唯一合法通道。Day 1 我们做的恰好是**给上面四层的全部依赖打地基**：

| Day 1 完成项 | 给后续哪一层服务 |
|---|---|
| Electron 三进程隔离 | ② ③ 让工具与 Agent loop 在主进程安全运行 |
| preload 上的 `window.api = {}` | 所有未来 IPC 接口都挂在这里 |
| `react-resizable-panels` 划分的布局 | ④ 给 Chat / 工具日志 / 编辑器 / 终端预留位置 |
| Zustand 全局 store 样板 | 后续 chat / file-tree / git / agent 各 store 复用同样模式 |
| 严格 TS + 路径别名 | 让所有跨模块边界都被类型保护 |

> 我们**不**在 Day 1 实现 RAG。RAG（Retrieval-Augmented Generation）= 在调模型前先检索相关代码 / 文档塞进上下文。它依赖文件系统、搜索、向量数据库等，至少要等 Day 3（文件系统）和 Day 7（搜索）就位后才能引入；Day 1 留好布局位置即可。

---

## 5. 编码步骤

### 5.1 步骤 1：建立 `package.json`

#### A. 动机

任何 Node 项目的第一动作都是声明「这是一个什么样的工程」。我们需要一次性把后续所有 Day 1 用到的库列清楚（React 19、Electron 35、electron-vite、Tailwind v4、zustand、react-resizable-panels、lucide-react），并把唯一启动命令 `dev` 配好——这样一旦 `npm install` 完成，就可以一直 `npm run dev` 工作下去，不再被依赖问题打断。

#### B. 你将要做的操作

在 `GUIDE/day1/` 目录下新建文件 `package.json`，写入下面完整内容。

#### C. 完整代码

*文件 `package.json`：*

```json
{
  "name": "my-agent-ide-day1",
  "version": "1.0.0",
  "description": "Day 1: Basic Infrastructure",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev"
  },
  "dependencies": {
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

- `"name"`：包名，仅本机用，不会发到 npm 中央仓库；带 `day1` 后缀方便我们以后分天数对照。
- `"version": "1.0.0"`：起步版本号，本日志不强求语义化版本，但格式要符合 SemVer（npm 会校验）。
- `"main": "./out/main/index.js"`：当 Electron 以打包模式启动时，会读这个字段去找入口；`electron-vite` 默认把主进程产物输出到 `out/main/index.js`，两者必须一致——配置不一致会让打包后的应用启动时报「Cannot find module」。
- `"scripts.dev": "electron-vite dev"`：定义了 `npm run dev` 的实际命令；`npm` 会在 `node_modules/.bin/` 路径下找 `electron-vite` 可执行文件。
- `dependencies`：**运行时**必须打入安装包的库——`react`、`zustand`、`@electron-toolkit/*` 等；这些库在最终用户的机器上必须存在。
- `devDependencies`：**仅开发 / 构建期**用的库——TS、Vite、tailwindcss、`electron` 本体（Electron Builder 在打包时会把 Electron 二进制注入最终包，所以这里可以放在 dev）。
- 全部版本用 `^`：允许打小版本补丁，但不跨大版本升级，保证教学环境可复现。

> **反例对比**：如果把 `react` / `react-dom` 放进 `devDependencies`，本地 `npm run dev` 仍然能跑（因为 dev 也会装 dev 依赖），但一旦你 `npm install --production` 或者打包发布，react 就消失了，运行时报「Cannot find module 'react'」。规则：**最终用户的电脑上要执行的代码所依赖的库 → `dependencies`**；只在你电脑上跑的工具链 → `devDependencies`。

#### E. 立刻验证

```powershell
npm install
```

应当看到 `node_modules/` 出现，且 `package-lock.json` 被生成。

---

### 5.2 步骤 2：建立 `tsconfig.json` 总入口

#### A. 动机

TypeScript 必须知道「哪些 `.ts/.tsx` 文件要被纳入编译、采用什么编译选项」。但我们项目里有两类完全不同的代码：渲染层（浏览器环境）与主进程 + preload（Node 环境）。它们用的全局类型不同（一个有 `window`，一个有 `process`、`__dirname`），不能共用一份 lib。所以我们采用「一份总配置 + 两份子配置」的结构：根目录 `tsconfig.json` 覆盖所有路径方便 IDE 解析；具体编译选项由 `tsconfig.web.json` 和 `tsconfig.node.json` 各自承担。

#### B. 你将要做的操作

在 `GUIDE/day1/` 根目录新建 `tsconfig.json`，写入下面完整内容。

#### C. 完整代码

*文件 `tsconfig.json`：*

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowArbitraryExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "ignoreDeprecations": "6.0",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.d.ts", "electron/**/*.ts"]
}
```

#### D. 这段代码做了什么

- `"target": "ES2022"`：TS 把代码降级到 ES2022 语法。Electron 35 内嵌 Chromium 与较新 Node，足以原生支持，不需要更激进的降级。
- `"useDefineForClassFields": true`：让 class 字段使用 ES 标准定义语义而不是 TS 早期的赋值语义；React 19 与新版库都假定这个为 true。
- `"module": "ESNext"` + `"moduleResolution": "bundler"`：让 TS 把 import/export 留给打包器（Vite）解析，避免 TS 自己生成 CommonJS 输出。
- `"lib": ["ES2022", "DOM", "DOM.Iterable"]`：根级把 DOM 类型也包含，方便编辑器在 `electron/` 与 `src/` 之间跳转时不会因为缺类型而报错（真正的「分而编译」由两份子配置负责）。
- `"skipLibCheck": true`：跳过对 `node_modules/**/*.d.ts` 的类型检查，编译速度提升一个数量级；代价是无法察觉第三方库自身的类型 bug，正常项目都开。
- `"allowArbitraryExtensions": true` + `"resolveJsonModule": true`：允许 `import data from './a.json'` 这类导入。
- `"isolatedModules": true`：每个文件必须能独立编译，禁止 `const enum`、`export type` 简写等"必须看到全程序"才能转译的语法；Vite 用 esbuild 单文件转译，必须打开。
- `"noEmit": true`：TS 只做检查，不输出文件——产物全部交给 Vite。
- `"jsx": "react-jsx"`：使用 React 17+ 的新 JSX 转换，组件文件不再需要顶部 `import React from 'react'`。
- `"strict": true` + 三个 `noUnused/noFallthrough`：开启所有严格选项。后面 Agent 工具的复杂度会让任何放松的检查变成调试噩梦。
- `"ignoreDeprecations": "6.0"`：暂时静默 TS 5.7 已经废弃但 6.0 才删除的若干选项告警。
- `"paths": { "@/*": ["src/*"] }`：配合 `electron.vite.config.ts` 里的 `alias`，让我们能写 `import x from '@/components/...'`。
- `"include"`：同时纳入 `src/` 与 `electron/`，保证 IDE 在两端都有完整 IntelliSense；真正的"分而编译"由下面两份子配置完成。

> **反例对比**：如果把 `"moduleResolution"` 写成 `"node"`（TS 早期默认），TS 会用 Node 的 `require` 解析规则查模块，结果 `import x from '@/foo'` 这样的别名导入就不再被识别（Node 不认识别名）；同时 ESM `import` 后缀也得手动写 `.js`。`"bundler"` 是配合 Vite/Webpack 等打包器的官方推荐值。

#### E. 立刻验证

此刻 `tsc --noEmit` 还会报 `include` 找不到任何文件——这是预期的，等步骤 7+ 把源文件创建后才会通过。本步骤无法独立验证。

---

### 5.3 步骤 3：建立 `tsconfig.node.json`

#### A. 动机

主进程与 preload 跑在 Node 运行时里，没有 `window` / `document`，但有 `process`、`__dirname`、`Buffer`。我们需要一份独立配置告诉 TS：这部分代码的全局对象集合不一样。

#### B. 你将要做的操作

在根目录新建 `tsconfig.node.json`。

#### C. 完整代码

*文件 `tsconfig.node.json`：*

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true,
    "ignoreDeprecations": "6.0",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["electron"]
}
```

#### D. 这段代码做了什么

- `"lib": ["ES2023"]`：只引入 ES 标准库类型，**不引入 DOM**——这样我们如果在 `electron/` 下不小心写了 `document.querySelector` 会立即报类型错误，从源头杜绝在主进程里乱用浏览器 API。
- `"include": ["electron"]`：扫描范围限定在 `electron/` 目录。
- 不开 `noUnusedLocals` 是有意为之：主进程里很多回调（如 `app.on('activate', function () { ... })` 的 `_` 占位参数）不需要那么严格。

> **反例对比**：如果在 `lib` 里加上 `"DOM"`，主进程代码里写 `document.body` 也不会报错，但运行时立刻崩溃（Node 没有 `document`）。把"不该出现的全局对象"通过 `lib` 主动屏蔽掉，是 TypeScript 让多环境工程保持安全的标准手法。

#### E. 立刻验证

本步骤无法独立验证，等 `electron/main.ts` 创建后才会被实际使用。

---

### 5.4 步骤 4：建立 `tsconfig.web.json`

#### A. 动机

渲染层是浏览器环境，需要 DOM、JSX、Vite 客户端类型。同时我们要允许 `import xxx from './a.ts'`（`allowImportingTsExtensions`），方便后续 Day 在多文件之间精确导入。

#### B. 你将要做的操作

新建 `tsconfig.web.json`。

#### C. 完整代码

*文件 `tsconfig.web.json`：*

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowArbitraryExtensions": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "ignoreDeprecations": "6.0",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"]
}
```

#### D. 这段代码做了什么

- `"types": ["vite/client"]`：注入 Vite 自带的环境变量类型，让 `import.meta.env.DEV` 这类访问得到正确类型推断。
- `"allowImportingTsExtensions": true`：允许 `import './a.ts'` 写法（Vite 模块解析自然支持，TS 默认禁止）。
- `"include": ["src"]`：仅扫描渲染层。

> **反例对比**：如果省略 `"types": ["vite/client"]`，访问 `import.meta.env.DEV` 时 TS 不知道它是 `boolean`，会推断成 `any`——表面上能跑，但失去了"DEV 字段拼写错误立即被抓"的保护。把所有"环境特定的全局类型"显式声明，是 TS 工程中很重要的一层防线。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.5 步骤 5：建立 `electron.vite.config.ts`

#### A. 动机

TS 配置只解决了「代码合法性检查」，真正的「如何打包成可运行的产物」由 Vite 负责。`electron-vite` 是 Electron 官方推荐的工具，它对 main / preload / renderer 三端各自走一套构建，且开发模式下自动启动 renderer 的 dev server 并把 URL 通过环境变量 `ELECTRON_RENDERER_URL` 传给主进程。

#### B. 你将要做的操作

新建 `electron.vite.config.ts`。

#### C. 完整代码

*文件 `electron.vite.config.ts`：*

```ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
```

#### D. 这段代码做了什么

- 顶部四个 import 分别拉入：Node 的 `path.resolve`（生成绝对路径）、`electron-vite` 的配置工厂与 external 插件、`@vitejs/plugin-react`、`@tailwindcss/vite`。
- `defineConfig({ main, preload, renderer })`：electron-vite 的核心 API；三端各自是一个标准 Vite 配置对象，可独立指定 plugins/build/resolve。
- `externalizeDepsPlugin()`：主进程与 preload 都使用 Node 的 `require` 或 ES Module 直接加载 `node_modules`，不需要把第三方库 bundle 进产物。这个插件自动把 `dependencies` 里的库标为 external——产物体积小、热重载更快。
- `main.build.rollupOptions.input.index`：告诉 Vite 主进程入口是 `electron/main.ts`，产物输出到 `out/main/index.js`（默认行为，由 electron-vite 控制）。preload 同理输出到 `out/preload/index.js`。
- `renderer.root: 'src'`：renderer 的"项目根"指向 `src`，这样 `src/index.html` 是 Vite 自然识别的入口；Vite 默认在 root 目录里找 `index.html`。
- `renderer.resolve.alias.@`：路径别名，与 `tsconfig.web.json` 的 `paths` 双写——TS 用 `paths` 检查类型，Vite 用 `alias` 实际解析模块；两者必须一致才能让 IDE 提示和运行时行为同步。
- `plugins: [react(), tailwindcss()]`：渲染端启用 React Fast Refresh 与 Tailwind v4 的 Vite 集成插件。Tailwind v4 不再需要 `tailwind.config.js`，所有配置都通过 `@import "tailwindcss"` 与 CSS 变量完成。

> **反例对比**：如果不加 `externalizeDepsPlugin()`，Vite 会试图把 `electron`、`@electron-toolkit/utils` 等也 bundle 进 `out/main/index.js`，结果运行时报 `require('electron')` 失败——因为 Electron 的 `electron` 模块只能通过运行时由 Electron 本身注入，不能被打包器静态打入。external 插件是 electron-vite 模板的标准配置，不能省。

#### E. 立刻验证

本步骤无法独立验证；下一次能看到效果是步骤 17 完成后 `npm run dev`。

---

### 5.6 步骤 6：写 `.vscode/settings.json`

#### A. 动机

为了让团队成员（与未来的你）打开仓库立刻获得一致的开发体验：用工作区自带 TS 而不是全局 TS、统一行尾符（避免 Windows / macOS 协作时 Git diff 全是空白变化）、忽略 Tailwind v4 的 `@import / @theme` 引发的 CSS lint 误报。

#### B. 你将要做的操作

新建目录 `.vscode/`，在其中新建 `settings.json`。

#### C. 完整代码

*文件 `.vscode/settings.json`：*

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "typescript.preferences.importModuleSpecifier": "relative",
  "typescript.updateImportsOnFileMove.enabled": "always",
  "editor.codeActionsOnSave": {
    "source.fixAll": "explicit"
  },
  "css.lint.unknownAtRules": "ignore",
  "files.eol": "\n"
}
```

#### D. 这段代码做了什么

- `typescript.tsdk` + `enablePromptUseWorkspaceTsdk`：VS Code 第一次打开本工作区时会提示「使用工作区的 TS 版本」，避免不同人本地全局 TS 版本不一致导致的「在我电脑上能跑」问题。
- `importModuleSpecifier: "relative"`：自动 import 时使用相对路径（如 `./Sidebar`），与本项目偏好的相对引用风格保持一致；如果你的项目偏好 `@/` 别名，可以改成 `"non-relative"`。
- `updateImportsOnFileMove.enabled: "always"`：拖动文件改名时自动更新所有引用，省掉手动改 import 路径的人工成本。
- `editor.codeActionsOnSave.source.fixAll: "explicit"`：保存时只在你显式触发"修复全部"时才自动修复，不会在你按 Ctrl+S 时擅自修改源码。
- `css.lint.unknownAtRules: "ignore"`：Tailwind v4 引入了 `@theme`、`@layer` 等 VS Code 内置 CSS 解析器尚不识别的 at-rule，这一行避免红色波浪线。
- `files.eol: "\n"`：所有文件用 LF 换行；Git 在 Windows 默认 CRLF 会让跨平台协作时 diff 充满 `^M`。

> **反例对比**：把 `source.fixAll` 设为 `"always"`（旧版 VS Code 的默认值之一），每次保存都会无差别批量重写代码——例如把所有 `var` 改 `const`、删除"看起来没用的"导入。在调试中途这会让你的 git diff 突然多出十几处与本意无关的修改，难以追踪。`"explicit"` 是更可控的选择。

#### E. 立刻验证

关掉并重新用 VS Code 打开 `GUIDE/day1` 目录，右下角应该弹出「是否使用工作区的 TypeScript 5.x 版本」的提示。

---

### 5.7 步骤 7：写主进程 `electron/main.ts`

#### A. 动机

有了配置之后，第一段实质代码就是主进程入口。它的唯一职责是：在 `app.whenReady()` 后创建一个 `BrowserWindow`，让它加载 renderer。注意此刻 renderer 文件还不存在，主进程会在窗口里报 404——这是预期的，我们后面步骤 9 之后会补上。但写主进程时就要把 preload 路径、`contextIsolation`、`sandbox`、`autoHideMenuBar`、平台差异（macOS 不在 `window-all-closed` 时退出）这些边界条件一次性写对。

#### B. 你将要做的操作

新建 `electron/` 目录，在其中新建 `main.ts`。

#### C. 完整代码

*文件 `electron/main.ts`：*

```ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

function createWindow(): void {
  // 创建主窗口：Day 1 仅负责搭建可运行骨架，不注入业务逻辑。
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
  // Windows 平台任务栏与通知等系统行为依赖设置 AppUserModelId。
  electronApp.setAppUserModelId('com.electron')

  // 注册开发期快捷键监听（如 F12 / Ctrl+R）以贴合本地调试习惯。
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
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

- 顶部三个 import 分别来自 Electron 自身、Node 标准库、`@electron-toolkit/utils`（提供 `is.dev` 判断、`electronApp.setAppUserModelId`、`optimizer.watchWindowShortcuts` 等惯用工具函数）。
- `function createWindow()`：声明而非调用——会在 `app.whenReady()` 之后才被调用，这是 Electron 的硬性约定（在 ready 之前 `BrowserWindow` 行为未定义）。
- `width / height` 给定窗口初始尺寸；`show: false` 配合 `'ready-to-show'` 事件实现「先建好再显示」，杜绝白屏闪烁。
- `autoHideMenuBar: true`：Windows / Linux 下隐藏顶部菜单栏（按 Alt 仍可显示），让 IDE 更接近 VS Code 的简洁外观；macOS 菜单栏在系统顶部，不受影响。
- `webPreferences.preload`：必须是绝对路径，相对 `out/main/index.js` 计算（`__dirname` 在打包产物里指向 `out/main/`），所以走 `../preload/index.js` 找到 `out/preload/index.js`。
- `webPreferences.contextIsolation: true` 是重中之重：它把 renderer 的 JavaScript 上下文与 preload 的上下文隔离，preload 只能通过 `contextBridge.exposeInMainWorld` 显式把 API 暴露给 renderer。这避免了 renderer 拿到 `require('fs')` 这种灾难。
- `webPreferences.sandbox: false`：是为了让 preload 能继续 `require` Node 模块。如果完全沙盒化，preload 也只能用 `import` 且严格受限——后续我们要让 preload 转发文件系统、终端等 IPC，所以这里关闭沙盒，依赖 contextIsolation 提供安全。
- `setWindowOpenHandler`：拦截 `window.open(...)` / `target="_blank"`，把外链交给系统浏览器；防止应用内被钓鱼或加载未受控页面。
- `is.dev && process.env['ELECTRON_RENDERER_URL']` 是 electron-vite 在开发模式注入的环境变量，指向 Vite 启动的 renderer dev server。生产模式则走打包后的 `out/renderer/index.html`。
- `app.whenReady().then(...)`：Electron 在初始化完 GPU 进程、注册原生回调等之后才 resolve 这个 Promise；所有窗口操作都必须放在它内部。
- `app.on('activate', ...)`：macOS 应用通常关窗不退出，等用户从 Dock 重新激活时再开窗。
- `app.on('window-all-closed', ...)`：非 macOS 平台关窗就退出进程；macOS 留着进程在 Dock 上待命。

> **反例对比**：如果直接把 `mainWindow.show()` 写在 `createWindow()` 同步路径里（不等 `'ready-to-show'`），用户看到的是先一闪而过的白色背景再变成 IDE 内容——非常廉价的视觉感。Electron 官方文档将 `show: false` + `'ready-to-show'` 列为推荐模式，本质上是把窗口可见时机推迟到「第一帧已绘制」之后。

#### E. 立刻验证

此刻 renderer 还没有写，运行 `npm run dev` 会启动主进程并打开窗口，但窗口里加载会失败。我们继续往下走，等步骤 17 一并验证。

---

### 5.8 步骤 8：写 `electron/preload.ts`

#### A. 动机

preload 是主进程与渲染进程之间的「安全闸门」。它在渲染上下文创建之前执行、与 renderer 共享 `window`，可以通过 `contextBridge` 把精心挑选的方法暴露成 `window.api.xxx`。Day 1 我们还没有任何业务 IPC，所以暴露的是一个**空对象**——把「挂载位置」占好，后续每一天往里添方法即可。同时挂上 `@electron-toolkit/preload` 提供的 `electronAPI`（封装了 `ipcRenderer.send/on` 等常用方法到 `window.electron`）。

#### B. 你将要做的操作

新建 `electron/preload.ts`。

#### C. 完整代码

*文件 `electron/preload.ts`：*

```ts
import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 预留给渲染进程的自定义 API：Day 1 先放空对象，后续逐步扩展。
const api = {}

if (process.contextIsolated) {
  try {
    // 把 toolkit 提供的安全 API 显式挂载到 window.electron。
    contextBridge.exposeInMainWorld('electron', electronAPI)
    // 把业务 API 挂载到 window.api，后续通过 IPC 能力逐步填充。
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

- `import { contextBridge } from 'electron'`：preload 是少数几个能直接 `import 'electron'` 的地方（renderer 在 contextIsolation 下不能）。
- `const api = {}`：业务 API 容器，Day 1 是空对象，从 Day 2 开始往里加 `terminal`、Day 3 加 `fileSystem` 等。
- `process.contextIsolated`：Electron 注入到 preload 上下文的全局布尔变量，告诉我们当前是否启用了上下文隔离。我们前面在 `main.ts` 里设了 `contextIsolation: true`，这里走的是 `if` 分支。
- `contextBridge.exposeInMainWorld('electron', electronAPI)`：在 renderer 的 `window` 上挂出 `window.electron`，值是 `@electron-toolkit/preload` 封装的安全 API 集合（包括 `ipcRenderer.send / on / invoke` 等）。
- `contextBridge.exposeInMainWorld('api', api)`：在 renderer 的 `window` 上挂出 `window.api`。哪怕 `api = {}`，我们也要现在就挂好，这样 renderer 端的类型声明（步骤 11 的 `vite-env.d.ts` / 后续的 `electron.d.ts`）有具体落点。
- `try / catch`：保险动作，避免 contextBridge 因为 API 重名等原因抛异常时中断 renderer 加载——出错就只是打印到主进程终端，窗口仍能开。
- `// @ts-ignore (define in dts)`：在非隔离分支里直接赋值 `window.electron`，TS 默认不允许给 `window` 添加未声明的属性，用 `@ts-ignore` 告诉 TS 我们故意这么做（这一分支正常不会触发，但保留作兜底）。

> **反例对比**：如果绕过 `contextBridge` 直接写 `window.api = api`（在 contextIsolation 启用时），renderer 上**根本拿不到** `window.api`——因为此刻 preload 与 renderer 是隔离的两个 V8 上下文，preload 修改的 `window` 不是 renderer 看到的 `window`。`contextBridge.exposeInMainWorld` 是唯一能跨这道隔离把对象搬过去的合法 API。

#### E. 立刻验证

本步骤无法独立验证。等 renderer 加载后，我们能在 DevTools Console 输入 `window.api`，应当看到 `{}`。

---

### 5.9 步骤 9：写 `src/index.html`

#### A. 动机

Vite renderer 模式以 HTML 为入口，再通过 `<script type="module">` 拉起 JS。我们只需要一个最简化的 HTML 模板：一个 `#root` 容器供 React 挂载，一个指向 `main.tsx` 的脚本。

#### B. 你将要做的操作

新建 `src/` 目录，在其中新建 `index.html`。

#### C. 完整代码

*文件 `src/index.html`：*

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Day 1 IDE Frame</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

#### D. 这段代码做了什么

- `<!DOCTYPE html>` + `<meta charset="UTF-8">`：标准 HTML5 模板头，保证字符编码与浏览器解析模式正确。
- `<meta name="viewport">`：移动端 / 高 DPI 下的缩放策略；Electron 里其实可以不写，但保留以防有日子要嵌 webview。
- `<div id="root">`：React `createRoot(document.getElementById('root')!)` 的目标元素。
- `<script type="module" src="./main.tsx">`：`type="module"` 告诉浏览器按 ES Module 规则解析（支持 `import` / `export`）；Vite 在开发期会拦截这个请求，把 `.tsx` 当作 ES Module 加载并即时做 JSX/TS 转译。

> **反例对比**：如果省略 `type="module"`，浏览器把它当作经典脚本解析——经典脚本不支持顶层 `import`，会立刻报「Cannot use import statement outside a module」。`type="module"` 是 Vite/现代前端工程链的硬性前提。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.10 步骤 10：写 `src/main.css`

#### A. 动机

渲染层一启动就要加载样式，否则 React 渲染出来的元素会失去 Tailwind 类与色板。Day 1 我们做最少的事情：引入 Tailwind v4、定义 4 个 CSS 变量作为色板（背景、表面、前景、边框）、把页面 `body/html/#root` 拉满到全高。这套色板在 Day 8 引入完整设计系统时会被扩展。

#### B. 你将要做的操作

新建 `src/main.css`。

#### C. 完整代码

*文件 `src/main.css`：*

```css
@import "tailwindcss";

:root {
  --color-border: #3E3E42;
  --color-background: #1E1E1E;
  --color-surface: #252526;
  --color-foreground: #CCCCCC;
}

.bg-background { background-color: var(--color-background); }
.bg-surface { background-color: var(--color-surface); }
.text-foreground { color: var(--color-foreground); }
.border-border { border-color: var(--color-border); }

body, html {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background-color: var(--color-background);
  color: var(--color-foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

#root {
  height: 100%;
}
```

#### D. 这段代码做了什么

- `@import "tailwindcss"`：Tailwind v4 不再需要 `tailwind.config.js`，所有原子工具类通过这一行被注入。
- `:root` 里定义 4 个 CSS 变量：用 VS Code 风格的暗色色板。它们被下面四个工具类（`.bg-background` 等）转写成「传统类名风格」，方便 `<div className="bg-background">` 写法直观读懂。Day 8 引入完整设计系统时会继续用这种 CSS 变量做单一真相源。
- `body, html` 拉到 100 % 高度并 `overflow: hidden` —— IDE 应用要把滚动权交给内部各个面板（编辑器、文件树），外层永不出现浏览器自带滚动条。
- `font-family` 列了一串系统默认字体的 fallback 链：把 macOS 的 SF Pro、Windows 的 Segoe UI、Linux 的 Roboto 都覆盖掉，保证三大平台首选可用且原生美观。
- `#root { height: 100% }`：让 React 挂载点也撑满父容器，否则 `flex` 布局可能在 root 高度为 0 时坍缩。

> **反例对比**：如果按 Tailwind v3 写法 `@tailwind base; @tailwind components; @tailwind utilities;`，v4 直接报错说不识别这三条指令——v4 改成了单条 `@import "tailwindcss"`。换大版本时**第一时间检查官方迁移指南的指令是否变更**，这是从 v3 升 v4 最常踩的坑。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.11 步骤 11：写 `src/vite-env.d.ts`

#### A. 动机

我们用 `import './main.css'` 导入了一个 `.css` 文件，但 TypeScript 默认不知道这种导入是合法的。Vite 提供的 `vite/client` 类型已经声明了大多数静态资源的导入；我们额外补一行 `declare module '*.css'` 兜底，避免某些版本 TS 误报。

#### B. 你将要做的操作

新建 `src/vite-env.d.ts`。

#### C. 完整代码

*文件 `src/vite-env.d.ts`：*

```ts
/// <reference types="vite/client" />

declare module '*.css'
```

#### D. 这段代码做了什么

- `/// <reference types="vite/client" />`：以三斜线指令显式引用 Vite 的客户端类型，提供 `import.meta.env.MODE`、`import.meta.env.DEV` 等。
- `declare module '*.css'`：声明「任何以 `.css` 结尾的模块导入都是合法的」，没有具体类型（导入只为副作用执行——把样式插入文档）。

> **反例对比**：如果不写 `declare module '*.css'`，在某些 TS / 编辑器组合下 `import './main.css'` 会报 `Cannot find module './main.css' or its corresponding type declarations`。即使 Vite 本身能正确处理，TS 类型层面也得「告知」一下它合法。`*.png` / `*.svg` 同理需要在更大项目里逐一声明。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.12 步骤 12：写 `src/stores/editor.store.ts`

#### A. 动机

React 的局部 `useState` 不能跨组件共享，而我们的 IDE 必然有跨多个组件读写的状态（侧栏开 / 关、当前打开的文件、聊天面板状态……）。我们选用 Zustand 管理全局状态：API 极其精简、零样板、不用 Context Provider 包裹。Day 1 只放一个最小状态 `isSidebarOpen`，但通过它把「如何创建一个 Zustand store」的样板敲定，后续 Day 都按这个套路扩展。

#### B. 你将要做的操作

新建 `src/stores/` 目录，在其中新建 `editor.store.ts`。

#### C. 完整代码

*文件 `src/stores/editor.store.ts`：*

```ts
import { create } from 'zustand'

// 编辑器 UI 相关的最小全局状态结构。
interface EditorState {
  isSidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
}

// Day 1 仅维护一个状态位，用于演示 Zustand 的读写闭环。
export const useEditorStore = create<EditorState>((set) => ({
  isSidebarOpen: true,
  setSidebarOpen: (open) => set({ isSidebarOpen: open })
}))
```

#### D. 这段代码做了什么

- `import { create } from 'zustand'`：拉入 Zustand 的 store 工厂函数。
- `interface EditorState`：用 TS 接口同时声明 store 里有哪些字段、有哪些 action（action 也是 store 的一部分，只不过是函数而非数据）。
- `create<EditorState>((set) => ({ ... }))`：Zustand 的工厂函数。它接受一个工厂回调，回调拿到 `set`（合并式更新器），返回 store 的初始值与 action。`set({ isSidebarOpen: open })` 是 partial update，未列出的字段保持不变。
- 没有显式 `getState`，因为 `set` 已经能覆盖大多数场景；后续 Day 我们会展示 `set((state) => ...)` 的函数式更新与 `get` 的链式访问。
- `export const useEditorStore`：把 store 作为一个 React Hook 暴露给组件——组件用 `useEditorStore()` 调用即可订阅。

> **反例对比**：如果用裸 `let isSidebarOpen = true` 一个模块顶层变量做"全局状态"，组件改了它**不会**触发 React 重渲染——React 不知道这个变量变了。Zustand 的 `set` 内部通过订阅 / 通知机制，让所有用过该 store 的组件在状态变化后被重新调用，这是它存在的核心价值。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.13 步骤 13：写 `src/components/layout/StatusBar.tsx`

#### A. 动机

按依赖顺序，第一个组件应当是没有任何外部依赖的「叶子组件」。`StatusBar` 没有 props、没有读 store、没有任何行为，只是底部一行蓝色信息条——非常适合作为我们的第一个 React 组件。

#### B. 你将要做的操作

新建 `src/components/layout/` 目录，在其中新建 `StatusBar.tsx`。

#### C. 完整代码

*文件 `src/components/layout/StatusBar.tsx`：*

```tsx
export default function StatusBar() {
  return (
    // Day 1 状态栏仅用于展示版本与阶段信息。
    <div className="h-6 bg-blue-600 text-white text-xs flex items-center px-4 shrink-0 transition-colors">
      <span className="font-semibold">Day 1 Framework</span>
      <span className="mx-4 opacity-50">|</span>
      <span>React 19 + Electron 35 Base</span>
    </div>
  )
}
```

#### D. 这段代码做了什么

- 不需要 `import React`：因为 `tsconfig.json` 里 `"jsx": "react-jsx"`，新 JSX 转换不再要求显式导入 React。
- `export default function StatusBar()`：默认导出一个箭头无参函数组件，返回一段 JSX。
- `h-6` = 24 px、`bg-blue-600` 是 Tailwind 自带蓝色（Day 8 之后会换成设计系统的语义化颜色）。
- `flex items-center px-4`：Flex 容器、垂直居中、左右内边距 16 px。
- `shrink-0`：让 StatusBar 在 flex 父容器里永不被压缩，保证状态栏永远完整可见——这是底部状态栏的常见需求。
- `transition-colors`：色彩变化时走过渡动画（虽然 Day 1 没有动态变色，但提前预留以便后续 Day 7 的"分支变更高亮"等效果直接生效）。

> **反例对比**：JSX 里不能写 `<div class="h-6">`——会触发 React 警告 `Invalid DOM property 'class'. Did you mean 'className'?`。原因是 `class` 是 JS 关键字，JSX 用 `className` 来避免冲突。新手最容易踩的一个坑。

#### E. 立刻验证

本步骤无法独立验证（需要被 AppLayout 引用后才显示）。

---

### 5.14 步骤 14：写 `src/components/layout/Sidebar.tsx`

#### A. 动机

Sidebar 比 StatusBar 复杂一点：它要从全局 store 拿 `setSidebarOpen` 来响应「折叠」按钮。这是我们第一次演示「组件读 Zustand store + 触发 action」的完整闭环。

#### B. 你将要做的操作

在 `src/components/layout/` 新建 `Sidebar.tsx`。

#### C. 完整代码

*文件 `src/components/layout/Sidebar.tsx`：*

```tsx
import { useEditorStore } from '../../stores/editor.store'
import { FolderTree, X } from 'lucide-react'

export default function Sidebar() {
  // 仅取出写操作函数，避免不必要的状态订阅。
  const { setSidebarOpen } = useEditorStore()

  return (
    <div className="h-full bg-surface border-r border-border flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between uppercase text-xs font-semibold text-gray-400 border-b border-border">
        <span className="flex items-center"><FolderTree size={14} className="mr-2" />Explorer</span>
        {/* 关闭按钮触发全局状态更新，使外层侧边栏整体卸载。 */}
        <button onClick={() => setSidebarOpen(false)} className="hover:text-white cursor-pointer"><X size={14} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-gray-500 italic text-sm">Day 1: File Tree Will Be Here</p>
      </div>
    </div>
  )
}
```

#### D. 这段代码做了什么

- `import { useEditorStore } from '../../stores/editor.store'`：用相对路径导入 store hook。我们没有用 `@/` 别名是因为 Day 1 的目录结构很浅，相对路径反而更直观；后续 Day 嵌套深了再切换到别名。
- `import { FolderTree, X } from 'lucide-react'`：lucide-react 提供轻量 SVG 图标，按需 import 不会带入整个图标库。
- `const { setSidebarOpen } = useEditorStore()`：Zustand hook 调用一次拿到整个 store 对象，再用解构只取出我们用到的字段。
- 父容器 `h-full bg-surface border-r border-border flex flex-col`：撑满高度、深灰背景、右侧一条分隔线、纵向排布。
- 上半 `flex-shrink-0`（隐含于无 `flex-1`）的标题栏 + 下半 `flex-1` 的占位区，是 IDE 侧栏的标准两段式布局，后续 Day 会在 `flex-1 overflow-y-auto` 区域填入文件树。
- `<button onClick={() => setSidebarOpen(false)}>`：箭头函数包一层避免 `setSidebarOpen` 被当作 React 合成事件处理器误传 `event` 参数（虽然在这里不会出问题，但养成习惯）。

> **反例对比**：如果把订阅写成 `const state = useEditorStore()` 并在 JSX 里读 `state.setSidebarOpen`，只要 store 里**任何一个字段**变化，本组件都会重渲染——即使本组件只用到 setter。Zustand 推荐的进阶写法是 `useEditorStore((s) => s.setSidebarOpen)`，传入选择器只订阅一个字段；但解构整个 store 在小项目里也能工作，因为函数引用稳定不会触发"值变化"重渲染。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.15 步骤 15：写 `src/components/layout/AppLayout.tsx`

#### A. 动机

现在我们的两个组件（Sidebar、StatusBar）和 store 都已就位，可以把它们组装成完整的 IDE 骨架了。这是 Day 1 最复杂的一个文件：用 `react-resizable-panels` 提供水平 / 垂直可拖动分隔，用 lucide 图标做活动栏，用 Zustand 控制 Sidebar 显隐。

#### B. 你将要做的操作

在 `src/components/layout/` 新建 `AppLayout.tsx`。

#### C. 完整代码

*文件 `src/components/layout/AppLayout.tsx`：*

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import { FileCode, TerminalSquare, MessageSquare } from 'lucide-react'
import { useEditorStore } from '../../stores/editor.store'

export default function AppLayout() {
  // 从全局状态读取侧边栏开关。
  const { isSidebarOpen } = useEditorStore()

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* 主内容区：活动栏 + 侧边栏 + 主工作区 */}
      <div className="flex-1 flex overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* 活动栏：Day 1 仅展示图标，不绑定实际功能。*/}
          <div className="w-12 shrink-0 bg-surface border-r border-border flex flex-col items-center py-2 gap-4">
            <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
              <FileCode size={24} />
            </button>
            <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
              <MessageSquare size={24} />
            </button>
          </div>

          {/* 可折叠侧边栏：通过 Zustand 状态控制是否渲染。*/}
          {isSidebarOpen && (
            <>
              <Panel defaultSize={20} minSize={15} maxSize={30}>
                <Sidebar />
              </Panel>
              <PanelResizeHandle className="w-1 bg-border hover:bg-blue-500 transition-colors" />
            </>
          )}

          {/* 主工作区：上方编辑区占位 + 下方终端占位。*/}
          <Panel defaultSize={80}>
            <PanelGroup direction="vertical">
              {/* 编辑区占位：Day 2 将替换为 Monaco。*/}
              <Panel defaultSize={70}>
                <div className="h-full flex items-center justify-center bg-background border-b border-border">
                  <p className="text-gray-500 italic">Day 1: Monaco Editor Will Be Here</p>
                </div>
              </Panel>

              <PanelResizeHandle className="h-1 bg-border hover:bg-blue-500 transition-colors" />

              {/* 终端占位：Day 2 将替换为 xterm.js。*/}
              <Panel defaultSize={30}>
                <div className="h-full flex flex-col bg-surface">
                  <div className="h-8 border-b border-border flex items-center px-4">
                    <TerminalSquare size={14} className="mr-2" />
                    <span className="text-xs uppercase font-semibold">Terminal</span>
                  </div>
                  <div className="flex-1 flex items-center justify-center">
                    <p className="text-gray-500 italic">Day 1: Xterm.js Will Be Here</p>
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>

      {/* 状态栏固定在底部。*/}
      <StatusBar />
    </div>
  )
}
```

#### D. 这段代码做了什么

- 顶部 import 拉入 `react-resizable-panels` 三件套（`PanelGroup` 容器、`Panel` 单元格、`PanelResizeHandle` 拖动手柄）、两个本地组件、三个 lucide 图标、store hook。
- 最外层 `flex flex-col h-screen` 把整个窗口分成「内容区 + 状态栏」两段；状态栏在最底部，剩余高度全交给 `flex-1` 的内容区。
- `<div className="flex-1 flex overflow-hidden">`：主内容容器，`overflow-hidden` 防止内部尺寸溢出导致整页滚动条。
- `<PanelGroup direction="horizontal">`：横向布局组。`react-resizable-panels` 库会根据 `Panel` 之间放置的 `PanelResizeHandle` 自动启用拖动。
- 活动栏不是 `Panel`，而是一个固定宽度的 div：`w-12 shrink-0`。这样它不参与可拖动尺寸调整，永远是 48 px。
- 侧边栏被 `{isSidebarOpen && (...)}` 包裹：当 store 中 `isSidebarOpen` 为 false（即 Sidebar 里点了 ✕）时，整个 `<>...</>` Fragment 被卸载，连同它后面的 `PanelResizeHandle` 一起消失。这样剩下的 `Panel defaultSize={80}` 自动占满。
- `defaultSize={20} minSize={15} maxSize={30}`：侧栏初始宽度 20 %，可拖范围 15 %~30 %（百分比相对 PanelGroup）。
- 内层 `PanelGroup direction="vertical"` 把右侧大区域再分成上下两半，比例 7 : 3。
- 注意 `react-resizable-panels` 要求 `Panel` 必须是 `PanelGroup` 的**直接子节点**——所以我们用 Fragment `<>...</>` 包裹「侧栏 Panel + Handle」让它们以 sibling 形式落到 PanelGroup 之下。
- 最底部直接渲染 `<StatusBar />`，它带有 `shrink-0`，永远占住 24 px 高度。

> **反例对比**：如果把 `{isSidebarOpen && (...)}` 写成 `<div>{isSidebarOpen && (...)}</div>`，多了一层 `<div>` 包裹，`react-resizable-panels` 在运行时检测 PanelGroup 的直接子节点不是 Panel，会抛 `Panel must be a child of PanelGroup`。Fragment 没有真实 DOM 节点，是这种"既要分组又不能多包一层"场景的标准方案。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.16 步骤 16：写 `src/App.tsx`

#### A. 动机

React 习惯有一个顶层 `App` 组件作为整个应用的根。Day 1 的 `App` 只做一件事：渲染 `AppLayout`。它存在的意义在于：未来 Day 引入路由、错误边界、全局 Provider 时，所有这些壳子都装在 `App` 里，`AppLayout` 仍然只做「布局」。

#### B. 你将要做的操作

新建 `src/App.tsx`。

#### C. 完整代码

*文件 `src/App.tsx`：*

```tsx
import AppLayout from './components/layout/AppLayout'

function App() {
  // Day 1 直接返回布局骨架，业务模块在后续天数逐步挂载。
  return <AppLayout />
}

export default App
```

#### D. 这段代码做了什么

- 单一职责：把「挂载布局」与「挂载到 DOM」两件事拆开。`App` 负责前者，`main.tsx` 负责后者。
- `function App()` + `export default App` 而不是 `export default function App()`：两者运行时无差别，分离写法在调试栈跟踪里能显示更友好的函数名。

> **反例对比**：如果在 `main.tsx` 里直接 `createRoot(...).render(<AppLayout />)`，跳过 `App` 这一层，看起来更短，但下次要加 `<ErrorBoundary>`、`<RouterProvider>`、`<ThemeProvider>` 等全局壳子时就得修改 `main.tsx`——而 `main.tsx` 应该只关心"挂到 DOM"。把"应用根"与"挂载逻辑"分层是 React 项目的小习惯，长远收益大于即时简洁。

#### E. 立刻验证

本步骤无法独立验证。

---

### 5.17 步骤 17：写 `src/main.tsx`

#### A. 动机

Renderer 的 JS 真正入口。它通过 `createRoot` 把 React 树挂到 `index.html` 的 `#root` 上，并在 `StrictMode` 包裹下启动——后者会在开发期对副作用执行双调用，帮助提前发现「effect 副作用未幂等」的 bug。

#### B. 你将要做的操作

新建 `src/main.tsx`。

#### C. 完整代码

*文件 `src/main.tsx`：*

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './main.css'

// 把根组件挂载到 index.html 中的 #root 容器。
createRoot(document.getElementById('root')!).render(
  // StrictMode 在开发期帮助发现副作用与潜在问题。
  <StrictMode>
    <App />
  </StrictMode>
)
```

#### D. 这段代码做了什么

- `import { StrictMode } from 'react'`：StrictMode 仅在开发期生效，生产构建被剥离；它会让 `useEffect` / `useState` 初始化等钩子执行两次，强迫我们写出"重复执行也无副作用"的代码。
- `import { createRoot } from 'react-dom/client'`：React 18+ 的新挂载 API，启用并发特性（concurrent rendering）。
- `import './main.css'`：通过 import 触发 CSS 副作用——Vite 会把 CSS 注入文档 `<head>`。**这一行没有解构、没有赋值，仅 `import 'xxx'` 形式被称为"副作用导入"**。
- `document.getElementById('root')!`：`!` 是非空断言，告诉 TS "我确认这个元素一定存在"。如果不写，TS 因为 `getElementById` 返回 `HTMLElement | null` 而拒绝把它传给 `createRoot`。
- `createRoot(...).render(...)`：链式调用——先创建根，再渲染节点。
- `<StrictMode><App /></StrictMode>`：StrictMode 只是一个透明壳子，不会渲染真实 DOM；它在开发期对子树的渲染做额外检查。

> **反例对比**：如果按 React 17 老 API 写 `import ReactDOM from 'react-dom'; ReactDOM.render(<App/>, document.getElementById('root'))`，在 React 19 里直接报错——`react-dom` 顶层包不再导出 `render`。React 18+ 必须走 `react-dom/client` 子路径并用 `createRoot`。这是从 React 17 升 18/19 时**最常见的破坏性变更**。

#### E. 立刻验证

**这是最后一步**，所有依赖都齐了。打开终端：

```powershell
npm run dev
```

预期：

1. `electron-vite dev` 输出 vite server 启动日志。
2. 几秒后弹出窗口。
3. 窗口呈现 § 2 描述的全部 IDE 骨架。
4. DevTools 已自动打开，Console 输入 `window.api`，应当返回 `{}`。
5. 输入 `window.electron`，应当返回包含 `ipcRenderer` 等字段的对象。
6. 点击侧栏右上角 ✕，侧栏折叠；右侧主工作区自动占满。

如果没看到窗口，先看主进程终端输出有没有报错（如端口被占、preload 路径不对），再看 DevTools Console 有没有 React/JS 异常。

---

## 6. 端到端串联走查

我们以「用户点击侧栏 ✕ 折叠 sidebar」这条用户操作为线索，把刚刚写好的 17 个文件之间的协作走一遍。

| 时序 | 位置 | 关键代码 |
|---|---|---|
| 1 | 用户点击 Sidebar 标题栏右侧的 `<X />` 按钮 | `src/components/layout/Sidebar.tsx`：`<button onClick={() => setSidebarOpen(false)}>` |
| 2 | `setSidebarOpen` 是 Zustand store 暴露的 action | `src/stores/editor.store.ts`：`setSidebarOpen: (open) => set({ isSidebarOpen: open })` |
| 3 | Zustand 的 `set` 触发订阅了 `isSidebarOpen` 的组件重渲染 | `src/components/layout/AppLayout.tsx`：`const { isSidebarOpen } = useEditorStore()` |
| 4 | AppLayout 重渲染时 `isSidebarOpen` 为 false，`{isSidebarOpen && (...)}` 整个分支不再渲染 | `src/components/layout/AppLayout.tsx`：`{isSidebarOpen && (<><Panel>...</Panel><PanelResizeHandle/></>)}` |
| 5 | `react-resizable-panels` 检测到 PanelGroup 子节点变化，把右侧 `Panel defaultSize={80}` 重新计算尺寸为 100 % | 库内部行为，无源码改动 |
| 6 | React 提交真实 DOM 变更：Sidebar 与 ResizeHandle 节点被卸载，浏览器重新绘制 | 浏览器渲染管线 |

这条链路**不涉及任何 IPC、不涉及主进程**——全部在渲染层完成。Day 1 的工作恰恰是为了保证后续涉及 IPC 的链路（Day 3 的「点击文件树打开文件」）也能像这条一样清晰可追踪。

---

## 7. 完整运行流程追踪（结合真实示例）

我们以一次最完整的「`npm run dev` 直到看到窗口里的折叠交互」为线索，把 § 5 写过的 17 个文件**实际被加载与执行的顺序**走一遍。

### 7.1 命令解析阶段

```powershell
Set-Location .\GUIDE\day1
npm run dev
```

`npm` 读 `package.json`：

```json
"scripts": { "dev": "electron-vite dev" }
```

于是 `npm` spawn 一个子进程执行 `node_modules/.bin/electron-vite dev`。这一步的产物只是一个被启动的子进程，**还没有任何 Electron 窗口**。

### 7.2 构建器编译阶段

`electron-vite dev` 读 `electron.vite.config.ts`：

```ts
export default defineConfig({
  main:    { build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/main.ts')   } } }, plugins: [externalizeDepsPlugin()] },
  preload: { build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload.ts')} } }, plugins: [externalizeDepsPlugin()] },
  renderer:{ root: resolve(__dirname, 'src'), plugins: [react(), tailwindcss()] /* … */ }
})
```

它做三件并行的事：

1. **编译主进程**：`electron/main.ts` → `out/main/index.js`（CommonJS），第三方依赖被 `externalizeDepsPlugin` 标为 external（不打入产物，运行时直接 `require('electron')`）。
2. **编译 preload**：`electron/preload.ts` → `out/preload/index.js`。
3. **启动 renderer dev server**：Vite 监听 `src/`，把 `src/index.html` 设为入口；不预编译，按需转译。dev server 拿到一个端口（默认 5173），URL 是 `http://localhost:5173/`。

编译完毕后，`electron-vite` spawn 一个 Electron 子进程，命令大致等价于：

```powershell
$env:ELECTRON_RENDERER_URL = "http://localhost:5173/"
node_modules/.bin/electron .   # "."  =>  读 package.json 的 "main" 字段 → out/main/index.js
```

### 7.3 主进程冷启动

Electron 启动后执行 `out/main/index.js`，内部就是我们 `electron/main.ts` 的编译产物。关键执行顺序：

1. **顶层 import 立刻执行**：

   ```ts
   import { app, BrowserWindow, shell } from 'electron'
   import { join } from 'path'
   import { electronApp, optimizer, is } from '@electron-toolkit/utils'
   ```

   `app` 是 Electron 全局应用单例。

2. **注册事件，等待 ready**：

   ```ts
   app.whenReady().then(() => {
     electronApp.setAppUserModelId('com.electron')
     app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
     createWindow()
     app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
   })
   ```

3. **`createWindow()` 真正建窗**：

   ```ts
   const mainWindow = new BrowserWindow({
     width: 1024, height: 768,
     show: false,                     // 关键：先不可见，等首屏画好
     autoHideMenuBar: true,
     webPreferences: {
       preload: join(__dirname, '../preload/index.js'),  // __dirname = out/main/，故 ../preload/ = out/preload/
       sandbox: false,
       contextIsolation: true
     }
   })
   ```

4. **加载 renderer**：

   ```ts
   if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
     mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])  // → http://localhost:5173/
   }
   ```

### 7.4 preload 与 renderer 加载

`mainWindow.loadURL(...)` 触发 Chromium 渲染进程：

1. Chromium **先**执行 `preload`（`out/preload/index.js`）：

   ```ts
   contextBridge.exposeInMainWorld('electron', electronAPI)
   contextBridge.exposeInMainWorld('api', {})
   ```

   此时 renderer 上下文还没运行任何业务 JS，但 `window.electron` / `window.api` 已经挂上。

2. Chromium 拉取 `http://localhost:5173/index.html`（Vite dev server 服务的就是 `src/index.html`）：

   ```html
   <div id="root"></div>
   <script type="module" src="./main.tsx"></script>
   ```

3. 浏览器解析 `<script type="module">`，向 dev server 请求 `./main.tsx`。Vite 即时把 TSX 转译为 ES 浏览器原生 JS 返回。

4. `main.tsx` 执行：

   ```ts
   import './main.css'                          // 触发 Vite 把 CSS 注入文档 head
   createRoot(document.getElementById('root')!).render(
     <StrictMode><App /></StrictMode>
   )
   ```

5. `<App />` → `<AppLayout />` → React 调和后产出真实 DOM：活动栏、Sidebar、占位编辑器、占位终端、StatusBar。

### 7.5 首屏可见

`mainWindow` 在 React 完成首次提交后触发 `'ready-to-show'`：

```ts
mainWindow.on('ready-to-show', () => mainWindow.show())
```

窗口由不可见变为可见，§ 2 描述的画面出现。

### 7.6 一次用户交互的运行时回路

到这里 § 6 的端到端走查（点击 ✕ 折叠 Sidebar）就开始了。把它接到本节末尾，整个 Day 1 的「从源代码到用户交互」链路才闭合：

```text
DOM 'click' 事件
  → React 合成事件 dispatch
  → Sidebar.tsx 的 onClick 触发 setSidebarOpen(false)
  → editor.store.ts 中 set({ isSidebarOpen: false })
  → Zustand 通知所有订阅该 slice 的组件
  → AppLayout.tsx 重渲染，{isSidebarOpen && (...)} 评估为 false
  → React 卸载侧栏 Panel + ResizeHandle
  → react-resizable-panels 重算右侧 Panel 尺寸
  → 浏览器 paint
```

注意整个回路**全在 renderer**，没有跨进程 IPC。Day 3 我们才会看到第一条跨进程链路（「点击文件树打开文件」 → `window.api.fileSystem.readFile(...)` → preload → IPC → 主进程 → 回传文本 → store → MonacoWrapper.setValue）。

---

## 8. 必学知识点深化（按需）

本日 § 4 已经把所有新概念铺垫完成，§ 8 暂无可补，整节略过。下一日（Day 2）会在 § 8 深入讲 Monaco 的 model / view / controller 三件套与 xterm.js 的伪终端协议。

---

## 9. 自测清单

对照下表逐项检查，全部 ✅ 才算 Day 1 完成。

- [ ] `npm install` 顺利完成，无 `ERR!` 级错误。
- [ ] `npm run dev` 启动后弹出窗口（对应 § 1.1 目标 1）。
- [ ] 窗口里看到完整 IDE 骨架：活动栏 / 侧栏 / 编辑器占位 / 终端占位 / 状态栏（对应 § 1.1 目标 2）。
- [ ] 点击侧栏右上 ✕ 后侧栏折叠，主工作区扩展（对应 § 1.1 目标 3）。
- [ ] DevTools Console 输入 `window.api` 返回 `{}`、`window.electron` 返回非空对象（对应 § 1.2 目标 1）。
- [ ] 拖动侧栏右边缘可以改变宽度，最小 15 %、最大 30 %（验证 `react-resizable-panels` 工作正常）。
- [ ] 拖动编辑器与终端占位之间的横线，可以改变上下高度比。
- [ ] 在 `src/components/layout/AppLayout.tsx` 故意写一处 TS 类型错误，VS Code 应当立刻显示红色波浪线（验证 § 1.2 目标 3）。


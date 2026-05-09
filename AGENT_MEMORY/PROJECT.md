# 项目上下文

## 项目目标
构建一个 Agent Code Editor IDE，基于 Electron + React + TypeScript。
跟随 GUIDE/ 目录下按天划分的快照教程，逐步实现从骨架到完整 Agent IDE 的演进。

## 用户背景
C++ 开发者，零 JS/TS 经验。所有 JS/TS/React/Electron 概念均需通过 C++ 类比建立认知。

## 技术栈
- **Electron 35**：桌面应用框架，3 进程模型（main / preload / renderer）
- **electron-vite 3.0**：统一构建 3 个进程，dev 时在 localhost:5173 启动 Vite Dev Server
- **React 19 + TypeScript 5.7**：TSX 组件，Zustand v5 全局状态
- **Tailwind CSS v4**：`@tailwindcss/vite` 插件，无配置文件，`@import "tailwindcss"` 激活
- **react-resizable-panels**：可拖动分割布局
- **lucide-react**：SVG 图标组件
- **@monaco-editor/react**：Monaco 编辑器封装（Day 2+）
- **@xterm/xterm + @xterm/addon-fit**：终端模拟器（Day 2+）

## 工作根目录
`d:\Project\ON_GOING\Airi-Agent-IDE`

## 目录结构约定
```
electron/           主进程 + preload（Node.js 环境）
src/                Renderer 进程（Chromium/React 环境）
  components/
    editor/         Monaco 包裹组件
    terminal/       xterm 终端组件
    layout/         布局组件（AppLayout, Sidebar, StatusBar）
  stores/           Zustand 状态（editor.store.ts）
GUIDE/dayN/         第 N 天的完整快照，作为参考/验证基准
GUIDE/dev-log/      每天的开发日志（Markdown）
AGENT_MEMORY/       Agent 跨会话工作记忆（本目录）
```

## IPC 约定
- channel 命名：`模块:动作`，如 `terminal:run-command`、`fs:read-file`
- 全部 handler 注册在 `electron/main.ts` 的 `app.whenReady()` 内
- 全部暴露在 `electron/preload.ts` 的 `const api = { ... }` 对象里
- Renderer 统一通过 `window.api.xxx()` 调用，类型在 `src/vite-env.d.ts` 声明

## 安全约定
- `contextIsolation: true`（永不关闭）
- `sandbox: false`（electron-vite 模板默认，允许 preload 使用 Node API）
- `exec` 仅用于用户直接输入的命令；LLM 产生的命令从 Day 5 起改用 `execFile` + 白名单

## 代码风格
- 函数组件 + hooks，无 class 组件
- 外部副作用（DOM 实例、事件监听）用 `useRef` 而非 `useState`，避免触发重渲染
- 所有 `useEffect` 必须有完整 cleanup（dispose / removeEventListener）
- 接口形状定义在 `src/vite-env.d.ts`，渲染端无 `any`

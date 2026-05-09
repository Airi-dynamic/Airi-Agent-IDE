# 开发进度

## 当前阶段
**Day 2：接入 Monaco 编辑器、xterm 终端与第一条 IPC**

Day 1 已完成并通过快照对比验证。

---

## Day 2 步骤完成状态

| # | 文件 | 状态 | 备注 |
|---|---|---|---|
| 1 | `package.json` | ✅ 完成 | 新增 `@monaco-editor/react`, `@xterm/xterm`, `@xterm/addon-fit`；已 `npm install` |
| 2 | `electron/main.ts` | ✅ 完成 | 注册 `ipcMain.handle('terminal:run-command', ...)` |
| 3 | `electron/preload.ts` | ✅ 完成 | `const api = { runCommand: ... }` 已填充 |
| 4 | `src/vite-env.d.ts` | ✅ 完成 | 声明 `TerminalCommandResult`, `RendererApi`, `Window.api` |
| 5 | `src/components/editor/MonacoWrapper.tsx` | ✅ 完成 | `<Editor>` 组件，vs-dark 主题，无 minimap |
| 6 | `src/components/terminal/TerminalInstance.tsx` | ⏳ 待完成 | 文件已创建但内容为空，尚未实现 xterm 逻辑 |
| 7 | `src/components/layout/AppLayout.tsx` | ⏳ 待完成 | 仍是 Day 1 占位文字，待接入 MonacoWrapper 和 TerminalInstance |
| 8 | `src/components/layout/StatusBar.tsx` | ⏳ 待完成 | 文案仍是 "Day 1 Framework"，需改为 Day 2 |

---

## Day 2 已知状态细节

### electron/main.ts 修正记录
- 用户误写了 `import { stdout } from 'process'`（已修复，`process` 是 Node 全局无需 import）
- 用户误写了 `import { Code } from 'lucide-react'`（已修复，lucide-react 只属于 renderer）

### AppLayout.tsx 当前状态
- 编辑器区：`<div>` 里有 `<p>Monaco 编辑器将会被放置在此处</p>`（占位）
- 终端区：`<div>` 里有 `<p>终端面板将会被放置在此处</p>`（占位）
- 待替换为 `<MonacoWrapper />` 和 `<TerminalInstance />`

### TerminalInstance.tsx 待实现内容（对照 GUIDE/day2 快照）
- `useRef`：containerRef, terminalRef, fitAddonRef, commandBufferRef
- `useEffect([], [])` 内：创建 Terminal 实例，loadAddon(fitAddon)，open(container)，fit()
- 行编辑逻辑：`\r`=回车执行，`\u007f`=退格，`\u0003`=Ctrl+C，可见字符=回显追加
- `runCommand` 异步函数：调用 `window.api.runCommand`，把 stdout/stderr 写回 xterm
- window resize → fitAddon.fit()
- cleanup：dispose terminal + onData + removeEventListener

---

## Day 1 已完成文件（已对齐快照）

| 文件 | 说明 |
|---|---|
| `electron/main.ts` | 主进程，1024×768，contextIsolation:true，dev 模式打开 DevTools |
| `electron/preload.ts` | contextBridge 暴露 electronAPI + api |
| `src/index.html` | 标准 HTML 入口 |
| `src/main.tsx` | createRoot + StrictMode + App |
| `src/App.tsx` | 仅渲染 AppLayout |
| `src/main.css` | Tailwind v4 + CSS 变量 + body reset |
| `src/vite-env.d.ts` | vite/client 引用 + CSS 模块声明 + Day 2 类型扩展 |
| `src/stores/editor.store.ts` | Zustand isSidebarOpen 状态 |
| `src/components/layout/StatusBar.tsx` | 底部蓝色状态栏 |
| `src/components/layout/Sidebar.tsx` | 左侧文件树面板（Explorer） |
| `src/components/layout/AppLayout.tsx` | 主布局：activity bar + 可拖动面板组 |

---

## 未来阶段（尚未开始）

- Day 3：文件系统与文件树（ipcMain fs 操作，FileTree 组件）
- Day 4：对话面板与流式输出
- Day 5：工具调用与函数调用
- Day 6：Agent 主循环
- Day 7：Git 集成与高级工具
- Day 8：Diff 审核与设计系统

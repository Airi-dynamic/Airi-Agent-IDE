# Day 3：文件系统服务、文件树与受控编辑器

## 0. 前言

Day 2 我们打通了 renderer ↔ main 的第一条 IPC（终端命令），但所有 IPC handler 都堆在 `electron/main.ts` 里。今天 Day 3 既要做**业务功能**——读取项目目录、把文件树渲染到侧边栏、点击文件让 Monaco 显示真实文件内容——也要做**架构升级**：把"业务逻辑（service）"与"IPC 桥接（ipc）"两层拆开，把 main.ts 瘦身回单纯的"启动器"。Day 4 起所有新功能（agent / git / search）都会沿用这套 service + ipc 二层骨架。

本日开始 §4 基础知识铺垫**仅讲当日新概念**（按 LOG-SPEC §3.4bis）：分层架构、Node fs/promises、路径沙箱、受控 React 组件、递归 React 渲染。

---

## 1. 本日目标与产出

### 1.1 功能目标

1. 启动后侧边栏 Explorer 区域自动列出当前工作目录的文件树（递归展开），过滤 `node_modules / .git / out / dist / .DS_Store`。
2. 点击某个文件项 → Monaco 编辑器立刻加载该文件内容、按扩展名切换语法高亮（ts/tsx/js/json/css/html/md/yaml）。
3. 状态栏显示当前打开文件名（无文件时显示 `No file opened`）。
4. 文件树支持点击文件夹展开 / 折叠；右上角"刷新"按钮重新拉取整棵树。
5. Day 2 的所有功能（终端、可拖动面板、侧栏折叠）保持工作。

### 1.2 工程目标

1. 把 IPC 拆成 `electron/ipc/<feature>.ipc.ts` 模块，由 `electron/ipc/index.ts` 统一注册；`main.ts` 只调一次 `registerIpcHandlers()`。
2. 业务逻辑（递归读目录、路径沙箱、读文件）放进 `electron/services/file-system.service.ts`，与 IPC 解耦——同一个 service 未来既可以被 IPC 调用，也可以被 Day 5 的工具（agent tool）直接 import。
3. 全局类型（`FileTreeNode / WorkspaceTreeResult`）单一来源：service 里 `export interface`，`vite-env.d.ts` 用相同形状声明 renderer 端，让两端契约对齐。
4. 编辑器从 Day 2 的"非受控（defaultValue）"切换为"受控（value + onChange）"，配合 Zustand store 把"当前文件路径 / 内容"提升为全局状态。

---

## 2. 先跑起来（Smoke Run）

```powershell
Set-Location .\GUIDE\day3
npm install
npm run dev
```

预期窗口现象：

1. 侧边栏 EXPLORER 标题下出现工作目录路径与一棵文件树（`.vscode/`、`electron/`、`src/`、`package.json` 等）。
2. 点击 `package.json` → 编辑器立即显示该文件 JSON 内容，语法高亮为 JSON；状态栏出现 `Opened: package.json`。
3. 点击 `src/components/file-explorer/FileExplorer.tsx` → 编辑器换成该文件，语法变成 TypeScript。
4. 点击文件夹（`electron`、`src`）能展开 / 折叠。
5. 右上角 ⟳ 按钮可手动刷新文件树（验证：在终端 `New-Item temp.txt`，刷新后能看到 `temp.txt` 出现）。
6. 在 Monaco 内修改文件内容——内容会同步到全局 store（StatusBar 标题不变；本日**没做**保存按钮，下一日 Day 4 会接入）。
7. 终端依然能跑 `node -v`、Day 2 全部行为不变。

---

## 3. 项目结构与变更总览

### 3.1 项目目录树（ASCII）

```text
day3/
├─ electron/
│  ├─ main.ts                              # 修改：移除内联 IPC 调用，改为 registerIpcHandlers()
│  ├─ preload.ts                           # 修改：暴露 getFileTree / readFile
│  ├─ ipc/                                 # 新增目录：所有 IPC channel 注册按 feature 拆分
│  │  ├─ index.ts                          # 新增：统一注册入口
│  │  ├─ terminal.ipc.ts                   # 新增：从 Day 2 main.ts 抽出的终端 handler
│  │  └─ file-system.ipc.ts                # 新增：getFileTree + readFile 的 IPC 包装
│  └─ services/                            # 新增目录：纯业务逻辑（不依赖 ipcMain / BrowserWindow）
│     └─ file-system.service.ts            # 新增：FileSystemService 类（递归扫描、安全读文件）
├─ src/
│  ├─ components/
│  │  ├─ editor/
│  │  │  └─ MonacoWrapper.tsx              # 修改：从非受控变为受控，按扩展名切语言
│  │  ├─ file-explorer/                    # 新增目录
│  │  │  ├─ FileExplorer.tsx               # 新增：加载文件树、错误处理、刷新按钮
│  │  │  └─ FileTreeItem.tsx               # 新增：递归节点组件
│  │  ├─ layout/
│  │  │  ├─ AppLayout.tsx                  # 修改：仅注释微调（功能未变）
│  │  │  ├─ Sidebar.tsx                    # 修改：把 Day 2 占位换成 <FileExplorer />
│  │  │  └─ StatusBar.tsx                  # 修改：显示当前打开文件名
│  │  └─ terminal/
│  │     └─ TerminalInstance.tsx           # 修改：欢迎语 "Day 2" → "Day 3"
│  ├─ stores/
│  │  └─ editor.store.ts                   # 修改：新增 openFilePath / openFileContent 字段
│  └─ vite-env.d.ts                        # 修改：声明 FileTreeNode / WorkspaceTreeResult / RendererApi 新方法
└─ package.json                            # 修改：name / description 改为 day3
```

不变文件：`tsconfig*.json`、`electron.vite.config.ts`、`src/App.tsx`、`src/main.tsx`、`src/main.css`、`src/index.html`。

### 3.2 构建 / 运行链路图

Day 3 引入了**两条新 IPC 回路**，叠加在 Day 2 的终端回路之上：

```text
[ 用户启动应用 ]
        │
        ▼
FileExplorer.tsx :: useEffect(() => { void loadTree() }, [])
        │
        ▼
window.api.getFileTree()                       ← preload 桥接
        │ ipcRenderer.invoke('file-system:get-tree')
        ▼  跨进程
ipcMain.handle('file-system:get-tree', ...)    electron/ipc/file-system.ipc.ts
        │
        ▼
FileSystemService.getFileTree()                electron/services/file-system.service.ts
        │ readdir(workspaceRoot, { withFileTypes: true })
        │ 过滤 node_modules / .git / out / dist
        │ 按 "目录优先 + 字典序" 排序
        │ 对每个目录递归 readDirectory()
        ▼
return { workspaceRoot, tree: FileTreeNode[] }
        │ 结构化克隆穿回 renderer
        ▼
FileExplorer.tsx :: setTreeNodes(result.tree)
        │ React 重渲染 → 递归挂载 <FileTreeItem />
        ▼
[ 树渲染完成 ]


[ 用户点击文件 file.tsx ]
        │
        ▼
FileTreeItem.tsx :: onClick → onOpenFile(node)
        │
        ▼
FileExplorer.tsx :: handleOpenFile(node)
        │ window.api.readFile(node.path)
        ▼  IPC
ipcMain.handle('file-system:read-file', ...)
        │
        ▼
FileSystemService.readTextFile(filePath)
        │ ensureInsideWorkspace(filePath)   ← 路径沙箱
        │ stat() 拒绝目录
        │ readFile(absolutePath, 'utf-8')
        ▼
return string
        │
        ▼
FileExplorer :: setOpenFile(path, content)     editor.store.ts
        │ Zustand 通知所有订阅者
        ▼
MonacoWrapper.tsx :: 重新渲染
        │ <Editor value={openFileContent} language={getLanguageByFilePath(...)} path={openFilePath}>
        ▼
[ Monaco 显示新内容 + 语法高亮 ]
```

### 3.3 编码步骤索引（依赖顺序）

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `package.json` | 修改 | name / description 改为 day3 |
| 2 | `electron/services/file-system.service.ts` | 新增 | 业务核心（递归 / 沙箱 / 读文件） |
| 3 | `electron/ipc/file-system.ipc.ts` | 新增 | 包装 service 暴露为 IPC handler |
| 4 | `electron/ipc/terminal.ipc.ts` | 新增 | 从 Day 2 main.ts 抽出 |
| 5 | `electron/ipc/index.ts` | 新增 | 聚合注册入口 |
| 6 | `electron/main.ts` | 修改 | 调 registerIpcHandlers() 替代内联 |
| 7 | `electron/preload.ts` | 修改 | 暴露 getFileTree / readFile |
| 8 | `src/vite-env.d.ts` | 修改 | FileTreeNode / WorkspaceTreeResult / RendererApi |
| 9 | `src/stores/editor.store.ts` | 修改 | openFilePath / openFileContent 字段 |
| 10 | `src/components/file-explorer/FileTreeItem.tsx` | 新增 | 递归叶子组件 |
| 11 | `src/components/file-explorer/FileExplorer.tsx` | 新增 | 树容器 + 加载 + 刷新 |
| 12 | `src/components/layout/Sidebar.tsx` | 修改 | 嵌入 `<FileExplorer />` |
| 13 | `src/components/editor/MonacoWrapper.tsx` | 修改 | 受控 + 按扩展名切语言 |
| 14 | `src/components/layout/StatusBar.tsx` | 修改 | 显示当前文件名 |
| 15 | `src/components/terminal/TerminalInstance.tsx` | 修改 | 欢迎语 "Day 2" → "Day 3" |

依赖序原则：service（不依赖任何业务）→ ipc（依赖 service 与 ipcMain）→ main / preload（接线）→ 类型 / store（renderer 基础）→ 叶子组件（FileTreeItem 不依赖外部组件）→ 容器组件（FileExplorer 用 FileTreeItem + store + IPC）→ 布局接入。

---

## 4. 基础知识铺垫

按 LOG-SPEC，从今日起 §4 仅铺垫**当日新引入**的概念。

### 4.1 main 进程的「services + ipc」分层

Day 2 我们把 `child_process.exec` 直接写在 `ipcMain.handle` 回调里——能跑，但有三个问题：① 业务逻辑与 IPC 协议耦合，不能在没有 Electron 的环境（比如单元测试）里复用；② 所有 channel 都堆 main.ts，加到 10 个就开始翻不到底；③ Day 5 的 agent 工具需要"程序内部"调用同一个能力（`readFile / runCommand`），如果只暴露成 IPC，agent 工具就得通过 IPC 自己调自己。

Day 3 起的标准分层：

```text
electron/
  services/<feature>.service.ts   ← 纯函数/纯类，仅依赖 Node 标准库，可单测、可被任意调用方复用
  ipc/<feature>.ipc.ts            ← 极薄包装：把 service 调用挂上 ipcMain.handle
  ipc/index.ts                    ← 唯一聚合入口
  main.ts                         ← 只负责窗口生命周期 + 调 registerIpcHandlers()
```

判断原则：如果一段代码 **不直接** 用到 `ipcMain / BrowserWindow / app`，就属于 service；只做"protocol 翻译"的那层属于 ipc。

### 4.2 Node `fs/promises`：`readdir / stat / readFile`

Node 14+ 提供 `import { ... } from 'fs/promises'`，所有 fs 操作直接返回 Promise，免去 `promisify`：

| API | 签名 | 关键 option |
|---|---|---|
| `readdir(path, opts)` | `Promise<string[]>` 或 `Promise<Dirent[]>` | `withFileTypes: true` 时返回 `Dirent`（有 `.isDirectory() / .isFile()`），**避免**对每个 entry 再做一次 `stat` |
| `stat(path)` | `Promise<Stats>` | `Stats.isDirectory() / .isFile() / .size / .mtime` |
| `readFile(path, encoding)` | `Promise<string \| Buffer>` | 传 `'utf-8'` 拿字符串，不传拿 Buffer |

Day 3 的 `FileSystemService` 同时使用这三个 API。`readdir` 用 `withFileTypes` 一次拿到类型信息，比"先 readdir 再 stat 每一项"在大目录下快约 10 倍。

### 4.3 路径沙箱：`path.relative` 防越界

renderer 通过 IPC 把文件路径传给 main，**这个路径是 renderer 给的**——如果 Day 5 的 agent 被 prompt injection，可能把 `C:\Windows\System32\config\SAM` 当参数送过来。我们**必须**在 service 层挡住这种"越界访问"。标准做法：

```ts
const absolutePath = isAbsolute(target) ? resolve(target) : resolve(workspaceRoot, target)
const rel = relative(workspaceRoot, absolutePath)
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('越界')
```

`path.relative(from, to)` 算出"从 from 走到 to 要写的相对路径"。如果 `to` 在 `from` 外面，结果会以 `..` 开头（Linux/macOS）；Windows 上若跨盘符则返回的是 `to` 的绝对路径——所以同时判断 `startsWith('..')` 与 `isAbsolute(rel)` 才稳。

> **反例对比**：`if (!filePath.startsWith(workspaceRoot)) throw ...` 看似简单实则危险。`workspaceRoot = 'C:\\proj'`，攻击者传 `'C:\\proj\\..\\Windows\\notepad.exe'`——`startsWith` 通过了，但 `resolve` 后逃出工作区。必须先 `resolve` 再 `relative`。

### 4.4 React 受控组件 vs 非受控组件

| | 非受控 | 受控 |
|---|---|---|
| Props | `defaultValue` | `value` + `onChange` |
| 数据源 | DOM 自己持有 | 父组件 / store 持有 |
| 何时用 | 简单表单、不关心实时变化 | 数据要在多处共享（比如 StatusBar 也要看） |

Day 2 Monaco 用了 `defaultValue`——它只在首次挂载时被读，之后即使外部值变了 Monaco 也不会同步。Day 3 我们要"侧边栏点了一个文件 → Monaco 显示这个文件"，必须改成 `value={openFileContent}` 受控。

`@monaco-editor/react` 的受控有个隐藏关键 prop：**`path`**。它告诉组件"现在挂载的是哪个文件"，组件内部用 `path` 作为 Model 的 key——切换 path 时会创建一个新的 Model（保留独立的撤销栈），切回老 path 时复用之前的 Model。如果不传 `path`，所有文件共用同一个 Model，撤销栈会跨文件混在一起。

### 4.5 React 递归组件

文件树天然是递归结构。在 React 里实现递归非常自然：

```tsx
function FileTreeItem({ node, depth }) {
  return <div>
    {node.name}
    {node.children?.map(c => <FileTreeItem node={c} depth={depth+1} />)}
  </div>
}
```

注意三点：
1. **传 `depth` 给子代**——用来算缩进（`paddingLeft: depth * 14`）。
2. **`key` 必须稳定唯一**——本日用 `node.path`（绝对路径全工作区唯一），不要用数组下标（删除一个节点后下标偏移会让 React 错误地复用 DOM）。
3. **`children?.length > 0` 守卫**——叶子节点 children 是 `undefined`，写 `node.children.map(...)` 会崩。

### 4.6 Zustand 多字段 store 与按需选择

Day 2 我们的 store 只有 `isSidebarOpen`。Day 3 加到 5 个字段后，**调用方应当只解构自己用到的字段**：

```ts
const { openFilePath } = useEditorStore()       // ✅ 只这一个字段变化才重渲染
const all = useEditorStore()                    // ⚠️ 任何字段变化都重渲染
```

Zustand 默认对 selector 返回值做引用相等比较；如果直接 `useEditorStore()` 不传 selector，等价于 selector 返回整个 state——任何字段变都触发重渲染。本日所有调用方都按需解构（`StatusBar` 只取 `openFilePath`、`Sidebar` 只取 `setSidebarOpen`），保持渲染面最小。

---

## 5. 编码步骤

### 5.1 步骤 1：更新 `package.json`

#### A. 动机

`package.json` 的 `dependencies` / `devDependencies` 与 Day 2 完全相同——本日不引入新 npm 依赖。仅修改 `name` 与 `description` 标识本日。

#### B. 你将要做的操作

复制 Day 2 的 `package.json`，把 `name` 改成 `my-agent-ide-day3`，`description` 改成 `Day 3: File System Service + File Explorer + Monaco Link`。

#### C. 完整代码

*文件 `package.json`：*

```json
{
  "name": "my-agent-ide-day3",
  "version": "1.0.0",
  "description": "Day 3: File System Service + File Explorer + Monaco Link",
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

仅改字符串。文件树、`Node fs/promises`、`path` 模块都是 Node 内置——不需要新装 npm 包。

> **反例对比**：很多人会先去找 `chokidar / fast-glob / globby` 之类的目录扫描库——对 Day 3 教学而言完全没必要。`fs/promises.readdir({ withFileTypes: true })` + 递归足够覆盖 99% 文件树场景，引入第三方反而增加 bundle 体积与启动时间。

#### E. 立刻验证

```powershell
Set-Location .\GUIDE\day3
npm install
```

`node_modules` 大小与 Day 2 应几乎相同。

---

### 5.2 步骤 2：新增 `electron/services/file-system.service.ts`

#### A. 动机

把"递归扫描目录、读取文本文件、路径沙箱"三件事封装成 `FileSystemService` 类。这个文件**不引用** Electron 的任何 API，意味着它可以：① 在 Node 单测里 `new FileSystemService('/tmp/test-fixture')` 直接跑；② 被 Day 5 的 agent tool（`read-file.tool.ts`）直接 import 复用，绕过 IPC。

#### B. 你将要做的操作

新建 `electron/services/` 目录，在其中新建 `file-system.service.ts`。

#### C. 完整代码

*文件 `electron/services/file-system.service.ts`：*

```ts
import { readdir, readFile, stat } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist'])

export class FileSystemService {
  private readonly workspaceRoot: string

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  async getFileTree(): Promise<FileTreeNode[]> {
    return this.readDirectory(this.workspaceRoot)
  }

  async readTextFile(filePath: string): Promise<string> {
    const absolutePath = this.ensureInsideWorkspace(filePath)
    const fileStat = await stat(absolutePath)

    if (fileStat.isDirectory()) {
      throw new Error('不能读取目录，请选择具体文件。')
    }

    return readFile(absolutePath, 'utf-8')
  }

  private ensureInsideWorkspace(targetPath: string): string {
    const absolutePath = isAbsolute(targetPath)
      ? resolve(targetPath)
      : resolve(this.workspaceRoot, targetPath)

    const rel = relative(this.workspaceRoot, absolutePath)

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('访问路径越出工作区范围。')
    }

    return absolutePath
  }

  private async readDirectory(directoryPath: string): Promise<FileTreeNode[]> {
    const entries = await readdir(directoryPath, { withFileTypes: true })

    const visibleEntries = entries
      .filter((entry) => {
        if (entry.name === '.DS_Store') {
          return false
        }

        if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
          return false
        }

        return true
      })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) {
          return -1
        }

        if (!a.isDirectory() && b.isDirectory()) {
          return 1
        }

        return a.name.localeCompare(b.name)
      })

    const tree: FileTreeNode[] = []

    for (const entry of visibleEntries) {
      const fullPath = resolve(directoryPath, entry.name)
      const relativePath = relative(this.workspaceRoot, fullPath).split(sep).join('/')

      if (entry.isDirectory()) {
        let children: FileTreeNode[] = []

        try {
          children = await this.readDirectory(fullPath)
        } catch {
          // 某些目录可能无权限访问，教学阶段忽略并继续展示其它节点。
          children = []
        }

        tree.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          type: 'directory',
          children
        })
        continue
      }

      tree.push({
        name: entry.name,
        path: fullPath,
        relativePath,
        type: 'file'
      })
    }

    return tree
  }
}
```

#### D. 这段代码做了什么

- **`export interface FileTreeNode`**：树节点的形状契约。`name` 是显示名（"package.json"），`path` 是绝对路径（用作 React `key` + 后续 IPC 调用），`relativePath` 是相对工作区根的 POSIX 路径（用作日志 / 显示），`type` 与 `children` 用判别式区分文件与目录。这个 interface **被两端复用**：service 自己 return 它，renderer 端 `vite-env.d.ts` 重复声明形状一致。
- **`EXCLUDED_DIRECTORIES`**：`Set` 而不是数组——`O(1)` 查找。`out / dist` 是 electron-vite 编译产物，不该让用户在文件树里看到自己改不了的产物文件。
- **`workspaceRoot = process.cwd()`**：默认取 Electron 启动时的当前目录（Day 3 就是 `GUIDE/day3/`）。`resolve(...)` 把它规范化成绝对路径——`process.cwd()` 在 Windows 已经是绝对路径，但在某些被 chdir 过的环境下保险起见统一 resolve 一次。
- **`getFileTree()`**：对外的扫描入口，从根开始递归。
- **`readTextFile(filePath)`**：对外的读文件入口。三步：① 沙箱检查；② `stat` 确认是文件而非目录（直接 `readFile` 一个目录在 Linux 上会抛 EISDIR，在 Windows 上行为不一致——显式检查更稳）；③ utf-8 读取。
- **`ensureInsideWorkspace(targetPath)`**：路径沙箱（§4.3 已展开）。
  - `isAbsolute(target) ? resolve(target) : resolve(workspaceRoot, target)`：允许调用方传"workspace 内的相对路径"或"已经规范化的绝对路径"，在内部统一转成绝对路径。
  - `relative(workspaceRoot, absolutePath)`：算"从 workspaceRoot 到 absolutePath 的相对路径"。如果 absolutePath 在 workspace 内，结果不会以 `..` 开头；越界则以 `..` 开头或返回另一个绝对路径（跨盘符）。
- **`readDirectory(directoryPath)`** 是核心递归。
  - `readdir(path, { withFileTypes: true })`：拿到 `Dirent[]`，每个有 `.name / .isDirectory() / .isFile()`，避免对每项再 `stat`。
  - **过滤**：`.DS_Store`（macOS 系统垃圾）+ 黑名单目录。**注意**只对目录做黑名单匹配，不对文件名匹配——这样如果用户真有个叫 `node_modules.txt` 的文件不会被误删。
  - **排序**：目录优先（VS Code Explorer 默认行为）+ 字典序。`localeCompare` 比 `<` 字符串比较更友好（中文 / 大小写不敏感）。
  - **递归**：对每个子目录调 `await this.readDirectory(fullPath)`。`for...of + await` 而不是 `Promise.all(map(...))` 是教学简化——并发能让大目录快几倍但调试栈更乱，本日选择串行。Day 7+ 文件量大时可以换并发。
  - **`try / catch` 内 `children = []`**：某些目录在 Windows 下没有读权限（System Volume Information 等），递归到那里会抛 EPERM。教学阶段我们吞掉错误展示空目录，避免一处 EPERM 让整棵树挂掉。生产环境应当 log 或上报。
  - **`relativePath = relative(...).split(sep).join('/')`**：把 Windows 的 `\` 分隔符规范化成 POSIX `/`，方便 UI / 日志展示统一。

> **反例对比 1**：如果不在 service 层做沙箱，Day 5 agent 工具被 prompt 注入 `read_file('C:\\Windows\\System32\\config\\SAM')`，IPC 直接放行。沙箱写在 service 层意味着无论调用方是 IPC 还是 agent tool 都被同一道门管住。**安全检查永远写在最靠近资源的那一层**。

> **反例对比 2**：把 `readDirectory` 写成 `Promise.all(entries.map(async e => ...))` 并发递归——大目录扫描能从 800 ms 降到 80 ms，但当遇到 EPERM 时所有未完成的 Promise 都会被 `Promise.all` 取消语义打乱，错误堆栈跨多个目录纠缠在一起。教学日志选可读性 > 性能。

#### E. 立刻验证

本步骤不能独立验证（还没接入 IPC）。可在编辑器里看到 TS 没有报错即可。

---

### 5.3 步骤 3：新增 `electron/ipc/file-system.ipc.ts`

#### A. 动机

把 `FileSystemService` 的两个方法分别包装成 IPC channel。这一层**只做协议翻译**——不写任何业务判断，业务逻辑 100% 在 service 层。

#### B. 你将要做的操作

新建 `electron/ipc/` 目录，在其中新建 `file-system.ipc.ts`。

#### C. 完整代码

*文件 `electron/ipc/file-system.ipc.ts`：*

```ts
import { ipcMain } from 'electron'
import { FileSystemService } from '../services/file-system.service'

const fileSystemService = new FileSystemService()

export function registerFileSystemIpcHandlers(): void {
  ipcMain.removeHandler('file-system:get-tree')
  ipcMain.removeHandler('file-system:read-file')

  ipcMain.handle('file-system:get-tree', async () => {
    const tree = await fileSystemService.getFileTree()

    return {
      workspaceRoot: fileSystemService.getWorkspaceRoot(),
      tree
    }
  })

  ipcMain.handle('file-system:read-file', async (_event, filePath: string) => {
    return fileSystemService.readTextFile(filePath)
  })
}
```

#### D. 这段代码做了什么

- **模块级 `const fileSystemService = new FileSystemService()`**：service 是无状态的（除 `workspaceRoot` 外），单例化即可，避免每次 IPC 调用都 new 一次。
- **`registerFileSystemIpcHandlers()`** 是导出的统一入口。`ipc/index.ts` 会调它。
- **`ipcMain.removeHandler(channel)` 在注册前先清一次**：electron-vite 在开发模式下会"热重启"主进程（`Ctrl+R` 或保存时）——主进程脚本会重新执行整个文件，`ipcMain.handle` 第二次执行同一 channel 会抛 `Attempted to register a second handler for ...`。先 `removeHandler` 再 `handle` 让脚本可以幂等执行。`removeHandler` 即使 channel 没注册过也不会抛错，安全。
- **`get-tree` handler**：调 service 拿树，再把 `workspaceRoot` 一并打包返回——renderer 需要在 EXPLORER 标题位置显示路径，与树本身一次拿到避免再 invoke 一次。
- **`read-file` handler**：第一个参数是 `IpcMainInvokeEvent`（本日没用），第二个开始才是 renderer `invoke('file-system:read-file', filePath)` 传过来的参数。直接 `return service.readTextFile(filePath)`——如果 service 抛错，错误对象会被 Electron 序列化（结构化克隆 `Error` 的 `message / stack`）穿回 renderer，renderer 的 `await window.api.readFile(...)` 处会触发 catch。

> **反例对比**：如果 ipc 层做"参数校验"——例如 `if (!filePath) return { error: '...' }`——那校验逻辑跨 ipc / service 两处写。**校验和业务一起走 service**，ipc 层永远只做协议翻译。

#### E. 立刻验证

无法独立验证。

---

### 5.4 步骤 4：新增 `electron/ipc/terminal.ipc.ts`

#### A. 动机

把 Day 2 内联在 `main.ts` 里的终端 handler **原样**搬到独立模块。除了搬位置 + 加 `removeHandler` + 改函数名外，逻辑零变化。

#### B. 你将要做的操作

新建 `electron/ipc/terminal.ipc.ts`。

#### C. 完整代码

*文件 `electron/ipc/terminal.ipc.ts`：*

```ts
import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export function registerTerminalIpcHandlers(): void {
  // 防止开发期热重载时重复注册同一通道。
  ipcMain.removeHandler('terminal:run-command')

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
}
```

#### D. 这段代码做了什么

- 整段逻辑与 Day 2 §5.2 的 `ipcMain.handle('terminal:run-command', ...)` **完全一致**——只是从 `main.ts` 内联块抽成独立函数，并加了 `removeHandler` 让模块支持热重启。
- **没有 service 层吗？** 终端命令本质就一行 `execAsync`，业务逻辑不足以独立拆。**当未来需要"命令历史 / 命令白名单 / cwd 管理"时**就该拆 `terminal.service.ts`——本项目实际在 Day 7+ 引入持久化时才拆。"按需拆分"比"为拆而拆"更重要。

> **反例对比**：如果坚持 Day 3 就建一个空壳 `TerminalService { runCommand() }`，多写 30 行代码、一层无意义跳转，加重读者负担。**抽象的合理时机是"出现重复 / 出现复杂状态"**——不是日历提示。

#### E. 立刻验证

无法独立验证。

---

### 5.5 步骤 5：新增 `electron/ipc/index.ts`

#### A. 动机

聚合所有 feature 模块的注册函数。`main.ts` 只 import 这一个文件，未来 Day 4 加 `agent.ipc.ts`、Day 7 加 `git.ipc.ts` 都只要在这里多加一行 import + 一行调用。

#### B. 你将要做的操作

新建 `electron/ipc/index.ts`。

#### C. 完整代码

*文件 `electron/ipc/index.ts`：*

```ts
import { registerFileSystemIpcHandlers } from './file-system.ipc'
import { registerTerminalIpcHandlers } from './terminal.ipc'

export function registerIpcHandlers(): void {
  registerTerminalIpcHandlers()
  registerFileSystemIpcHandlers()
}
```

#### D. 这段代码做了什么

- 极薄聚合层。两行 import + 两行调用。
- **顺序无关**：每个 channel 注册到独立的 string，互不干扰。如果未来某个 feature 在初始化时要用前一个 feature 的能力，就把那两行调换。

> **反例对比**：很多教程会写一个"IPC 注册器框架"——把所有模块写成 `IpcModule[]`，遍历 `module.register()`。对 4 个 feature 来说这种抽象是**纯负担**——直接把名字硬编码反而看 5 秒就懂。**先写最朴素版，3 次重复后再抽象**。

#### E. 立刻验证

无。

---

### 5.6 步骤 6：修改 `electron/main.ts`

#### A. 动机

把 Day 2 内联的 `ipcMain.handle('terminal:run-command', ...)` 删掉，换成一行 `registerIpcHandlers()`。剩余窗口生命周期代码 100% 不变。

#### B. 你将要做的操作

打开 `electron/main.ts`：① 删除 `import { ipcMain } from 'electron'` 中的 `ipcMain`、删除 `import { exec } from 'child_process'` 与 `import { promisify } from 'util'`、删除 `const execAsync = promisify(exec)`；② 在 import 区追加 `import { registerIpcHandlers } from './ipc'`；③ 在 `app.whenReady().then(...)` 内 `createWindow()` 之前把整个 `ipcMain.handle('terminal:run-command', ...)` 块替换成 `registerIpcHandlers()`。

#### C. 完整代码

*文件 `electron/main.ts`：*

```ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'

function createWindow(): void {
  // 创建主窗口：Day 3 在 Day 2 基础上继续扩展文件系统能力。
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

  // 教学阶段默认打开开发者工具，便于观察运行状态。
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

  // Day 3: 统一注册终端与文件系统 IPC 能力。
  registerIpcHandlers()

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

- import 区被瘦身：去掉 `ipcMain / exec / promisify`，只多一个 `registerIpcHandlers`。
- `app.whenReady().then(...)` 内本来 25 行的 `ipcMain.handle(...)` 块被一行 `registerIpcHandlers()` 取代。**main.ts 现在再也看不到任何业务字符串**（'terminal:run-command' / exec / 命令字段名），未来加 100 个 channel 这文件也不会再变。
- 调用顺序：`setAppUserModelId → browser-window-created 监听 → registerIpcHandlers → createWindow`。`registerIpcHandlers` 必须在 `createWindow` **之前**——窗口加载 renderer 后，preload 几十毫秒内就会触发 `getFileTree` invoke，handler 必须先备好。

> **反例对比**：曾经看过一种"IPC 注册放进 createWindow 里"的写法——多窗口下每开一个窗口就重新 `ipcMain.handle`，第二次会抛 second handler 错。`ipcMain.handle` **是进程级单例**，必须独立于 BrowserWindow 生命周期、只在 ready 后注册一次。

#### E. 立刻验证

`npm run dev` 应能正常启动，主进程 console 不报错。如果报 `Attempted to register a second handler` 表明开发期热重启循环——但我们在每个 `register*IpcHandlers()` 内已加 `removeHandler` 守卫，应该不会触发。

---

### 5.7 步骤 7：修改 `electron/preload.ts`

#### A. 动机

把"业务 API"层多挂两个方法：`getFileTree` 与 `readFile`。renderer 端就能 `await window.api.getFileTree()` / `await window.api.readFile(path)`。

#### B. 你将要做的操作

在 `const api = { runCommand: ... }` 对象里追加两个新方法。其余结构（`contextIsolated` 分支、`exposeInMainWorld`）保持不变。

#### C. 完整代码

*文件 `electron/preload.ts`：*

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Day 3: 在终端能力基础上，新增文件树与读文件 API。
const api = {
  runCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command),
  getFileTree: () => ipcRenderer.invoke('file-system:get-tree'),
  readFile: (filePath: string) => ipcRenderer.invoke('file-system:read-file', filePath)
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

- `getFileTree: () => ipcRenderer.invoke('file-system:get-tree')`：无参数，返回 `Promise<{ workspaceRoot, tree }>`。
- `readFile: (filePath: string) => ipcRenderer.invoke('file-system:read-file', filePath)`：单参，返回 `Promise<string>`。
- channel 字符串 `'file-system:get-tree' / 'file-system:read-file'` **必须**与步骤 3 ipc 层完全一致——拼写错就 invoke 找不到 handler 报错。把 channel 名集中在 ipc 与 preload 两处，未来 Day 8 会把它们提取成 `shared/ipc-channels.ts` 常量避免对照。本日为简化保持字符串硬编码。

> **反例对比**：在 preload 里临时做参数校验（`if (!filePath) throw ...`）——把校验拆到两端会出现"双重校验且偶尔不一致"的隐患。preload 只做最薄包装；校验全在 service 内。

#### E. 立刻验证

`npm run dev` 后 DevTools console 输入：

```js
await window.api.getFileTree()
```

应返回 `{ workspaceRoot: 'D:\\...\\day3', tree: [...] }`。

---

### 5.8 步骤 8：修改 `src/vite-env.d.ts`

#### A. 动机

renderer 端要用 `FileTreeNode` 类型（在 `FileExplorer / FileTreeItem` 的 props 与 state 里），但不能直接 import service 的 `.ts` 文件——renderer 与 main 是两套 TypeScript 项目（`tsconfig.web.json` vs `tsconfig.node.json`），不允许跨边界 import。我们在 `vite-env.d.ts` 里用 **同样形状** 重新声明这些 interface。Day 8 的设计系统升级会引入 `shared/types/` 真共享一份 `.d.ts`；本日先用"双声明"的简化办法。

#### B. 你将要做的操作

在 Day 2 的 `vite-env.d.ts` 上追加 `FileTreeNode`、`WorkspaceTreeResult`，并往 `RendererApi` 里加两个方法签名。

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

interface RendererApi {
	runCommand: (command: string) => Promise<TerminalCommandResult>
	getFileTree: () => Promise<WorkspaceTreeResult>
	readFile: (filePath: string) => Promise<string>
}

declare global {
	interface Window {
		api: RendererApi
	}
}
```

#### D. 这段代码做了什么

- `FileTreeNode` 是**全局类型**（这个 `.d.ts` 没 `import / export`，整个文件是脚本风格，所有顶层声明进入全局命名空间）。renderer 端任意 `.tsx` 不需要 `import { FileTreeNode } ...` 就能用。
- `WorkspaceTreeResult` 与 `getFileTree` 的返回值绑定。
- `RendererApi` 多两个方法。`getFileTree` 无参；`readFile` 单参 `filePath: string` 返回 `Promise<string>`——与 service 的 `readTextFile` 签名一致。
- **形状必须与 service 端一致**。Day 5 的 agent 工具会用同一个 `FileTreeNode` 类型（在 main 端从 service `import { FileTreeNode }`），形状不同会立刻在 `Type 'X' is not assignable to type 'Y'` 报错——这正是双声明带来的好处：编译器帮我们盯住一致性。

> **反例对比**：把 `FileTreeNode` 写成 `any` / 不写——renderer 里 `node.path / node.children` 全是 `any`，IDE 没有自动补全，手滑写 `node.paht` 不报错。**类型即文档**，前后端契约必须显式。

#### E. 立刻验证

保存后 IDE 里 `window.api.` 自动补全应弹出 `runCommand / getFileTree / readFile`。

---

### 5.9 步骤 9：修改 `src/stores/editor.store.ts`

#### A. 动机

把"当前打开文件"提升为全局状态，让 MonacoWrapper、StatusBar、未来 Day 4+ 的多个组件都能订阅。Zustand 的简洁性在多字段下尤其明显。

#### B. 你将要做的操作

在 `EditorState` interface 加 `openFilePath / openFileContent` 两个字段 + `setOpenFile / setOpenFileContent` 两个 setter。

#### C. 完整代码

*文件 `src/stores/editor.store.ts`：*

```ts
import { create } from 'zustand'

// 定义编辑器 UI 相关的最小全局状态结构。
interface EditorState {
  isSidebarOpen: boolean
  openFilePath: string | null
  openFileContent: string
  setSidebarOpen: (open: boolean) => void
  setOpenFile: (filePath: string, content: string) => void
  setOpenFileContent: (content: string) => void
}

// Day 3: 在 UI 状态基础上增加"当前打开文件"的路径与内容。
export const useEditorStore = create<EditorState>((set) => ({
  isSidebarOpen: true,
  openFilePath: null,
  openFileContent: '',
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  setOpenFile: (filePath, content) =>
    set({
      openFilePath: filePath,
      openFileContent: content
    }),
  setOpenFileContent: (content) => set({ openFileContent: content })
}))
```

#### D. 这段代码做了什么

- `openFilePath: string | null`：null 表示"什么也没打开"——MonacoWrapper 据此显示欢迎文字。
- `openFileContent: string`：当前编辑器里的文本。**注意**它既会被 FileExplorer 的"打开文件" 写、也会被 Monaco 的 `onChange` 写——两个写源共用一个字段，Day 4 才区分"持久化版本 vs 草稿版本"。
- `setOpenFile(filePath, content)`：原子设置两个字段。FileExplorer 在文件读到内容后调一次。
- `setOpenFileContent(content)`：仅更新内容（用户在 Monaco 内打字）。
- 整个 store 仍然是 ~15 行，体现 Zustand 的轻量。React Context + useReducer 写同样功能至少 50 行。

> **反例对比**：把 `setOpenFile` 拆成两次 `set`——用户点文件那一刻会出现"`openFilePath` 已变但 `openFileContent` 还是上一个文件"的中间态，Monaco 重渲染时会用新 path + 旧 content，闪一帧错位。一次 `set({ ...两个字段 })` 才是原子的。

#### E. 立刻验证

无。

---

### 5.10 步骤 10：新增 `src/components/file-explorer/FileTreeItem.tsx`

#### A. 动机

文件树叶子组件——**自身递归**渲染整棵树。叶子设计目标：① 不依赖 store（纯 props，复用性最高）；② 自管理"展开 / 折叠" UI 状态；③ 通过回调把"打开文件"上抛给父组件。

#### B. 你将要做的操作

新建 `src/components/file-explorer/` 目录，在其中新建 `FileTreeItem.tsx`。

#### C. 完整代码

*文件 `src/components/file-explorer/FileTreeItem.tsx`：*

```tsx
import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'

interface FileTreeItemProps {
  node: FileTreeNode
  depth: number
  activeFilePath: string | null
  onOpenFile: (node: FileTreeNode) => void
}

export default function FileTreeItem({
  node,
  depth,
  activeFilePath,
  onOpenFile
}: FileTreeItemProps) {
  const [isExpanded, setExpanded] = useState(depth === 0)
  const isDirectory = node.type === 'directory'
  const isActive = node.type === 'file' && node.path === activeFilePath

  const handleClick = () => {
    if (isDirectory) {
      setExpanded((prev) => !prev)
      return
    }

    onOpenFile(node)
  }

  return (
    <div>
      <button
        onClick={handleClick}
        className={`w-full flex items-center gap-1 rounded px-2 py-1 text-left text-sm cursor-pointer ${
          isActive ? 'bg-blue-600 text-white' : 'hover:bg-[#2a2d2e] text-foreground'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )
        ) : (
          <span className="w-[14px] shrink-0" />
        )}

        {isDirectory ? (
          isExpanded ? (
            <FolderOpen size={14} className="shrink-0" />
          ) : (
            <Folder size={14} className="shrink-0" />
          )
        ) : (
          <FileText size={14} className="shrink-0" />
        )}

        <span className="truncate">{node.name}</span>
      </button>

      {isDirectory && isExpanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((childNode) => (
            <FileTreeItem
              key={childNode.path}
              node={childNode}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
```

#### D. 这段代码做了什么

- **Props**：4 个。`node` 是当前节点；`depth` 决定缩进；`activeFilePath` 用于高亮当前打开文件；`onOpenFile` 是上抛回调。**不接收 store**——保持纯组件特性。
- **`useState(depth === 0)`**：默认行为是"根目录展开，子目录折叠"——根的 `depth = 0`。这是 VS Code Explorer 的默认行为。
- **`isActive = node.type === 'file' && node.path === activeFilePath`**：精确匹配文件路径才高亮，目录不被高亮。
- **`handleClick`**：目录 → 切换展开；文件 → 上抛 `onOpenFile(node)`。
- **DOM 结构**：外层 `<div>` + `<button>`（一行）+ 条件渲染的 `<div>`（子节点列表）。`<button>` 而不是 `<div onClick>`：键盘可达 + 屏幕阅读器友好。
- **`paddingLeft: depth * 14 + 8`**：每层缩进 14 px，根层有 8 px 左 padding。**用 inline style 而不是 Tailwind class**——因为 depth 是动态值，Tailwind 的 JIT 不知道编译多少层 `pl-*`。
- **图标：** 折叠态用 `ChevronRight + Folder`，展开态用 `ChevronDown + FolderOpen`，文件用 `FileText`。文件那一栏的 `<span className="w-[14px] />`（占位空 span）替换了"折叠箭头"——保证文件名与目录名垂直对齐。
- **`<span className="truncate">`**：文件名超出容器宽度时显示省略号。
- **递归：** 目录 + 展开 + 有子节点时渲染 `<div>` 包一层 `node.children.map(child => <FileTreeItem ...>)`。`key={childNode.path}` 用绝对路径——全局唯一稳定。
- **回调透传**：`activeFilePath` 与 `onOpenFile` 一路传给所有后代——这是受控树的标准模式。**不要**让 FileTreeItem 自己 import store——递归组件订阅 store 会让"任意节点变化"触发"所有节点"重渲染（性能灾难）。

> **反例对比 1**：`key={index}` 使用数组下标——文件树的目录 children 顺序是相对稳定的，但当 `loadTree()` 重建后顺序可能变（删了一个文件）。下标 key 会让 React 错误地把 DOM 节点"对应"到不同的 node 上，导致展开状态错乱（你展开了 `src/`，刷新后变成 `src/components/`是展开的）。**始终用数据本身的稳定 ID 作 key**。

> **反例对比 2**：把 `useState(depth === 0)` 写成 `useState(false)`——所有节点初始全折叠，连根都要点击才展开，体验糟。`depth === 0` 这种"初始化时按 props 决定"的写法是 React 标准模式，不是反模式（注意：之后 props 变化不会触发重置，这正是我们要的"用户展开后保持"）。

#### E. 立刻验证

无。

---

### 5.11 步骤 11：新增 `src/components/file-explorer/FileExplorer.tsx`

#### A. 动机

文件树容器组件——负责：① 调 IPC 加载树；② 处理 loading / error / empty 三种 UI 状态；③ 提供刷新按钮；④ 接收 FileTreeItem 上抛的 `onOpenFile` 调用 IPC 读文件、写入 store。

#### B. 你将要做的操作

新建 `src/components/file-explorer/FileExplorer.tsx`。

#### C. 完整代码

*文件 `src/components/file-explorer/FileExplorer.tsx`：*

```tsx
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import FileTreeItem from './FileTreeItem'
import { useEditorStore } from '../../stores/editor.store'

export default function FileExplorer() {
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [treeNodes, setTreeNodes] = useState<FileTreeNode[]>([])
  const [isLoading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { openFilePath, setOpenFile } = useEditorStore()

  const loadTree = async () => {
    setLoading(true)
    setErrorMessage(null)

    try {
      const result = await window.api.getFileTree()
      setWorkspaceRoot(result.workspaceRoot)
      setTreeNodes(result.tree)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件树失败。'
      setErrorMessage(message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenFile = async (node: FileTreeNode) => {
    if (node.type !== 'file') {
      return
    }

    try {
      const content = await window.api.readFile(node.path)
      setOpenFile(node.path, content)
      setErrorMessage(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件内容失败。'
      setErrorMessage(message)
    }
  }

  useEffect(() => {
    void loadTree()
  }, [])

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <span className="text-xs text-gray-400 truncate" title={workspaceRoot}>
          {workspaceRoot || 'Loading workspace...'}
        </span>
        <button
          onClick={() => {
            void loadTree()
          }}
          className="p-1 text-gray-400 hover:text-white cursor-pointer"
          title="刷新文件树"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && <p className="text-xs text-gray-500">正在加载文件树…</p>}

        {!isLoading && errorMessage && <p className="text-xs text-red-400 whitespace-pre-wrap">{errorMessage}</p>}

        {!isLoading && !errorMessage && treeNodes.length === 0 && (
          <p className="text-xs text-gray-500">当前目录没有可显示文件。</p>
        )}

        {!isLoading && !errorMessage && treeNodes.length > 0 && (
          <div className="space-y-0.5">
            {treeNodes.map((node) => (
              <FileTreeItem
                key={node.path}
                node={node}
                depth={0}
                activeFilePath={openFilePath}
                onOpenFile={handleOpenFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

#### D. 这段代码做了什么

- **4 个本地 state**：`workspaceRoot`、`treeNodes`、`isLoading`、`errorMessage`。这些状态只 FileExplorer 自己用，**不放 store**——遵循 "只把跨组件需要的状态提升到全局" 原则。
- **`useEditorStore` 只解构两个字段**：`openFilePath`（传给 FileTreeItem 高亮）+ `setOpenFile`（点击文件后调用）。Zustand 此时只在这两个字段变时重渲染本组件。
- **`loadTree`** 三步：set loading → try invoke → finally clear loading。**一定要 try/catch**——主进程那边如果 `process.cwd()` 在某些环境抛错，未捕获的 IPC 异常会导致 React 整棵子树挂掉。把错误吃下来挂到 `errorMessage` UI 上才稳。
- **`handleOpenFile`**：注意 **类型守卫** `if (node.type !== 'file') return`——理论上 FileTreeItem 已经只在文件 onClick 才调，但**TypeScript 类型系统不能保证回调调用方**。多一行守卫零成本，挡住 Day 5 工具调用 / Day 7 命令面板等其它调用点。
- **`useEffect(() => { void loadTree() }, [])`**：空依赖只执行一次（StrictMode 下会双调用，但 loadTree 是幂等的，只是多请求一次没副作用）。`void` 标注让 ESLint 不报"floating promise"——effect 回调本身不能是 async（React 要求返回 cleanup 函数或 undefined，不能是 Promise）。
- **三态 UI**：loading → error → empty → tree。优先级从上到下，写成连续的条件渲染避免 nested ternary 的可读性灾难。
- **`<p whitespace-pre-wrap>`**：错误信息可能多行（service 的栈），保留换行。
- **`title={workspaceRoot}`**：路径太长被 `truncate` 截断时，鼠标 hover 显示完整路径。
- **`space-y-0.5`**：Tailwind 工具类，给 children 之间加 0.125 rem 垂直间距，避免节点贴在一起。

> **反例对比**：在 `loadTree` 里把 `setLoading(true)` 写在 try 内、忘了 finally——抛错时 loading 永远卡在 true，UI 永远是"正在加载..."。`finally setLoading(false)` 是异步加载组件的标配模式。

#### E. 立刻验证

`npm run dev` 应当能看到侧边栏出现工作目录路径 + 文件树。如果只显示 `Loading workspace...` 不动，DevTools 看 console 是否有 `No handler registered` 类错误。

---

### 5.12 步骤 12：修改 `src/components/layout/Sidebar.tsx`

#### A. 动机

把 Day 1 / Day 2 的占位文字（"File Tree Will Be Here"）换成真实的 `<FileExplorer />`。

#### B. 你将要做的操作

替换 Sidebar 的内容区域。保留标题栏与关闭按钮。

#### C. 完整代码

*文件 `src/components/layout/Sidebar.tsx`：*

```tsx
import { useEditorStore } from '../../stores/editor.store'
import { FolderTree, X } from 'lucide-react'
import FileExplorer from '../file-explorer/FileExplorer'

export default function Sidebar() {
  // 仅取出写操作函数，避免不必要状态订阅。
  const { setSidebarOpen } = useEditorStore()

  return (
    <div className="h-full bg-surface border-r border-border flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between uppercase text-xs font-semibold text-gray-400 border-b border-border">
        <span className="flex items-center"><FolderTree size={14} className="mr-2" />Explorer</span>
        {/* 关闭按钮将触发全局状态更新，从而让侧边栏整体卸载。 */}
        <button onClick={() => setSidebarOpen(false)} className="hover:text-white cursor-pointer"><X size={14} /></button>
      </div>
      <div className="flex-1 min-h-0">
        <FileExplorer />
      </div>
    </div>
  )
}
```

#### D. 这段代码做了什么

- 增加 `import FileExplorer ...` 与 `<FileExplorer />` 替换原占位。
- **`min-h-0`** 是关键 Tailwind 类：flex 子项默认 `min-height: auto`（即"内容多大就多大"），导致内部 `overflow-y-auto` 不生效。强制 `min-height: 0` 后，`flex-1` 才能真正限制高度让滚动条出现。
- 仅解构 `setSidebarOpen` ——本组件不需要读 `isSidebarOpen`（读它的是父组件 AppLayout）。

> **反例对比**：忘了 `min-h-0` —— FileExplorer 的 `overflow-y-auto` 区域会无限撑高，整个侧边栏被推得超出父容器，反而触发外层的滚动条，文件树滚不到底。Tailwind + flex 的经典坑。

#### E. 立刻验证

侧边栏 Explorer 区域应当出现工作目录与文件树。

---

### 5.13 步骤 13：修改 `src/components/editor/MonacoWrapper.tsx`

#### A. 动机

把 Day 2 的非受控、固定 hello 内容改成"受控 + 跟随 store"。新增按扩展名切语言的小工具函数。

#### B. 你将要做的操作

整文件重写。

#### C. 完整代码

*文件 `src/components/editor/MonacoWrapper.tsx`：*

```tsx
import { useMemo } from 'react'
import Editor from '@monaco-editor/react'
import { useEditorStore } from '../../stores/editor.store'

const EMPTY_EDITOR_TEXT = `// Day 3
// 请从左侧文件树点击一个文件，内容会显示在这里。
`

function getLanguageByFilePath(filePath: string | null): string {
  if (!filePath) {
    return 'typescript'
  }

  const ext = filePath.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'ts':
      return 'typescript'
    case 'tsx':
      return 'typescript'
    case 'js':
      return 'javascript'
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

export default function MonacoWrapper() {
  const { openFilePath, openFileContent, setOpenFileContent } = useEditorStore()

  const editorLanguage = useMemo(() => getLanguageByFilePath(openFilePath), [openFilePath])

  const displayValue = openFilePath ? openFileContent : EMPTY_EDITOR_TEXT

  return (
    <Editor
      height="100%"
      path={openFilePath ?? 'day3-welcome.ts'}
      language={editorLanguage}
      value={displayValue}
      onChange={(value) => {
        if (openFilePath) {
          setOpenFileContent(value ?? '')
        }
      }}
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

- **`getLanguageByFilePath`**：纯函数，按扩展名映射 Monaco 的 language 标识。`tsx` 用 `'typescript'`（Monaco 没有独立 `tsx` 模式，用 ts 高亮已能覆盖 JSX），`md` → `'markdown'`，`yml/yaml` → `'yaml'`。其它默认 `plaintext`。
- **`useMemo([openFilePath])`**：避免每次渲染都重算（虽然函数极快，习惯保持 hook 化以防未来扩展成更重的逻辑）。
- **`displayValue`**：有文件时显示 store 内容，否则显示欢迎语。**不直接改 store**——欢迎语是 UI 的事，不该污染 store。
- **`<Editor>` props 关键变化**：
  - `path={openFilePath ?? 'day3-welcome.ts'}`：受控 Model key（§4.4）。无文件时给个虚拟路径，让 Monaco 把欢迎文本视作一个 ts 文件，得到合理的语法高亮。
  - `language={editorLanguage}`：动态语言切换。注意一旦 `path` 变化，Monaco 会创建新 Model，`language` 会按新 Model 的设置；这里同时传两者保险。
  - `value={displayValue}`：受控值。Monaco 内部会比较新 value 与当前 Model 内容，不同就 setValue。
  - `onChange={(value) => { if (openFilePath) setOpenFileContent(value ?? '') }}`：用户键入时把变化写回 store。**只在有打开文件时写**——不让用户编辑欢迎语污染 store。
  - `value` 可能是 `string | undefined`（Monaco 类型如此），`?? ''` 兜底。
- **没有 `defaultValue`**：受控组件不要混传 default*——会被 Monaco 警告。

> **反例对比 1**：保留 `defaultValue` + 加 `value` —— Monaco 会警告 "controlled / uncontrolled" 切换问题，且首次渲染显示 defaultValue 一帧后才被 value 覆盖，闪烁。

> **反例对比 2**：把 `path` 写死 / 不传 —— 切换文件时所有文件共享同一个 Model，撤销栈混在一起，按 Ctrl+Z 能撤销到上一个文件的内容。

#### E. 立刻验证

点侧边栏的 `package.json` → 编辑器右下角语言指示变 JSON、内容显示 JSON。点 `MonacoWrapper.tsx` → 变 TypeScript。

---

### 5.14 步骤 14：修改 `src/components/layout/StatusBar.tsx`

#### A. 动机

让用户随时知道"我现在在编辑哪个文件"。`useMemo` 仅做字符串切片，写在 hook 里养成习惯。

#### B. 你将要做的操作

整文件重写。

#### C. 完整代码

*文件 `src/components/layout/StatusBar.tsx`：*

```tsx
import { useMemo } from 'react'
import { useEditorStore } from '../../stores/editor.store'

export default function StatusBar() {
  const { openFilePath } = useEditorStore()

  const fileLabel = useMemo(() => {
    if (!openFilePath) {
      return 'No file opened'
    }

    const parts = openFilePath.split(/[/\\]/)
    return `Opened: ${parts[parts.length - 1]}`
  }, [openFilePath])

  return (
    // Day 3 状态栏增加当前文件显示，便于观察文件树联动效果。
    <div className="h-6 bg-blue-600 text-white text-xs flex items-center px-4 shrink-0 transition-colors">
      <span className="font-semibold">Day 3 File System</span>
      <span className="mx-4 opacity-50">|</span>
      <span>{fileLabel}</span>
    </div>
  )
}
```

#### D. 这段代码做了什么

- 解构 `openFilePath` 一个字段——StatusBar 只在该字段变时重渲染。
- **`split(/[/\\]/)`**：同时按 `/` 与 `\` 分割，兼容 Windows / POSIX 路径。`\\` 在正则字面量里要写 `\\\\`？不需要——`[\\]` 字符类内单个 `\\` 转义为 `\` 即可。
- 取 `parts[parts.length - 1]` 拿到 basename。Node 的 `path.basename` 在 renderer 端用不上（renderer 不能 import `path`）。

> **反例对比**：用 `openFilePath.split('/').pop()` —— Windows 路径全是反斜杠，拿到的就是整个路径，没法显示 basename。

#### E. 立刻验证

无打开文件时显示 `No file opened`；点击文件后变 `Opened: <文件名>`。

---

### 5.15 步骤 15：修改 `src/components/terminal/TerminalInstance.tsx`

#### A. 动机

仅把欢迎语 `'Day 2 Terminal Ready'` 改成 `'Day 3 Terminal Ready'`。代码其余部分**逐字符不变**，避免引入 Day 3 不必要的修改。

#### B. 你将要做的操作

打开 `TerminalInstance.tsx`，在 `terminal.writeln('Day 2 Terminal Ready')` 把 2 改成 3。

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

    terminal.writeln('Day 3 Terminal Ready')
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

仅修改一处字符串："Day 2" → "Day 3"。**故意保持其它所有代码不变**——演示"日历推进 ≠ 必须重写已有功能"。`window.api.runCommand` 这个 API 在步骤 7 没动它，仍然可用。

> **反例对比**：每天都把已稳定的代码再"优化"一遍——读者无法识别"今天真正学到的新概念是什么"。**Day 3 的注意力应当集中在 service+ipc 分层 + 文件树**，TerminalInstance 不动是正确的。

#### E. 立刻验证

启动后终端显示 "Day 3 Terminal Ready"。

---

## 6. 端到端串联走查

以「在文件树点击 `package.json`」这条操作为例，跨 7 个跳转点追一次：

| 跳转 | 文件 / 位置 | 关键代码 |
|---|---|---|
| ① 点击事件 | `FileTreeItem.tsx` :: `<button onClick={handleClick}>` | `handleClick` → `node.type === 'file'` → `onOpenFile(node)` |
| ② 上抛回调 | `FileTreeItem` 的 props.onOpenFile | 从根 `FileExplorer` 一路传下来 |
| ③ 容器处理 | `FileExplorer.tsx` :: `handleOpenFile(node)` | 类型守卫 → `await window.api.readFile(node.path)` |
| ④ preload 桥接 | `electron/preload.ts` :: `readFile: (filePath) => ipcRenderer.invoke('file-system:read-file', filePath)` | invoke 跨进程 |
| ⑤ ipc 接收 | `electron/ipc/file-system.ipc.ts` :: `ipcMain.handle('file-system:read-file', ...)` | `return fileSystemService.readTextFile(filePath)` |
| ⑥ service 执行 | `electron/services/file-system.service.ts` :: `readTextFile` | `ensureInsideWorkspace` → `stat` → `readFile(path, 'utf-8')` |
| ⑦ 写回 store + 渲染 | renderer 端：FileExplorer `setOpenFile(node.path, content)` → MonacoWrapper 订阅 store 重渲染 → `<Editor value=...>` 触发 Monaco setValue | StatusBar 也因 `openFilePath` 变化重渲染显示文件名 |

**两个独立 IPC 回路**（启动时的 `getFileTree` + 点击时的 `readFile`）共享同一套 service / preload / 类型契约——本日的架构投资让 Day 4-8 的"加新能力"成本压到最低。

---

## 7. 完整运行流程追踪

`npm install && npm run dev` 后内部时序（在 Day 2 基础上叠加）：

1. **TS 编译阶段**：electron-vite 多了 4 个新 `.ts` 文件（services/file-system.service.ts、ipc/* 三个）需要被 esbuild 转 CJS 放进 `out/main/`。renderer 端多了 2 个新 `.tsx` 文件（FileExplorer、FileTreeItem）被 Vite 处理。
2. **主进程冷启动**：与 Day 2 相同直到 `app.whenReady`。`registerIpcHandlers()` 顺序执行 `registerTerminalIpcHandlers()` → `registerFileSystemIpcHandlers()`。两次都先 `removeHandler`（首次启动 channel 不存在，安全无副作用）再 `handle` 注册。`new FileSystemService()` 在 `file-system.ipc.ts` 模块顶层执行——`process.cwd()` 此时已是 `GUIDE/day3/`。
3. **renderer 启动**：React StrictMode → AppLayout → Sidebar → FileExplorer 挂载。
4. **首次树加载**：FileExplorer 的 `useEffect([])` 触发 `loadTree` → `window.api.getFileTree()` → IPC 跨进程到 main → `FileSystemService.getFileTree` 递归扫描整个工作区（典型耗时 50~200 ms，取决于工作区文件数）→ 结果序列化回 renderer → `setTreeNodes` → React 重渲染挂载所有 FileTreeItem。
5. **首次文件打开**：用户点击文件 → handleOpenFile → IPC `readFile` → service `readTextFile`：①`ensureInsideWorkspace` < 1 ms；② `stat` ~1 ms；③ `readFile utf-8` 取决于文件大小（package.json 几 KB → < 5 ms）→ 字符串穿回 renderer → `setOpenFile` → store 通知所有订阅者（MonacoWrapper、StatusBar）重渲染 → MonacoWrapper 把 value 推给 Monaco editor → Monaco 内部对比 model 内容、setValue、重新做语法分析与 token 化（< 10 ms 对小文件）。
6. **StrictMode 下的双调用**：开发模式 FileExplorer 的 `useEffect([])` 会被调两次，意味着 `getFileTree` IPC 会请求两次——这是开发期已知现象，刷新按钮也是幂等设计，不会有问题。生产环境（StrictMode 不再双调用）只调一次。
7. **热重启时序**：保存 `electron/main.ts` → electron-vite 重启主进程 → ipc 模块重新执行 → 每个 register 函数先 `removeHandler` 再 `handle`，无 second handler 错误 → renderer 不刷新（hot module replacement 会保留组件状态，但 IPC handler 已经是新的）。

---

## 8. 必学知识点深化

### 8.1 IPC 序列化的边界

`ipcMain.handle` 的返回值会被 Electron 用 **结构化克隆算法** 跨进程传输——不能传：
- 函数（包括 class 方法）
- DOM / BrowserWindow / 任何 Electron 对象
- Symbol
- 循环引用（结构化克隆理论上支持但 Electron IPC 实现可能崩）

可以传：
- 普通 Object / Array / Map / Set / Date / 基本类型 / Buffer / TypedArray / Error（仅 `name / message / stack` 字段）

我们 service 返回的 `FileTreeNode` 是纯 JSON 形状，无函数、无 class——天然可被克隆。如果某天 service 想返回一个 `{ tree, refresh: () => ... }`（带 refresh 函数），renderer 端拿到的就是 `{ tree, refresh: undefined }`——必须重新设计成"renderer 自己再 invoke 一次"。

### 8.2 React 受控树性能

文件树有 N 个节点时，state 变化（如 `openFilePath` 切换）默认会让整棵树的所有 FileTreeItem 重渲染（因为 props 之一 `activeFilePath` 变了）。本日 N < 1000 时没感觉；N > 5000 需要：
- 虚拟列表（`react-window`）：只渲染可见节点。
- `React.memo + custom equality`：FileTreeItem 用 `memo`，自定义比较器判断 "我或我子树的 isActive 是否实际变化"。

Day 8 设计系统升级时会引入虚拟化。

### 8.3 单例 service 与并发

`file-system.ipc.ts` 模块顶层 `const fileSystemService = new FileSystemService()` 是模块单例。**多个 IPC 调用并发**进入同一个实例时，`getFileTree`、`readTextFile` 都是 read-only + Promise 链，没有共享可变状态——天然并发安全。当未来 service 加"内存缓存树结构"时，必须考虑并发写问题（用 `Map<requestId, Promise>` 去重等）。

---

## 9. 自测清单

- [ ] `npm install && npm run dev` 启动无报错。
- [ ] 侧边栏 EXPLORER 区显示工作目录路径，下方有文件树（对应 §1.1 目标 1）。
- [ ] 文件树过滤了 `node_modules / .git / out / dist`（在 day3 目录下这些都存在）。
- [ ] 目录与文件分组排序：目录在上、文件在下，组内字典序。
- [ ] 点击文件夹能展开 / 折叠；图标随状态切换 ▶ / ▼ 与文件夹开 / 闭。
- [ ] 点击 `package.json` → Monaco 显示 JSON 内容、语法高亮 JSON（对应 §1.1 目标 2）。
- [ ] 点击 `MonacoWrapper.tsx` → 内容切换、高亮变 TypeScript、撤销栈独立（在 A 文件做修改 → 切到 B → 切回 A → Ctrl+Z 能撤销）。
- [ ] StatusBar 显示 `Opened: <文件名>`（对应 §1.1 目标 3）。
- [ ] 点击右上角 ⟳ 能重新加载文件树（在终端 `New-Item temp.txt` 后刷新可见）。
- [ ] 终端依然能跑 `node -v`（Day 2 无回归，对应 §1.1 目标 5）。
- [ ] 侧栏 ✕ 折叠 + 重开（点活动栏）正常。
- [ ] DevTools console 输入 `await window.api.readFile('not-a-file')` 返回的 Promise reject 错误信息可读。
- [ ] DevTools console 输入 `await window.api.readFile('C:\\Windows\\System32\\drivers\\etc\\hosts')` 应被路径沙箱拒绝（错误信息含"越出工作区"）。

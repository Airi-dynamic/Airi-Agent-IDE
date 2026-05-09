// 从 zustand 库（本质上是一个纯 js 库）中导入 create 工厂函数
// 它的作用是在 React 组件树之外的内存中，开辟一块独立的数据仓库
import { create } from 'zustand'

// ---------------------------------------------------------
// 第一部分：TypeScript 类型定义
// ---------------------------------------------------------
// 这段代码在真正的浏览器运行时会被完全抹除，它只在写代码时给编辑器看。
// 它规定了这个数据仓库里【必须且只能】存以下两个东西，防止你写错单词或传错类型。
interface EditorState {
  // 1. 一个名为 isSidebarOpen 的纯数据
  isSidebarOpen: boolean
  // 2. 一个名为 setSidebarOpen 的方法
  setSidebarOpen: (open: boolean) => void
}

// ---------------------------------------------------------
// 第二部分：执行 create 函数，创建全局 Hook
// ---------------------------------------------------------
// 1. useEditorStore: 变量名以 use 开头，这样 React 才会承认它是一个合法的 Hook
// 并在数据变化时触发重绘。
// 2. create<EditorState>: 执行 create 函数，并将上面的契约传给它进行严格校验。
export const useEditorStore = create<EditorState>((set) => ({
  // 这里的 (set) => ({...}) 是一个箭头函数。
  // 它接收 Zustand 底层丢给它的 set 函数，并返回了一个包含初始状态的对象。
  // 外层的 () 是为了防止 JavaScript 引擎把 {} 误认为代码块。

  // --- 仓库里的真实内容 ---
  // 初始数据：应用刚启动时，侧边栏默认是打开的
  isSidebarOpen: true,

  // 修改数据的动作函数 (Action)
  // 当组件里执行 setSidebarOpen(false) 时，这里的 open 参数就是 false
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  // ▲ 这一行的物理执行逻辑：
  // 1. 接收外部传来的新值 (open)。
  // 2. 调用 Zustand 底层的 set 方法。
  // 3. 将一个包含新值的对象 { isSidebarOpen: 新值 } 传给 set。
  // 4. set 方法内部会进行对象合并（相当于 { ...旧数据, isSidebarOpen: 新值 }）。
  // 5. set 方法合并完数据后，会遍历它内部的集合，通知所有订阅了该数据的 React 组件进行重新渲染。
}))

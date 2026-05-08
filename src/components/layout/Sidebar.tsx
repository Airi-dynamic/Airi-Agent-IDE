import { useEditorStore } from "../../stores/editor.store";
import { FolderTree, X } from "lucide-react";

export default function Sidebar() {
  const setSidebarOpen = useEditorStore((state) => state.setSidebarOpen);

  return (
    // 属性含义：
    // 1. h-full: 高度占满父容器的全部空间。
    // 2. bg-surface: 背景色为 Tailwind 的 surface 颜色（通常是浅色调）。
    // 3. border-r border-border: 右侧有一个边框，颜色为 Tailwind 的 border 颜色。
    // 4. flex flex-col: 使用 Flexbox 布局，并将子元素垂直排列。
    <div className="h-full bg-surface border-r border-border flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between uppercase text-xs font-semibold text-gray-400 border-b border-border">
        <span className="flex items-center">
          <FolderTree size={14} className="mr-2" />
          Explorer
        </span>
        {/* 关闭按钮触发全局状态更新，使外层侧边栏整体卸载。 */}
        <button
          onClick={() => setSidebarOpen(false)}
          className="hover:text-white cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-gray-500 italic text-sm">
          Day 1: File Tree Will Be Here
        </p>
      </div>
    </div>
  );
}

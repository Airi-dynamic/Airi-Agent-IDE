import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Sidebar from "./Sidebar";
import StatusBar from "./StatusBar";
import { FileCode, MessageSquare, TerminalSquare } from "lucide-react";
import { useEditorStore } from "../../stores/editor.store";
import MonacoWrapper from "../editor/MonacoWrapper";
import TerminalInstance from "../terminal/TerminalInstance";

export default function AppLayout() {
  const isSidebarOpen = useEditorStore((state) => state.isSidebarOpen);

  return (
    // 根布局，是一个单一元素，使用 Flexbox 垂直排列子元素，并占满整个屏幕高度。
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* 根布局所含的两个元素之一：主要内容区域，默认水平排列 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧按钮栏 */}
        <div className="w-12 shrink-0 bg-surface border-r border-border flex flex-col items-center py-2 gap-2">
          <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
            <FileCode size={24} />
          </button>
          <button className="p-2 text-gray-400 hover:text-white rounded cursor-pointer">
            <MessageSquare size={24} />
          </button>
        </div>

        {/* 中间内容区，有三块，通过 PanelGroup 嵌套进行管理*/}
        <PanelGroup direction="horizontal">
          {/* 左侧面板（可用于目录树等）：侧边栏与分割线一起做条件渲染 */}
          {isSidebarOpen && (
            <>
              <Panel defaultSize={20} minSize={15} maxSize={30}>
                <Sidebar />
              </Panel>
              <PanelResizeHandle className="w-1 bg-border hover:bg-blue-500 transition-colors" />
            </>
          )}
          {/* 主工作区 */}
          <Panel defaultSize={80}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={70}>
                <div className="h-full border-b border-border">
                  <MonacoWrapper />
                </div>
              </Panel>
              {/* 工作区分割线 */}
              <PanelResizeHandle className="h-1 bg-border hover:bg-blue-500 transition-colors" />
              {/* 下方工作区 */}
              <Panel defaultSize={30}>
                {/* 指定下方工作区布局的根元素 */}
                <div className="h-full flex flex-col bg-surface">
                  {/* 选项栏 */}
                  <div className="h-8 border-b border-border flex items-center px-4">
                    <TerminalSquare size={14} className="mr-2" />
                    <span className="text-xs uppercase font-semibold">
                      Terminal
                    </span>
                  </div>
                  {/* 终端面板内容 */}
                  <div className="flex-1 overflow-hidden">
                    <TerminalInstance />
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      {/* 根布局所含的两个元素之一：状态栏（最底部一小块区域） */}
      <StatusBar />
    </div>
  );
}

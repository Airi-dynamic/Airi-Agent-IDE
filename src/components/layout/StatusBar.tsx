export default function StatusBar() {
  return (
    // 属性含义：
    // 1. h-6: 固定高度为 1.5rem（24px），不随内容增高。
    // 2. bg-blue-600: 背景色为 Tailwind 的蓝色调，600 级别。
    // 3. text-white: 字体颜色为白色。
    // 4. text-xs: 字体大小为 extra small（0.75rem）。
    // 5. flex items-center: 使用 Flexbox 布局，并垂直居中对齐内容。
    // 6. px-4: 水平内边距为 1rem（16px）。
    // 7. shrink-0: 禁止在 Flex 容器中缩小，即使空间不足也保持原宽度。
    // 8. transition-colors: 启用颜色过渡动画，使背景色变化更平滑。
    <div className="h-6 bg-blue-600 text-white text-xs flex items-center px-4 shrink-0 transition-colors">
      <span className="font-semibold">Day 1 Framework</span>
      <span className="mx-4 opacity-50">|</span>
      <span>React 19 + Electron 35 Base</span>
    </div>
  );
}

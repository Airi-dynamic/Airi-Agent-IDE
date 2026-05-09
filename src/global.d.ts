// 魔法指令，确保此文件被识别为 TS 模块，从而拥有独立的作用域
export {}

// 1. 定义你的数据结构
interface TerminalCommandResult {
  stdout: string
  stderr: string
  code: number
}

// 2. 定义你的 API 集合
interface RendererApi {
  runCommand: (command: string) => Promise<TerminalCommandResult>
}

// 3. 穿透模块作用域，向全局 Window 对象注入你的 API
declare global {
  interface Window {
    api: RendererApi
  }
}

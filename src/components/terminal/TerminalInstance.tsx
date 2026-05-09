import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const PROMPT = 'PS > '

export default function TerminalInstance() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const commandBufferRef = useRef<string>('')

  useEffect(() => {
    if (!containerRef.current) return

    // 创建终端实例
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      convertEol: true,
      theme: {
        background: '#252526',
        foreground: '#cccccc',
      },
    })

    const fixAddon = new FitAddon()
    terminal.loadAddon(fixAddon) // 挂插件
    terminal.open(containerRef.current) // 挂载到 DOM 上
    fixAddon.fit()

    // 将 terminal 实例保存到 ref 中，以便后续访问
    terminalRef.current = terminal
    fitAddonRef.current = fixAddon

    terminal.writeln('Welcome to Airi Agent IDE Terminal!(day-2)')
    terminal.write(PROMPT)

    const runCommand = async (command: string) => {
      const result = await window.api.runCommand(command)

      if (result.stdout) {
        // 使用正则表达式将 Unix 和 Windows 的换行符统一替换为 xterm 识别的格式
        terminal.writeln(result.stdout.replace(/\r?\n/g, '\r\n'))
      }
      if (result.stderr) {
        terminal.writeln(result.stderr.replace(/\r?\n/g, '\r\n'))
      }
      terminal.write(PROMPT)
    }

    const onDataDisposable = terminal.onData(async (data) => {
      if (data === '\r') {
        // Enter 键
        const command = commandBufferRef.current.trim()
        terminal.write('\r\n') // 换行

        if (command.length > 0) {
          await runCommand(command)
        } else {
          terminal.write(PROMPT)
        }

        commandBufferRef.current = ''
        return
      }
      // Ctrl+C：丢弃 buffer，显示 ^C
      if (data === '\u0003') {
        commandBufferRef.current = ''
        terminal.write('^C\r\n')
        terminal.write(PROMPT)
        return
      }

      // 退格（DEL）：buffer 末尾删一个字符，屏幕上擦掉一个
      if (data === '\u007f') {
        if (commandBufferRef.current.length > 0) {
          commandBufferRef.current = commandBufferRef.current.slice(0, -1)
          terminal.write('\b \b') // 回退 + 空格覆盖 + 再回退
        }
        return
      }

      // 普通可见字符：追加到 buffer + 回显到屏幕
      if (data >= ' ') {
        commandBufferRef.current += data
        terminal.write(data)
      }
    })

    // 窗口尺寸变化时重新计算终端行列数
    const onResize = () => {
      fixAddon.fit()
    }

    window.addEventListener('resize', onResize)

    // cleanup 三件套：解绑输入、解绑 resize、销毁实例
    return () => {
      onDataDisposable.dispose()
      window.removeEventListener('resize', onResize)
      terminal.dispose()
    }
  }, [])

  return <div ref={containerRef} className="h-full w-full" />
}

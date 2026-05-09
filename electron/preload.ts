import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  runCommand: async (command: string) => ipcRenderer.invoke('terminal:run-command', command),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose APIs in the main world:', error)
  }
} else {
  // 仅在关闭 contextIsolation 的兜底场景下直接赋值，正常项目不建议依赖该分支。
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

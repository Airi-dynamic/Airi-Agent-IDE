import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            contextIsolation: true
        }
    })

    // 当窗口准备好显示时，显示窗口。
    mainWindow.on('ready-to-show', () => {
        mainWindow.show()
    })

    // 处理窗口内打开链接的事件，使用系统默认浏览器打开外部链接。
    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
    })

    // 在开发环境中加载远程 URL，在生产环境中加载本地 HTML 文件。
    // 此处加载的是程序的前端页面。
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    if (is.dev) {
        mainWindow.webContents.openDevTools()
    }
}

app.whenReady().then(() => {
    // 设置应用程序的用户模型 ID，以支持 Windows 上的通知和其他功能。
    electronApp.setAppUserModelId('com.electron')

    // 窗口创建时，监听快捷键事件
    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('terminal:run-command', async (_event, command: string) => {
        if (!command || !command.trim()) {
            return { stdout: '', stderr: '命令不能为空', code: 1 };
        }
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: process.cwd(),
                windowsHide: true,
                maxBuffer: 1024 * 1024
            });
            return { stdout, stderr, code: 0 };
        } catch (error: any) {
            const execError = error as { stdout?: string, stderr?: string, message: string, code?: number };
            return {
                stdout: execError.stdout ?? '',
                stderr: execError.stderr ?? execError.message ?? '命令执行失败。',
                code: execError.code ?? 1
            }
        }
    })

    createWindow()

    app.on('activate', function () {
        // 在 macOS 上，当单击 dock 图标并且没有其他窗口打开时，重新创建一个窗口。
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

// 仅在 macOS 上，除非用户使用 Cmd + Q 明确退出，否则在所有窗口关闭时保持应用程序处于活动状态。
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})
/**
 * apps/desktop/electron/main.ts
 *
 * Electron main process entry point.
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow lifecycle
 *  - Register all IPC handlers (see ./ipc/)
 *  - Initialize the asset pipeline bridge (jar parsing, file I/O)
 *  - Manage native module loading (Rust WASM, napi-rs)
 *  - Enforce contextIsolation + sandbox security model
 *
 * Threading model:
 *  Main process      → Electron APIs, IPC, file system, native modules
 *  Renderer process  → React UI, Three.js rendering, ECS tick (non-heavy)
 *  Worker threads    → Chunk meshing, asset baking, simulation tick (20 TPS)
 *
 * The renderer process NEVER accesses the filesystem directly.
 * All asset data flows through IPC channels defined in ./ipc/.
 */

import { app, BrowserWindow, shell, session } from 'electron'
import path from 'path'
import { registerAllIpcHandlers } from './ipc/index'
import { initAppDirectories } from './windows/appDirectories'

// Detect whether we are in development (launched via electronmon/concurrently)
// or in a packaged production build.
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow: BrowserWindow | null = null

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1024,
    minHeight: 640,
    show: false, // show after ready-to-show to prevent flash
    backgroundColor: '#1a1a1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // contextIsolation MUST be true. Renderer has zero access to Node APIs.
      // All Node/system access goes through the typed IPC bridge in preload.ts.
      contextIsolation: true,
      sandbox: false, // We need worker threads in renderer; true breaks them
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      preload: path.join(__dirname, '../preload/index.js'),
      // WebGL2 is required for the rendering engine. Electron exposes this
      // through Chromium; no special flags needed in modern Electron 30+.
    }
  })

  // Prevent white flash: show window only after DOM is painted
  win.once('ready-to-show', () => {
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })

  // Open external links (e.g., mod download URLs, wiki links) in the
  // system browser, NOT in Electron. Prevents XSS via navigation hijack.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Prevent renderer from navigating away from app shell
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  return win
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (isDev) {
    // In development, Vite dev server runs on port 5173
    await win.loadURL('http://localhost:5173')
  } else {
    // In production, load the pre-built renderer index.html
    await win.loadFile(
      path.join(__dirname, '../renderer/index.html')
    )
  }
}

app.whenReady().then(async () => {
  // Initialize application directories (projects/, cache/, assets/)
  // These are created under app.getPath('userData') in production.
  await initAppDirectories(isDev)

  // Lock down CSP for renderer. WebGL2 data URIs and blob URLs are needed
  // for texture atlas streaming and worker-generated geometry buffers.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-eval'", // unsafe-eval needed by Three.js shader compilation
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "connect-src 'self' ws://localhost:* http://localhost:*",
            "worker-src 'self' blob:",
          ].join('; ')
        ]
      }
    })
  })

  // Register all typed IPC handlers before creating the window
  // so no IPC calls can arrive before handlers exist.
  registerAllIpcHandlers()

  mainWindow = createMainWindow()
  await loadRenderer(mainWindow)

  // macOS: re-create window on dock icon click if all windows closed
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      await loadRenderer(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, apps stay alive until Cmd+Q even with no windows
  if (process.platform !== 'darwin') app.quit()
})

// Catch unhandled promise rejections in the main process
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
})

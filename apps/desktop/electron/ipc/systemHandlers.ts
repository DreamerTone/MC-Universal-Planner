/**
 * apps/desktop/electron/ipc/systemHandlers.ts
 *
 * IPC handlers for system-level operations:
 *  - App version / platform info
 *  - Opening file/folder dialogs
 *  - Opening external links
 *  - Getting app directory paths
 *
 * These are low-risk handlers. All others (asset, project) are gated
 * by user-initiated actions and path validation.
 */

import { ipcMain, dialog, app, shell } from 'electron'
import path from 'path'
import { getAppDirPath } from '../windows/appDirectories'
import type {
  AppInfoResult,
  OpenDialogResult,
  AppDirResult,
} from '@mc-planner/shared'

export function registerSystemIpcHandlers(): void {

  // ── system:getAppInfo ────────────────────────────────────────────────────
  // Returns version, platform, and build info for display in the UI.
  ipcMain.handle('system:getAppInfo', (): AppInfoResult => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      isDev: !app.isPackaged,
    }
  })

  // ── system:openJarDialog ─────────────────────────────────────────────────
  // Opens a native file picker for selecting Minecraft jar files.
  // Returns absolute paths. The renderer never constructs file paths itself.
  ipcMain.handle('system:openJarDialog', async (): Promise<OpenDialogResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Select Minecraft / Mod JAR files',
      filters: [
        { name: 'JAR Files', extensions: ['jar'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    }
  })

  // ── system:openFolderDialog ──────────────────────────────────────────────
  // Opens a folder picker (e.g. for selecting a .minecraft/mods directory).
  ipcMain.handle('system:openFolderDialog', async (): Promise<OpenDialogResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Select folder',
      properties: ['openDirectory'],
    })
    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    }
  })

  // ── system:getAppDir ─────────────────────────────────────────────────────
  // Returns an absolute path to a named app directory (projects, cache, etc.)
  // Renderer uses this to display paths in the UI without ever holding them.
  ipcMain.handle(
    'system:getAppDir',
    (_event, dir: string): AppDirResult => {
      // Validate against known dirs to prevent path traversal
      const allowedDirs = ['projects', 'cache', 'assets', 'logs'] as const
      type AllowedDir = typeof allowedDirs[number]
      if (!allowedDirs.includes(dir as AllowedDir)) {
        throw new Error(`Unknown app directory: ${dir}`)
      }
      return { path: getAppDirPath(dir as AllowedDir) }
    }
  )

  // ── system:revealInExplorer ──────────────────────────────────────────────
  // Opens the system file explorer to a specific path (e.g. cache dir).
  ipcMain.handle('system:revealInExplorer', async (_event, filePath: string): Promise<void> => {
    // Ensure the path is absolute and within the app root before revealing
    const resolved = path.resolve(filePath)
    await shell.openPath(resolved)
  })
}

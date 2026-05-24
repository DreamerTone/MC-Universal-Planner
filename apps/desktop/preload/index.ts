/**
 * apps/desktop/preload/index.ts
 *
 * Electron preload script — the typed IPC bridge between renderer and main.
 *
 * WHY contextBridge?
 * With contextIsolation: true, renderer JavaScript runs in a completely
 * separate V8 context from the preload script. contextBridge.exposeInMainWorld()
 * is the ONLY safe way to expose APIs to the renderer. It prevents prototype
 * pollution and ensures the renderer cannot access Electron internals.
 *
 * WHY type this here?
 * The ElectronAPI type is declared in packages/shared/src/types/ElectronAPI.ts
 * and imported here. The same type is imported in the renderer's global.d.ts
 * so `window.electronAPI` is fully typed in React components and engine code.
 *
 * Pattern: every exposed method wraps ipcRenderer.invoke() with a typed
 * signature that matches exactly one ipcMain.handle() in the corresponding
 * handler file. No untyped string channels leak to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '@mc-planner/shared'

const api: ElectronAPI = {

  // ── System ───────────────────────────────────────────────────────────────
  system: {
    getAppInfo: () =>
      ipcRenderer.invoke('system:getAppInfo'),

    openJarDialog: () =>
      ipcRenderer.invoke('system:openJarDialog'),

    openFolderDialog: () =>
      ipcRenderer.invoke('system:openFolderDialog'),

    getAppDir: (dir) =>
      ipcRenderer.invoke('system:getAppDir', dir),

    revealInExplorer: (filePath) =>
      ipcRenderer.invoke('system:revealInExplorer', filePath),
  },

  // ── Asset Pipeline ───────────────────────────────────────────────────────
  asset: {
    loadJar: (request) =>
      ipcRenderer.invoke('asset:loadJar', request),

    getBlockstateJson: (resourceLocation) =>
      ipcRenderer.invoke('asset:getBlockstateJson', resourceLocation),

    getModelJson: (resourceLocation) =>
      ipcRenderer.invoke('asset:getModelJson', resourceLocation),

    getTextureBuffer: (resourceLocation) =>
      ipcRenderer.invoke('asset:getTextureBuffer', resourceLocation),

    listNamespace: (namespace) =>
      ipcRenderer.invoke('asset:listNamespace', namespace),

    clearCache: () =>
      ipcRenderer.invoke('asset:clearCache'),

    // Subscribe to streaming progress events during JAR loading
    onLoadProgress: (callback) => {
      ipcRenderer.on('asset:loadProgress', (_event, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('asset:loadProgress')
    },
  },

  // ── Project Management ───────────────────────────────────────────────────
  project: {
    listRecent: () =>
      ipcRenderer.invoke('project:listRecent'),

    create: (name) =>
      ipcRenderer.invoke('project:new', name),

    save: (request) =>
      ipcRenderer.invoke('project:save', request),

    load: (filePath) =>
      ipcRenderer.invoke('project:load', filePath),

    openDialog: () =>
      ipcRenderer.invoke('project:openDialog'),

    saveAsDialog: (defaultName) =>
      ipcRenderer.invoke('project:saveAsDialog', defaultName),
  },
}

// Expose the typed API object to window.electronAPI in the renderer
contextBridge.exposeInMainWorld('electronAPI', api)

/**
 * apps/desktop/renderer/src/global.d.ts
 *
 * Extends the Window interface with the typed electronAPI bridge.
 * Injected by the preload script via contextBridge.exposeInMainWorld().
 *
 * This declaration makes window.electronAPI fully typed in all renderer
 * TypeScript files without needing an explicit import.
 */

import type { ElectronAPI } from '@mc-planner/shared'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}

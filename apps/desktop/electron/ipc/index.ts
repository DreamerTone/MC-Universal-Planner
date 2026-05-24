/**
 * apps/desktop/electron/ipc/index.ts
 *
 * IPC handler registration hub.
 *
 * WHY a centralized registration hub?
 * Electron's ipcMain handlers are global singletons. If handlers are scattered
 * across files and registered at import time, initialization order becomes
 * unpredictable. By funneling all registration through this function, called
 * explicitly after app.whenReady(), we guarantee deterministic startup order.
 *
 * Channel naming convention:
 *   domain:action        e.g. "asset:loadJar", "project:save"
 *
 * All channels are declared in packages/shared/src/types/IpcChannels.ts
 * and consumed by the preload bridge, creating a fully typed IPC contract.
 */

import { registerAssetIpcHandlers } from './assetHandlers'
import { registerProjectIpcHandlers } from './projectHandlers'
import { registerSystemIpcHandlers } from './systemHandlers'

export function registerAllIpcHandlers(): void {
  registerSystemIpcHandlers()
  registerAssetIpcHandlers()
  registerProjectIpcHandlers()

  console.log('[IPC] All handlers registered')
}

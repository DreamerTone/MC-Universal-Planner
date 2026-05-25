/**
 * packages/renderer-core/src/global.d.ts
 *
 * Renderer-core runs inside the Electron renderer process and reaches
 * over the IPC bridge via `window.electronAPI`. The contract type lives
 * in @mc-planner/shared, but the global `Window` augmentation must be
 * declared in EACH package that consumes it — TS does not propagate
 * `declare global` blocks across project references.
 *
 * (apps/desktop/renderer has the equivalent declaration for its own
 * compilation unit. Both must stay in sync.)
 */
import type { ElectronAPI } from '@mc-planner/shared'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}

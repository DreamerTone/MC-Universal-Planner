/**
 * apps/desktop/electron/ipc/assetHandlers.ts
 *
 * IPC handlers for the asset pipeline:
 *  - JAR file parsing and indexing
 *  - Asset extraction (blockstates, models, textures)
 *  - Cache management
 *  - Progress streaming back to renderer
 *
 * WHY does asset loading live in the main process?
 *  - JAR files are ZIP archives; unzipping them requires Node.js fs APIs
 *  - Texture atlases may be 50-200MB; we stream them to the renderer
 *    as ArrayBuffers over IPC rather than holding them in renderer memory
 *  - Progress events use ipcMain → webContents.send() (not handle/invoke)
 *    so we can stream incremental updates without blocking IPC
 *
 * The asset pipeline package (packages/asset-pipeline) does the heavy
 * lifting; these handlers are thin IPC adapters.
 */

import { ipcMain, BrowserWindow } from 'electron'
import type {
  LoadJarRequest,
  LoadJarResult,
  AssetIndexEntry,
} from '@mc-planner/shared'
import { getAppDirPath } from '../windows/appDirectories'

// Lazy import: asset-pipeline uses adm-zip and sharp which are large.
// We only load them when the user actually imports assets.
let assetPipeline: typeof import('@mc-planner/asset-pipeline') | null = null

async function getAssetPipeline() {
  if (!assetPipeline) {
    assetPipeline = await import('@mc-planner/asset-pipeline')
    // Inject the cache root from the host — the package is intentionally
    // ignorant of Electron paths; we hand it the resolved directory here.
    assetPipeline.setAssetCacheRoot(getAppDirPath('cache'))
  }
  return assetPipeline
}

export function registerAssetIpcHandlers(): void {

  // ── asset:loadJar ────────────────────────────────────────────────────────
  // Accepts one or more JAR file paths, extracts and indexes all assets.
  // Emits 'asset:loadProgress' events back to the sender window during load.
  //
  // This is the main entry point for adding mod support at runtime.
  // The asset pipeline will:
  //  1. Hash the JAR for cache keying
  //  2. Extract blockstates/, models/, textures/ namespaces
  //  3. Build an in-memory asset registry
  //  4. Serialize the registry to the cache directory
  //  5. Return the complete asset index to the renderer
  ipcMain.handle(
    'asset:loadJar',
    async (event, request: LoadJarRequest): Promise<LoadJarResult> => {
      const pipeline = await getAssetPipeline()
      const senderWindow = BrowserWindow.fromWebContents(event.sender)

      try {
        const result = await pipeline.loadJarFiles(
          request.jarPaths,
          (progress) => {
            // Stream progress back to renderer without blocking the handler
            if (senderWindow && !senderWindow.isDestroyed()) {
              senderWindow.webContents.send('asset:loadProgress', progress)
            }
          }
        )
        return { success: true, assetIndex: result }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message, assetIndex: null }
      }
    }
  )

  // ── asset:getBlockstateJson ──────────────────────────────────────────────
  // Returns the raw blockstate JSON for a given resource location.
  // Used by the blockstate compiler to build variant/multipart state machines.
  ipcMain.handle(
    'asset:getBlockstateJson',
    async (_event, resourceLocation: string): Promise<string | null> => {
      const pipeline = await getAssetPipeline()
      return pipeline.getBlockstateJson(resourceLocation)
    }
  )

  // ── asset:getModelJson ───────────────────────────────────────────────────
  // Returns raw model JSON for a resource location.
  // The model resolver in renderer-core uses this to walk parent inheritance.
  ipcMain.handle(
    'asset:getModelJson',
    async (_event, resourceLocation: string): Promise<string | null> => {
      const pipeline = await getAssetPipeline()
      return pipeline.getModelJson(resourceLocation)
    }
  )

  // ── asset:getTextureBuffer ───────────────────────────────────────────────
  // Returns raw PNG bytes for a texture resource location.
  // The atlas builder in renderer-core stitches these into a GPU texture.
  ipcMain.handle(
    'asset:getTextureBuffer',
    async (_event, resourceLocation: string): Promise<ArrayBuffer | null> => {
      const pipeline = await getAssetPipeline()
      return pipeline.getTextureBuffer(resourceLocation)
    }
  )

  // ── asset:listNamespace ──────────────────────────────────────────────────
  // Returns all known resource locations in a namespace (e.g. 'minecraft').
  // Used by the UI to display available blocks, items, and models.
  ipcMain.handle(
    'asset:listNamespace',
    async (_event, namespace: string): Promise<AssetIndexEntry[]> => {
      const pipeline = await getAssetPipeline()
      return pipeline.listNamespace(namespace)
    }
  )

  // ── asset:clearCache ─────────────────────────────────────────────────────
  // Wipes the baked model/atlas cache. Forces full re-bake on next load.
  ipcMain.handle('asset:clearCache', async (): Promise<void> => {
    const pipeline = await getAssetPipeline()
    await pipeline.clearCache()
  })
}

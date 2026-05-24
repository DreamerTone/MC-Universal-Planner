/**
 * packages/shared/src/types/ElectronAPI.ts
 *
 * The canonical type contract for window.electronAPI.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the IPC interface.
 * Both the preload script (implements it) and the renderer (consumes it)
 * import from here. If a channel changes, you update this file and both
 * sides fail to compile if they drift.
 *
 * Versioning: this type evolves with the application. When adding new
 * handlers, add the method signature here first, then implement in:
 *  - apps/desktop/electron/ipc/<domain>Handlers.ts
 *  - apps/desktop/preload/index.ts
 */

import type {
  AppInfoResult,
  OpenDialogResult,
  AppDirResult,
  LoadJarRequest,
  LoadJarResult,
  AssetIndexEntry,
  AssetLoadProgress,
  ProjectMetadata,
  SaveProjectRequest,
  LoadProjectResult,
} from './ipc'

export interface ElectronAPI {
  system: {
    getAppInfo(): Promise<AppInfoResult>
    openJarDialog(): Promise<OpenDialogResult>
    openFolderDialog(): Promise<OpenDialogResult>
    getAppDir(dir: string): Promise<AppDirResult>
    revealInExplorer(filePath: string): Promise<void>
  }

  asset: {
    loadJar(request: LoadJarRequest): Promise<LoadJarResult>
    getBlockstateJson(resourceLocation: string): Promise<string | null>
    getModelJson(resourceLocation: string): Promise<string | null>
    getTextureBuffer(resourceLocation: string): Promise<ArrayBuffer | null>
    listNamespace(namespace: string): Promise<AssetIndexEntry[]>
    clearCache(): Promise<void>
    /** Subscribe to streaming progress events. Returns unsubscribe fn. */
    onLoadProgress(callback: (progress: AssetLoadProgress) => void): () => void
  }

  project: {
    listRecent(): Promise<ProjectMetadata[]>
    create(name: string): Promise<string>
    save(request: SaveProjectRequest): Promise<void>
    load(filePath: string): Promise<LoadProjectResult>
    openDialog(): Promise<string | null>
    saveAsDialog(defaultName: string): Promise<string | null>
  }
}

/**
 * packages/asset-pipeline/src/index.ts
 *
 * Public API for the asset pipeline.
 *
 * The asset pipeline is responsible for:
 *  1. Reading JAR files (ZIP archives) and indexing their contents
 *  2. Providing typed accessors for blockstate JSON, model JSON, textures
 *  3. Managing the disk cache (hash-keyed, invalidated on JAR change)
 *  4. Streaming progress events during heavy load operations
 *
 * WHY a separate package?
 *  - The asset pipeline runs in the Electron main process (Node.js environment)
 *  - It uses adm-zip, crypto, and fs — none available in the renderer
 *  - Isolating it here makes the boundary explicit and testable
 *  - Future: Rust native module (native/rust-atlas) will replace hot paths
 *
 * Downstream consumers:
 *  - apps/desktop/electron/ipc/assetHandlers.ts (IPC adapter)
 *  - packages/renderer-core (via IPC, not direct import)
 */

export { loadJarFiles } from './JarLoader'
export { getBlockstateJson, getModelJson, getTextureBuffer, listNamespace } from './AssetRegistry'
export { clearCache, setAssetCacheRoot } from './CacheManager'

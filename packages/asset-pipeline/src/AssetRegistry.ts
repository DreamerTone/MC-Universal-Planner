/**
 * packages/asset-pipeline/src/AssetRegistry.ts
 *
 * In-memory asset registry.
 *
 * This is the central store for all loaded asset data in the main process.
 * It holds raw Buffers for every asset extracted from loaded JARs.
 *
 * WHY keep everything in memory?
 *  Model baking requires random access to potentially thousands of model
 *  JSON files (due to parent inheritance chains). Disk I/O for each lookup
 *  would be catastrophically slow. The typical Minecraft installation has
 *  ~3000 models; a large modpack may have 30,000+.
 *
 * Memory estimate:
 *  - Average model JSON: ~2KB → 30,000 models = ~60MB
 *  - Textures: NOT stored in registry (served as ArrayBuffer per-request)
 *  - Total registry footprint for large modpack: ~100-200MB (acceptable)
 *
 * Namespace isolation:
 *  Resource locations are globally unique within a loaded set. If two JARs
 *  provide the same typed asset location, the LAST loaded one wins — matching
 *  Minecraft's own resource pack priority behavior.
 *
 * Important: raw asset storage is keyed by asset TYPE + resource location.
 * Minecraft legitimately has a model and a texture with the same resource
 * location, e.g. `minecraft:block/stone` for both:
 *   assets/minecraft/models/block/stone.json
 *   assets/minecraft/textures/block/stone.png
 * If raw bytes are keyed only by resource location, model JSON can overwrite
 * texture PNG bytes (or vice versa). Then the atlas attempts to decode JSON
 * as PNG and silently drops the sprite, causing missing-texture rendering.
 */

import type { AssetIndex, AssetIndexEntry } from '@mc-planner/shared'

type AssetType = AssetIndexEntry['type']

function rawKey(type: AssetType, resourceLocation: string): string {
  return `${type}:${resourceLocation}`
}

class AssetRegistryImpl {
  /** Raw asset buffers keyed by `${type}:${resourceLocation}` */
  private readonly rawData = new Map<string, Buffer>()

  /** Entry metadata keyed by `${type}:${resourceLocation}` */
  private readonly entries = new Map<string, AssetIndexEntry>()

  storeRawData(resourceLocation: string, data: Buffer, type: AssetType): void {
    this.rawData.set(rawKey(type, resourceLocation), data)
  }

  registerEntry(entry: AssetIndexEntry): void {
    this.entries.set(rawKey(entry.type, entry.resourceLocation), entry)
  }

  getJson(resourceLocation: string, type: AssetType): string | null {
    const buf = this.rawData.get(rawKey(type, resourceLocation))
    return buf ? buf.toString('utf8') : null
  }

  getBuffer(resourceLocation: string, type: AssetType): ArrayBuffer | null {
    const buf = this.rawData.get(rawKey(type, resourceLocation))
    if (!buf) return null
    // Copy into an ArrayBuffer (transferable over IPC)
    const ab = new ArrayBuffer(buf.length)
    buf.copy(Buffer.from(ab))
    return ab
  }

  listByNamespace(namespace: string): AssetIndexEntry[] {
    const result: AssetIndexEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.resourceLocation.startsWith(`${namespace}:`)) {
        result.push(entry)
      }
    }
    return result
  }

  /** Restore from a persisted cache index (does NOT restore raw data — must re-extract) */
  restoreFromCacheIndex(index: AssetIndex): void {
    // Raw data is intentionally not persisted in the metadata cache. JarLoader
    // re-extracts the JAR bytes into rawData before calling this method.
    for (const entry of index.entries) {
      this.registerEntry(entry)
    }
    console.log(`[AssetRegistry] Restored index with ${index.entries.length} entries`)
  }

  clear(): void {
    this.rawData.clear()
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

// Singleton — one registry per main process lifetime
export const assetRegistry = new AssetRegistryImpl()

// ── Public accessor functions (exported from package index) ─────────────────

export function getBlockstateJson(resourceLocation: string): string | null {
  // Blockstates are stored under their base name, e.g. 'minecraft:stone'
  // The registry key format matches parseAssetPath output from JarLoader
  return assetRegistry.getJson(resourceLocation, 'blockstate')
}

export function getModelJson(resourceLocation: string): string | null {
  return assetRegistry.getJson(resourceLocation, 'model')
}

export function getTextureBuffer(resourceLocation: string): ArrayBuffer | null {
  return assetRegistry.getBuffer(resourceLocation, 'texture')
}

export function listNamespace(namespace: string): AssetIndexEntry[] {
  return assetRegistry.listByNamespace(namespace)
}

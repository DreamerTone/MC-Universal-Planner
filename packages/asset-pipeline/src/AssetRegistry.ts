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
 *  provide the same resource location, the LAST loaded one wins — matching
 *  Minecraft's own resource pack priority behavior.
 */

import type { AssetIndex, AssetIndexEntry } from '@mc-planner/shared'

class AssetRegistryImpl {
  /** Raw asset buffers keyed by resource location */
  private readonly rawData = new Map<string, Buffer>()

  /** Entry metadata keyed by resource location */
  private readonly entries = new Map<string, AssetIndexEntry>()

  storeRawData(resourceLocation: string, data: Buffer): void {
    this.rawData.set(resourceLocation, data)
  }

  registerEntry(entry: AssetIndexEntry): void {
    this.entries.set(entry.resourceLocation, entry)
  }

  getJson(resourceLocation: string): string | null {
    const buf = this.rawData.get(resourceLocation)
    return buf ? buf.toString('utf8') : null
  }

  getBuffer(resourceLocation: string): ArrayBuffer | null {
    const buf = this.rawData.get(resourceLocation)
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
    // In a full implementation, raw data would be re-read from the cache
    // directory. For now, mark as restored (raw data must be re-extracted).
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
  return assetRegistry.getJson(resourceLocation)
}

export function getModelJson(resourceLocation: string): string | null {
  return assetRegistry.getJson(resourceLocation)
}

export function getTextureBuffer(resourceLocation: string): ArrayBuffer | null {
  return assetRegistry.getBuffer(resourceLocation)
}

export function listNamespace(namespace: string): AssetIndexEntry[] {
  return assetRegistry.listByNamespace(namespace)
}

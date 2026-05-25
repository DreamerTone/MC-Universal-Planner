/**
 * packages/asset-pipeline/src/JarLoader.ts
 *
 * Core JAR file loading system.
 *
 * A Minecraft JAR (or mod JAR) is a ZIP file with a specific directory layout:
 *   assets/<namespace>/blockstates/<name>.json
 *   assets/<namespace>/models/block/<name>.json
 *   assets/<namespace>/models/item/<name>.json
 *   assets/<namespace>/textures/block/<name>.png
 *   assets/<namespace>/textures/item/<name>.png
 *   data/<namespace>/recipes/<name>.json
 *   data/<namespace>/tags/blocks/<name>.json
 *
 * We extract and index ALL assets into the AssetRegistry (in-memory) and
 * optionally persist the index to disk for faster subsequent loads.
 *
 * WHY NOT extract to disk?
 *  We keep assets in memory (Map<resourceLocation, Buffer>) for fast random
 *  access during model baking and atlas building. Disk extraction would add
 *  I/O latency on every model lookup. Large modpacks have 10,000+ models.
 *
 * Cache strategy:
 *  - SHA-256 hash each JAR file
 *  - If hash matches cached index, skip extraction and load from cache
 *  - Otherwise, extract fresh and persist new cache entry
 */

import AdmZip from 'adm-zip'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { assetRegistry } from './AssetRegistry'
import { getCachePath, writeCacheIndex, readCacheIndex } from './CacheManager'
import type { AssetIndex, AssetLoadProgress, LoadJarResult } from '@mc-planner/shared'

type ProgressCallback = (progress: AssetLoadProgress) => void

/**
 * Load one or more JAR files into the asset registry.
 * This is the primary entry point called by the IPC handler.
 */
export async function loadJarFiles(
  jarPaths: string[],
  onProgress: ProgressCallback
): Promise<AssetIndex> {
  const jarHashes: Record<string, string> = {}

  // Phase 1: Hash all JARs (fast, determines cache validity)
  onProgress({ phase: 'hashing', current: 0, total: jarPaths.length })

  for (let i = 0; i < jarPaths.length; i++) {
    const jarPath = jarPaths[i]!
    jarHashes[jarPath] = await hashFile(jarPath)
    onProgress({ phase: 'hashing', current: i + 1, total: jarPaths.length })
  }

  // Phase 2: Check cache — if all JARs are cached with matching hashes,
  // restore from cache and skip extraction.
  //
  // We sanity-check the cached payload before trusting it: a previous bug
  // in the indexer could persist an AssetIndex with populated counts but
  // an empty entries[] array. If we blindly returned that, every consumer
  // (BlockstateLoader, AtlasBuilder) would silently produce 0 results and
  // the user would see a working pipeline that renders nothing.
  const cacheKey = buildCacheKey(jarHashes)
  const cached = await readCacheIndex(cacheKey)

  if (cached) {
    const headerTotal =
      (cached.blockstateCount ?? 0) +
      (cached.modelCount ?? 0) +
      (cached.textureCount ?? 0)
    const entriesEmpty = !cached.entries || cached.entries.length === 0
    if (entriesEmpty && headerTotal > 0) {
      console.warn(
        '[AssetPipeline] Cached index is corrupt (header counts > 0 but ' +
        'entries[] is empty). Discarding and re-extracting.'
      )
    } else {
      console.log(
        `[AssetPipeline] Cache hit — restoring ${cached.entries.length} entries from cache`
      )
      assetRegistry.restoreFromCacheIndex(cached)
      onProgress({ phase: 'complete', current: cached.entries.length, total: cached.entries.length })
      return cached
    }
  } else {
    console.log('[AssetPipeline] Cache miss — extracting JARs fresh')
  }

  // Phase 3: Extract assets from JARs
  let totalEntries = 0
  const allEntries: AssetIndex['entries'] = []

  for (let i = 0; i < jarPaths.length; i++) {
    const jarPath = jarPaths[i]!
    onProgress({
      phase: 'extracting',
      current: i,
      total: jarPaths.length,
      currentFile: path.basename(jarPath),
    })

    const entries = await extractJar(jarPath)
    allEntries.push(...entries)
    totalEntries += entries.length
  }

  // Phase 4: Index all entries into the registry
  onProgress({ phase: 'indexing', current: 0, total: totalEntries })

  const namespaces = new Set<string>()
  let blockstateCount = 0, modelCount = 0, textureCount = 0

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i]!
    assetRegistry.registerEntry(entry)
    namespaces.add(entry.resourceLocation.split(':')[0]!)

    if (entry.type === 'blockstate') blockstateCount++
    else if (entry.type === 'model') modelCount++
    else if (entry.type === 'texture') textureCount++

    if (i % 500 === 0) {
      onProgress({ phase: 'indexing', current: i, total: totalEntries })
    }
  }

  const index: AssetIndex = {
    namespaces: Array.from(namespaces),
    blockstateCount,
    modelCount,
    textureCount,
    entries: allEntries.map(({ resourceLocation, type, jarPath, size }) => ({
      resourceLocation, type, jarPath, size
    })),
    jarHashes,
  }

  // Sanity check before persisting: if header counts disagree with the
  // actual entries[] length, something went wrong upstream and we'd be
  // poisoning the cache for next time.
  if (index.entries.length === 0 && (blockstateCount + modelCount + textureCount) > 0) {
    console.error(
      '[AssetPipeline] Refusing to cache corrupt index: ' +
      `header reports ${blockstateCount}+${modelCount}+${textureCount} but entries[] is empty.`
    )
    return index
  }
  console.log(
    `[AssetPipeline] Indexed ${index.entries.length} entries ` +
    `(blocks:${blockstateCount}, models:${modelCount}, textures:${textureCount})`
  )

  // Persist index to cache for next launch
  await writeCacheIndex(cacheKey, index)

  onProgress({ phase: 'complete', current: totalEntries, total: totalEntries })
  return index
}

/**
 * Extract all asset entries from a single JAR file.
 * Returns metadata entries; raw data is stored in the asset registry.
 */
async function extractJar(jarPath: string): Promise<AssetIndex['entries']> {
  const zip = new AdmZip(jarPath)
  const zipEntries = zip.getEntries()
  const entries: AssetIndex['entries'] = []

  for (const zipEntry of zipEntries) {
    if (zipEntry.isDirectory) continue

    const entryName = zipEntry.entryName
    const parsed = parseAssetPath(entryName, jarPath)
    if (!parsed) continue

    // Store raw data buffer in registry for later access
    const buffer = zipEntry.getData()
    assetRegistry.storeRawData(parsed.resourceLocation, buffer)

    entries.push({
      resourceLocation: parsed.resourceLocation,
      type: parsed.type,
      jarPath,
      size: buffer.length,
    })
  }

  return entries
}

type AssetType = AssetIndex['entries'][number]['type']

interface ParsedAssetPath {
  resourceLocation: string
  type: AssetType
}

/**
 * Parse a JAR entry path into a resource location and asset type.
 *
 * Examples:
 *   assets/minecraft/blockstates/stone.json → { 'minecraft:stone', 'blockstate' }
 *   assets/create/models/block/shaft.json   → { 'create:block/shaft', 'model' }
 *   assets/minecraft/textures/block/stone.png → { 'minecraft:block/stone', 'texture' }
 *   data/minecraft/recipes/stone.json       → { 'minecraft:stone', 'recipe' }
 */
function parseAssetPath(entryName: string, _jarPath: string): ParsedAssetPath | null {
  // Match: assets/<namespace>/<category>/.../<name>.<ext>
  const assetsMatch = entryName.match(
    /^assets\/([a-z0-9_.-]+)\/(blockstates|models|textures|sounds|lang|font|particles)\/(.+)$/
  )

  if (assetsMatch) {
    const [, namespace, category, rest] = assetsMatch as [string, string, string, string]

    let type: AssetType
    let resourcePath: string

    switch (category) {
      case 'blockstates':
        type = 'blockstate'
        resourcePath = rest.replace(/\.json$/, '')
        break
      case 'models':
        type = 'model'
        resourcePath = rest.replace(/\.json$/, '')
        break
      case 'textures':
        type = 'texture'
        resourcePath = rest.replace(/\.png$/, '').replace(/\.mcmeta$/, '')
        if (rest.endsWith('.mcmeta')) return null // skip animation metadata for now
        break
      default:
        type = 'other'
        resourcePath = rest
    }

    return {
      resourceLocation: `${namespace}:${resourcePath}`,
      type,
    }
  }

  // Match: data/<namespace>/recipes/...
  const dataMatch = entryName.match(/^data\/([a-z0-9_.-]+)\/(recipes|tags)\/(.+)\.json$/)
  if (dataMatch) {
    const [, namespace, category, rest] = dataMatch as [string, string, string, string]
    return {
      resourceLocation: `${namespace}:${rest}`,
      type: category === 'recipes' ? 'recipe' : 'tag',
    }
  }

  return null
}

/** SHA-256 hash a file for cache keying */
async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Build a combined cache key from all JAR hashes */
function buildCacheKey(jarHashes: Record<string, string>): string {
  const sorted = Object.entries(jarHashes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, hash]) => hash)
    .join('|')
  return crypto.createHash('sha256').update(sorted).digest('hex')
}

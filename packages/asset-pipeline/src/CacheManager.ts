/**
 * packages/asset-pipeline/src/CacheManager.ts
 *
 * Disk cache for the asset pipeline.
 *
 * Cache structure under <cacheRoot>:
 *   <cacheRoot>/
 *   └── assets/
 *       ├── <cacheKey>.index.json     ← AssetIndex metadata (fast to read)
 *       └── <cacheKey>.data/          ← Raw asset data (future: binary pack)
 *
 * Architecture note — dependency direction:
 *  The asset-pipeline package MUST NOT know about Electron or the app
 *  layout. The host (apps/desktop's main process) calls
 *  `setAssetCacheRoot()` once at startup with its resolved cache directory.
 *  This keeps the package portable (CLI tools, tests, future headless mode
 *  can all wire in different roots).
 *
 * Cache invalidation:
 *  The cache key is a SHA-256 of all loaded JAR file hashes (sorted).
 *  If any JAR changes, the entire cache is invalidated.
 *  This is intentionally conservative — partial invalidation is complex
 *  and risks serving stale data from mixed JAR versions.
 */

import fs from 'fs/promises'
import path from 'path'
import type { AssetIndex } from '@mc-planner/shared'

let cacheRoot: string | null = null

/**
 * Configure the on-disk cache root. Must be called once before any other
 * function in this module. Subsequent calls overwrite the previous root —
 * intentionally permissive so tests can swap to a tempdir.
 */
export function setAssetCacheRoot(rootDir: string): void {
  cacheRoot = rootDir
}

function getCacheDir(): string {
  if (!cacheRoot) {
    throw new Error(
      '[CacheManager] cache root not configured — call setAssetCacheRoot() ' +
      'during host startup before invoking the asset pipeline.',
    )
  }
  return path.join(cacheRoot, 'assets')
}

export function getCachePath(cacheKey: string): string {
  return path.join(getCacheDir(), `${cacheKey}.index.json`)
}

export async function readCacheIndex(cacheKey: string): Promise<AssetIndex | null> {
  const cachePath = getCachePath(cacheKey)
  try {
    const json = await fs.readFile(cachePath, 'utf8')
    return JSON.parse(json) as AssetIndex
  } catch {
    return null
  }
}

export async function writeCacheIndex(cacheKey: string, index: AssetIndex): Promise<void> {
  const cacheDir = getCacheDir()
  await fs.mkdir(cacheDir, { recursive: true })
  const cachePath = getCachePath(cacheKey)
  await fs.writeFile(cachePath, JSON.stringify(index, null, 0))
}

export async function clearCache(): Promise<void> {
  const cacheDir = getCacheDir()
  try {
    await fs.rm(cacheDir, { recursive: true, force: true })
    console.log('[CacheManager] Cache cleared')
  } catch {
    // Cache dir may not exist on first run
  }
}

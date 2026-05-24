/**
 * packages/asset-pipeline/src/CacheManager.ts
 *
 * Disk cache for the asset pipeline.
 *
 * Cache structure under <appRoot>/cache/:
 *   cache/
 *   └── assets/
 *       ├── <cacheKey>.index.json     ← AssetIndex metadata (fast to read)
 *       └── <cacheKey>.data/          ← Raw asset data (future: binary pack)
 *
 * Cache invalidation:
 *  The cache key is a SHA-256 of all loaded JAR file hashes (sorted).
 *  If any JAR changes, the entire cache is invalidated.
 *  This is intentionally conservative — partial invalidation is complex
 *  and risks serving stale data from mixed JAR versions.
 */

import fs from 'fs/promises'
import path from 'path'
import { getAppDirPath } from '../../../apps/desktop/electron/windows/appDirectories'
import type { AssetIndex } from '@mc-planner/shared'

function getCacheDir(): string {
  return path.join(getAppDirPath('cache'), 'assets')
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

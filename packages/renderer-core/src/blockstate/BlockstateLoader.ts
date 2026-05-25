/**
 * packages/renderer-core/src/blockstate/BlockstateLoader.ts
 *
 * Orchestrates the full blockstate loading pipeline after a JAR is imported.
 *
 * Called by the renderer when the user imports a JAR file via the UI.
 * The flow is:
 *
 *   1. User selects JAR(s) via dialog
 *   2. IPC → asset pipeline extracts all assets → returns AssetIndex
 *   3. BlockstateLoader.loadFromIndex() is called
 *   4. For each blockstate entry:
 *      a. Fetch JSON via IPC (asset:getBlockstateJson)
 *      b. Fetch relevant tags for this block (asset:getBlockTags)
 *   5. Compile all blockstates via compileBlockstatesAsync (idle loop)
 *   6. Load tag data into globalTagRegistry
 *   7. Report completion to the UI via progress callbacks
 *
 * After this completes:
 *  - globalBlockstateRegistry has all compiled blockstates
 *  - globalBlockRegistry has all block definitions
 *  - globalBlockStateRegistry has all enumerated state IDs
 *  - globalConnectivityRegistry has all fence/wall/pane rules
 *  - globalTagRegistry has all block tags
 *  - The world can begin meshing
 *
 * WHY load tags before connectivity extraction?
 *  ConnectivityExtractor.inferConnectionCondition() queries blockTags.
 *  Tags must be loaded first so the inference is correct.
 *  We do a two-pass load: tags first, then blockstates.
 */

import type { AssetIndex, ResourceLocation } from '@mc-planner/shared'
import { parseResourceLocation } from '@mc-planner/shared'
import { globalTagRegistry } from '@mc-planner/world-engine'
import { compileBlockstatesAsync } from './BlockstateCompiler'

export interface LoadProgressEvent {
  phase: 'tags' | 'blockstates' | 'complete'
  current: number
  total: number
  currentBlock?: string
}

type ProgressCallback = (event: LoadProgressEvent) => void

export class BlockstateLoader {
  /**
   * Load all blockstates from a loaded asset index.
   * Fetches JSON via the window.electronAPI IPC bridge.
   */
  async loadFromIndex(
    index: AssetIndex,
    onProgress?: ProgressCallback
  ): Promise<{ blockstatesCompiled: number; errors: number }> {
    // ── Phase 1: Load tag data ──────────────────────────────────────────────
    const tagEntries = index.entries.filter(e => e.type === 'tag')
    onProgress?.({ phase: 'tags', current: 0, total: tagEntries.length })

    const blockTagMap = await this.loadBlockTags(tagEntries, onProgress)

    // ── Phase 2: Compile blockstates ────────────────────────────────────────
    const blockstateEntries = index.entries.filter(e => e.type === 'blockstate')
    onProgress?.({ phase: 'blockstates', current: 0, total: blockstateEntries.length })

    // Batch-fetch all blockstate JSONs (parallelized, capped concurrency)
    const jobs = await this.fetchBlockstateJobs(
      blockstateEntries.map(e => e.resourceLocation as ResourceLocation),
      blockTagMap
    )

    const result = await compileBlockstatesAsync(jobs, (compiled, total) => {
      onProgress?.({
        phase: 'blockstates',
        current: compiled,
        total,
      })
    })

    onProgress?.({ phase: 'complete', current: result.compiled, total: result.compiled })
    console.log(
      `[BlockstateLoader] Compiled ${result.compiled} blockstates, ${result.errors} errors`
    )

    return { blockstatesCompiled: result.compiled, errors: result.errors }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async loadBlockTags(
    tagEntries: AssetIndex['entries'],
    onProgress?: ProgressCallback
  ): Promise<Map<ResourceLocation, string[]>> {
    // Map: blockId → list of tag strings it belongs to
    const blockTagMap = new Map<ResourceLocation, string[]>()

    // Tags are in data/<namespace>/tags/blocks/<name>.json
    // Each tag JSON: { "values": ["minecraft:stone", "#minecraft:base_stone_overworld"] }
    const CONCURRENCY = 8
    let i = 0
    const chunks: typeof tagEntries[] = []
    while (i < tagEntries.length) {
      chunks.push(tagEntries.slice(i, i + CONCURRENCY))
      i += CONCURRENCY
    }

    let processed = 0
    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async entry => {
          const tagName = entry.resourceLocation as ResourceLocation
          const json = await window.electronAPI.asset.getBlockstateJson(tagName)
          if (!json) return

          try {
            const data = JSON.parse(json) as { values: string[] }
            for (const value of data.values ?? []) {
              if (value.startsWith('#')) continue // skip tag references for now
              const blockId = value as ResourceLocation
              if (!blockTagMap.has(blockId)) blockTagMap.set(blockId, [])
              blockTagMap.get(blockId)!.push(tagName)
            }

            // Register with globalTagRegistry
            const blockIds = (data.values ?? [])
              .filter(v => !v.startsWith('#'))
              .map(v => v as ResourceLocation)
            globalTagRegistry.registerTag(tagName, blockIds)
          } catch { /* malformed tag JSON — skip */ }

          processed++
          if (processed % 20 === 0) {
            onProgress?.({ phase: 'tags', current: processed, total: tagEntries.length })
          }
        })
      )
    }

    return blockTagMap
  }

  private async fetchBlockstateJobs(
    blockIds: ResourceLocation[],
    blockTagMap: Map<ResourceLocation, string[]>
  ): Promise<Array<{ blockId: ResourceLocation; jsonString: string; blockTags: string[] }>> {
    const CONCURRENCY = 16
    const jobs: Array<{ blockId: ResourceLocation; jsonString: string; blockTags: string[] }> = []

    let i = 0
    const chunks: ResourceLocation[][] = []
    while (i < blockIds.length) {
      chunks.push(blockIds.slice(i, i + CONCURRENCY))
      i += CONCURRENCY
    }

    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map(async blockId => {
          const json = await window.electronAPI.asset.getBlockstateJson(blockId)
          if (!json) return null
          return {
            blockId,
            jsonString: json,
            blockTags: blockTagMap.get(blockId) ?? [],
          }
        })
      )
      for (const r of results) {
        if (r) jobs.push(r)
      }
    }

    return jobs
  }
}

export const globalBlockstateLoader = new BlockstateLoader()

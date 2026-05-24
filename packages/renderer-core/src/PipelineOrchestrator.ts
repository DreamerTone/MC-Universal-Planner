/**
 * packages/renderer-core/src/PipelineOrchestrator.ts
 *
 * Orchestrates the full asset → GPU pipeline after JAR loading.
 *
 * Called from the renderer process after BlockstateLoader completes.
 *
 * Steps:
 *  1. Collect all unique texture resource locations from resolved models
 *  2. Build texture atlas (AtlasBuilder)
 *  3. Create ModelResolver (IPC-backed)
 *  4. Create BakedModelRegistry (lazy baker, backed by atlas sprites)
 *  5. Replace placeholder materials in WorldRenderer with block shader
 *  6. Trigger full world dirty (re-mesh all chunks with real geometry)
 *
 * This is designed to be called ONCE after initial load and AGAIN if the
 * user adds more JARs (re-runs the full pipeline, invalidating the cache).
 *
 * Progress is streamed back to the UI via a callback.
 */

import type { AssetIndex } from '@mc-planner/shared'
import { ModelResolver } from './model/ModelResolver'
import { AtlasBuilder, type AtlasResult } from './atlas/AtlasBuilder'
import { BakedModelRegistry } from './baking/BakedModelRegistry'
import { createBlockShaderMaterial } from './shaders/BlockShader'
import type { RendererCore } from './RendererCore'

export interface PipelineProgress {
  stage: 'atlas' | 'shader' | 'complete'
  phase?: string
  current: number
  total: number
}

type ProgressCb = (p: PipelineProgress) => void

export class PipelineOrchestrator {
  private resolver: ModelResolver | null = null
  private bakedRegistry: BakedModelRegistry | null = null
  private atlasResult: AtlasResult | null = null

  constructor(private readonly rendererCore: RendererCore) {}

  async run(index: AssetIndex, onProgress?: ProgressCb): Promise<void> {
    // ── Step 1: Build atlas ──────────────────────────────────────────────────
    const allTextureLocations = this.collectTextureLocations(index)

    const atlas = new AtlasBuilder()
    this.atlasResult = await atlas.build(allTextureLocations, atlasProgress => {
      onProgress?.({
        stage: 'atlas',
        phase: atlasProgress.phase,
        current: atlasProgress.current,
        total: atlasProgress.total,
      })
    })

    // ── Step 2: Create model resolver ────────────────────────────────────────
    this.resolver = new ModelResolver(
      async (modelId) => window.electronAPI.asset.getModelJson(modelId)
    )

    // ── Step 3: Create baked model registry ──────────────────────────────────
    this.bakedRegistry = new BakedModelRegistry(this.resolver, this.atlasResult.sprites)

    // ── Step 4: Wire block shader into WorldRenderer ─────────────────────────
    onProgress?.({ stage: 'shader', current: 0, total: 1 })

    const { material, uniforms } = createBlockShaderMaterial(this.atlasResult.texture)
    this.rendererCore.setBlockMaterial(material, uniforms)

    // ── Step 5: Re-dirty all chunks with real geometry ───────────────────────
    this.rendererCore.invalidateAllChunks()

    onProgress?.({ stage: 'complete', current: 1, total: 1 })
    console.log(
      `[Pipeline] Complete. Atlas: ${index.textureCount} textures. ` +
      `Baker ready for ${index.blockstateCount} block types.`
    )
  }

  private collectTextureLocations(index: AssetIndex): Set<string> {
    return new Set(
      index.entries
        .filter(e => e.type === 'texture')
        .map(e => e.resourceLocation)
    )
  }

  get modelResolver(): ModelResolver | null { return this.resolver }
  get bakedModels(): BakedModelRegistry | null { return this.bakedRegistry }
}

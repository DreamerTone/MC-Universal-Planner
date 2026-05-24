/**
 * packages/renderer-core/src/baking/BakedModelRegistry.ts
 *
 * Registry that maps BlockStateId → BakedModel[].
 *
 * A single BlockStateId can map to MULTIPLE BakedModels for multipart blocks
 * (e.g. a fence with north=true has the post model + the north side model).
 *
 * Population:
 *  Called after atlas build and model resolution. For every registered BlockState:
 *   1. Look up compiled blockstate for the block type
 *   2. Evaluate with the state's properties to get CompiledModelRef[]
 *   3. For each ref: resolve model → bake → store
 *
 * Usage:
 *  The chunk mesher calls getModels(stateId) to get quads to emit for a block.
 *  Uses a deterministic seed (packed world position) for weighted random selection.
 *
 * Lazy baking:
 *  With 50,000+ possible block states in a large modpack, eagerly baking all of
 *  them on load would stall for seconds. Instead, we bake on first access:
 *  getModels() triggers a bake if not cached. This means the first time a rare
 *  block appears in a chunk, there's a small bake cost — acceptable.
 *  Common blocks (stone, dirt, grass) are pre-baked on the initial idle pass.
 */

import type { BlockStateId } from '@mc-planner/world-engine'
import { globalBlockStateRegistry } from '@mc-planner/world-engine'
import { globalBlockstateRegistry } from '../blockstate/BlockstateCompiler'
import { evaluateBlockstate } from '../blockstate/CompiledBlockstate'
import type { ModelResolver } from '../model/ModelResolver'
import type { BakedModel } from './ModelBaker'
import { ModelBaker } from './ModelBaker'
import type { AtlasSpriteRegistry } from '../atlas/AtlasBuilder'

export class BakedModelRegistry {
  private readonly baker: ModelBaker
  private readonly models = new Map<BlockStateId, BakedModel[]>()
  private bakeErrors = 0

  constructor(
    private readonly resolver: ModelResolver,
    sprites: AtlasSpriteRegistry
  ) {
    this.baker = new ModelBaker(sprites)
  }

  /**
   * Get all BakedModels for a BlockStateId.
   * Bakes on first access (lazy). Returns empty array for unknown/error states.
   */
  getModels(stateId: BlockStateId, seed = 0): BakedModel[] {
    const cached = this.models.get(stateId)
    if (cached !== undefined) return cached

    const baked = this.bakeSync(stateId, seed)
    this.models.set(stateId, baked)
    return baked
  }

  /**
   * Pre-bake a set of block state IDs (called on idle for common blocks).
   */
  async prebake(stateIds: BlockStateId[]): Promise<void> {
    for (const id of stateIds) {
      if (!this.models.has(id)) {
        await this.bakeAsync(id, 0)
      }
    }
  }

  private bakeSync(stateId: BlockStateId, seed: number): BakedModel[] {
    const blockState = globalBlockStateRegistry.resolve(stateId)
    if (!blockState || blockState.id === 'minecraft:air' as any) return []

    const compiled = globalBlockstateRegistry.get(blockState.id)
    if (!compiled) return []

    const evalResult = evaluateBlockstate(compiled, blockState.properties, seed)
    if (evalResult.models.length === 0) return []

    const bakedModels: BakedModel[] = []

    for (const modelRef of evalResult.models) {
      // Synchronous path: use cached resolved model or return placeholder
      const resolved = this.resolver['cache']?.get(modelRef.modelId)
      if (!resolved) {
        // Schedule async resolve for next frame; return placeholder for now
        this.resolver.resolve(modelRef.modelId).then(r => {
          if (r) {
            const baked = this.baker.bake(modelRef, r)
            const existing = this.models.get(stateId) ?? []
            const idx = bakedModels.indexOf(bakedModels.find(m => !m.quads.length)!)
            if (idx !== -1) existing[idx] = baked
            this.models.set(stateId, existing)
          }
        })
        continue
      }
      bakedModels.push(this.baker.bake(modelRef, resolved))
    }

    return bakedModels
  }

  private async bakeAsync(stateId: BlockStateId, seed: number): Promise<BakedModel[]> {
    const blockState = globalBlockStateRegistry.resolve(stateId)
    if (!blockState || blockState.id === 'minecraft:air' as any) return []

    const compiled = globalBlockstateRegistry.get(blockState.id)
    if (!compiled) return []

    const evalResult = evaluateBlockstate(compiled, blockState.properties, seed)
    const bakedModels: BakedModel[] = []

    for (const modelRef of evalResult.models) {
      try {
        const resolved = await this.resolver.resolve(modelRef.modelId)
        if (resolved) {
          bakedModels.push(this.baker.bake(modelRef, resolved))
        }
      } catch (e) {
        this.bakeErrors++
      }
    }

    this.models.set(stateId, bakedModels)
    return bakedModels
  }

  get cachedStateCount(): number { return this.models.size }
  get errorCount(): number { return this.bakeErrors }
}

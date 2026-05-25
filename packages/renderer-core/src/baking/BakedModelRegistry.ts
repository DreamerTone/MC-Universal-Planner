/**
 * packages/renderer-core/src/baking/BakedModelRegistry.ts
 *
 * Registry that maps BlockStateId → BakedModel[] plus a RenderProfile.
 *
 * The RenderProfile is the classification-first bridge: simple blocks can use
 * optimized cube meshing while complex models keep the generic baked fallback.
 */

import type { BlockStateId } from '@mc-planner/world-engine'
import { globalBlockStateRegistry } from '@mc-planner/world-engine'
import { globalBlockstateRegistry } from '../blockstate/BlockstateCompiler'
import { evaluateBlockstate } from '../blockstate/CompiledBlockstate'
import type { ModelResolver } from '../model/ModelResolver'
import type { BakedModel } from './ModelBaker'
import { ModelBaker } from './ModelBaker'
import type { AtlasSpriteRegistry } from '../atlas/AtlasBuilder'
import type { RenderProfile } from '../classification/RenderProfile'
import { EMPTY_RENDER_PROFILE } from '../classification/RenderProfile'
import { classifyBakedModels } from '../classification/BlockRenderClassifier'

export interface BakedStateEntry {
  models: BakedModel[]
  profile: RenderProfile
}

export class BakedModelRegistry {
  private readonly baker: ModelBaker
  private readonly entriesByState = new Map<BlockStateId, BakedStateEntry>()
  private bakeErrors = 0

  constructor(
    private readonly resolver: ModelResolver,
    sprites: AtlasSpriteRegistry
  ) {
    this.baker = new ModelBaker(sprites)
  }

  getModels(stateId: BlockStateId, seed = 0): BakedModel[] {
    return this.getEntry(stateId, seed).models
  }

  getProfile(stateId: BlockStateId, seed = 0): RenderProfile {
    return this.getEntry(stateId, seed).profile
  }

  getEntry(stateId: BlockStateId, seed = 0): BakedStateEntry {
    const cached = this.entriesByState.get(stateId)
    if (cached !== undefined) return cached

    const baked = this.bakeSync(stateId, seed)
    this.entriesByState.set(stateId, baked)
    return baked
  }

  async getEntryAsync(stateId: BlockStateId, seed = 0): Promise<BakedStateEntry> {
    const cached = this.entriesByState.get(stateId)
    if (cached !== undefined && (cached.models.length > 0 || this.isKnownEmptyState(stateId))) {
      return cached
    }

    return this.bakeAsync(stateId, seed)
  }

  async prebake(stateIds: BlockStateId[]): Promise<void> {
    for (const id of stateIds) {
      if (!this.entriesByState.has(id)) {
        await this.bakeAsync(id, 0)
      }
    }
  }

  private isKnownEmptyState(stateId: BlockStateId): boolean {
    const blockState = globalBlockStateRegistry.resolve(stateId)
    return !blockState || blockState.id === 'minecraft:air' as any
  }

  private bakeSync(stateId: BlockStateId, seed: number): BakedStateEntry {
    const blockState = globalBlockStateRegistry.resolve(stateId)
    if (!blockState || blockState.id === 'minecraft:air' as any) {
      return { models: [], profile: EMPTY_RENDER_PROFILE }
    }

    const compiled = globalBlockstateRegistry.get(blockState.id)
    if (!compiled) return { models: [], profile: EMPTY_RENDER_PROFILE }

    const evalResult = evaluateBlockstate(compiled, blockState.properties, seed)
    if (evalResult.models.length === 0) return { models: [], profile: EMPTY_RENDER_PROFILE }

    const bakedModels: BakedModel[] = []

    for (const modelRef of evalResult.models) {
      const resolved = this.resolver['cache']?.get(modelRef.modelId)
      if (!resolved) {
        this.resolver.resolve(modelRef.modelId).then(r => {
          if (r) {
            const existingEntry = this.entriesByState.get(stateId) ?? { models: [], profile: EMPTY_RENDER_PROFILE }
            const baked = this.baker.bake(modelRef, r)
            const models = [...existingEntry.models, baked]
            this.entriesByState.set(stateId, {
              models,
              profile: classifyBakedModels(models),
            })
          }
        })
        continue
      }
      bakedModels.push(this.baker.bake(modelRef, resolved))
    }

    return {
      models: bakedModels,
      profile: classifyBakedModels(bakedModels),
    }
  }

  private async bakeAsync(stateId: BlockStateId, seed: number): Promise<BakedStateEntry> {
    const blockState = globalBlockStateRegistry.resolve(stateId)
    if (!blockState || blockState.id === 'minecraft:air' as any) {
      const empty = { models: [], profile: EMPTY_RENDER_PROFILE }
      this.entriesByState.set(stateId, empty)
      return empty
    }

    const compiled = globalBlockstateRegistry.get(blockState.id)
    if (!compiled) {
      const empty = { models: [], profile: EMPTY_RENDER_PROFILE }
      this.entriesByState.set(stateId, empty)
      return empty
    }

    const evalResult = evaluateBlockstate(compiled, blockState.properties, seed)
    const bakedModels: BakedModel[] = []

    for (const modelRef of evalResult.models) {
      try {
        const resolved = await this.resolver.resolve(modelRef.modelId)
        if (resolved) {
          bakedModels.push(this.baker.bake(modelRef, resolved))
        }
      } catch {
        this.bakeErrors++
      }
    }

    const entry = {
      models: bakedModels,
      profile: classifyBakedModels(bakedModels),
    }
    this.entriesByState.set(stateId, entry)
    return entry
  }

  get cachedStateCount(): number { return this.entriesByState.size }
  get errorCount(): number { return this.bakeErrors }

  *entries(): IterableIterator<[BlockStateId, BakedModel[]]> {
    for (const [stateId, entry] of this.entriesByState.entries()) {
      yield [stateId, entry.models]
    }
  }

  *profileEntries(): IterableIterator<[BlockStateId, RenderProfile]> {
    for (const [stateId, entry] of this.entriesByState.entries()) {
      yield [stateId, entry.profile]
    }
  }

  *stateEntries(): IterableIterator<[BlockStateId, BakedStateEntry]> {
    yield* this.entriesByState.entries()
  }
}

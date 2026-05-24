/**
 * packages/world-engine/src/block/BlockRegistry.ts
 *
 * Runtime block registry — maps resource locations to block definitions.
 *
 * The registry is populated by the blockstate compiler (Stage 5) when it
 * parses blockstate JSON from loaded JARs. Before the compiler runs,
 * only built-in pseudo-blocks (air, void) are registered.
 *
 * WHY separate from BlockStateIdRegistry?
 *  BlockStateIdRegistry maps specific STATES (id + properties) to u16 IDs.
 *  BlockRegistry maps BLOCK TYPES (just the id) to their definitions.
 *  One BlockDefinition covers all 80 states of oak_stairs.
 *  One BlockStateId represents exactly one of those 80 states.
 *
 * Relationship:
 *  BlockRegistry  →  getDefinition('minecraft:oak_stairs')  →  BlockDefinition
 *  BlockStateId   →  globalBlockStateRegistry.resolve(id)   →  BlockState
 *  BlockState.id  →  BlockRegistry.getDefinition(state.id)  →  BlockDefinition
 *
 * This two-level system lets the mesher quickly get render info (renderType,
 * isOpaque) from a block ID without touching the state properties.
 *
 * Thread safety: same as BlockStateIdRegistry — write from main thread only,
 * snapshot to workers.
 */

import type { ResourceLocation } from '@mc-planner/shared'
import { type BlockDefinition, BlockDefinitionBuilder, type BlockRenderType } from './BlockDefinition'

export class BlockRegistry {
  private readonly definitions = new Map<ResourceLocation, BlockDefinition>()

  constructor() {
    // Register air pseudo-block
    this.register(
      new BlockDefinitionBuilder('minecraft:air' as ResourceLocation)
        .build()
    )
    // Void air (below world) and cave air behave identically for rendering
    this.register(
      new BlockDefinitionBuilder('minecraft:void_air' as ResourceLocation)
        .build()
    )
    this.register(
      new BlockDefinitionBuilder('minecraft:cave_air' as ResourceLocation)
        .build()
    )
  }

  register(def: BlockDefinition): void {
    this.definitions.set(def.id, def)
  }

  getDefinition(id: ResourceLocation): BlockDefinition | undefined {
    return this.definitions.get(id)
  }

  /** Get render type for quick meshing decisions. Defaults to 'solid' for unknown blocks. */
  getRenderType(id: ResourceLocation): BlockRenderType {
    return this.definitions.get(id)?.renderType ?? 'solid'
  }

  /**
   * Check if a block ID is opaque for AO and face culling.
   * A block is opaque if renderType === 'solid'.
   * This drives the face culling decision in the chunk mesher:
   *   if neighbor is opaque → cull the shared face
   */
  isOpaque(id: ResourceLocation): boolean {
    const rt = this.getRenderType(id)
    return rt === 'solid'
  }

  /**
   * Check if a block is air-like (completely invisible, never meshed).
   * Used to skip empty space in the mesher.
   */
  isAir(id: ResourceLocation): boolean {
    return (
      id === ('minecraft:air' as ResourceLocation) ||
      id === ('minecraft:void_air' as ResourceLocation) ||
      id === ('minecraft:cave_air' as ResourceLocation) ||
      this.getRenderType(id) === 'invisible'
    )
  }

  get registeredCount(): number {
    return this.definitions.size
  }

  *definitions_(): IterableIterator<BlockDefinition> {
    yield* this.definitions.values()
  }

  snapshot(): BlockRegistrySnapshot {
    return {
      definitions: Array.from(this.definitions.entries()).map(([id, def]) => ({ id, def })),
    }
  }
}

export interface BlockRegistrySnapshot {
  definitions: { id: ResourceLocation; def: BlockDefinition }[]
}

/** Global singleton registry */
export const globalBlockRegistry = new BlockRegistry()

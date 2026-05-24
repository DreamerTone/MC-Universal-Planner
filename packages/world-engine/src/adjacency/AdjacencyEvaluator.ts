/**
 * packages/world-engine/src/adjacency/AdjacencyEvaluator.ts
 *
 * Data-driven adjacency / connectivity evaluator.
 *
 * This is the system that makes fences connect to fences, walls connect to
 * walls, panes connect to opaque blocks, stairs adapt their shape, and
 * Create shafts align with adjacent shafts — WITHOUT hardcoding any of this.
 *
 * HOW it works:
 *  When the blockstate compiler processes a multipart blockstate JSON,
 *  it extracts "connectivity conditions": the property names and values
 *  that are triggered by neighbor states.
 *
 *  Example: oak_fence blockstate JSON contains:
 *    { "when": { "north": "true" }, "apply": { "model": "fence_side" } }
 *
 *  The compiler records: "oak_fence has property 'north' that can be true/false,
 *  and it's driven by the northern neighbor having tag 'c:fence_connectable'
 *  OR being a solid block OR being another fence."
 *
 *  At runtime, AdjacencyEvaluator.evaluate(pos) looks up the block at pos,
 *  gets its ConnectivityRules, queries each relevant neighbor, and returns
 *  the updated property map that the blockstate compiler uses to select a model.
 *
 * WHY not just store the final blockstate per-block?
 *  Because connectivity properties are DERIVED from the world state.
 *  If you place a block next to a fence, the fence's state must update.
 *  Storing derived state means we'd need to update all neighbors on every
 *  block placement — and then re-evaluate on load. Instead we evaluate
 *  on demand (during meshing), keeping the chunk data minimal.
 *
 * Performance:
 *  AdjacencyEvaluator is called by the mesh worker, not the simulation tick.
 *  It's O(6 neighbor lookups) per block. For a 16³ section with mostly
 *  connectivity-capable blocks, that's 4096×6 = 24,576 lookups — very fast.
 *
 * Extensibility:
 *  Create mod shafts use the same mechanism. The blockstate JSON for a shaft
 *  (if it used multipart, which Create largely does) would declare that the
 *  'connected' property is true when the northern neighbor is also a shaft.
 *  No code changes needed.
 */

import type { BlockPos, ResourceLocation, Direction } from '@mc-planner/shared'
import { DIRECTION_VECTORS, DIRECTIONS } from '@mc-planner/shared'
import type { ChunkStorage } from '../chunk/ChunkStorage'
import type { BlockStateId } from '../chunk/BlockStateId'
import { globalBlockStateRegistry } from '../chunk/BlockStateId'
import { globalBlockRegistry } from '../block/BlockRegistry'

/**
 * A connectivity rule for one direction of one block type.
 * Describes what neighbor condition triggers a property value.
 */
export interface ConnectivityRule {
  /** The property name this rule controls (e.g. 'north', 'connected', 'up') */
  propertyName: string
  /** The direction to check (e.g. 'north' = look at pos + {0,0,-1}) */
  direction: Direction
  /** Value to set when condition is true */
  trueValue: string
  /** Value to set when condition is false */
  falseValue: string
  /** The condition that must be satisfied by the neighbor */
  condition: ConnectivityCondition
}

export type ConnectivityCondition =
  | { type: 'isSolid' }                          // neighbor is a full opaque cube
  | { type: 'isAir' }                             // neighbor is air
  | { type: 'sameBlock' }                         // neighbor has same block ID
  | { type: 'hasTag'; tag: string }               // neighbor has a given block tag
  | { type: 'hasProperty'; name: string; value: string } // neighbor has specific property
  | { type: 'any'; conditions: ConnectivityCondition[] } // OR of conditions
  | { type: 'all'; conditions: ConnectivityCondition[] } // AND of conditions

/**
 * All connectivity rules for a single block type.
 * Registered by the blockstate compiler for each multipart block.
 */
export interface BlockConnectivityDef {
  blockId: ResourceLocation
  rules: ConnectivityRule[]
}

/**
 * Global connectivity registry — maps block IDs to their connectivity rules.
 * Populated by the blockstate compiler when it encounters multipart blockstates.
 */
export class ConnectivityRegistry {
  private readonly rules = new Map<ResourceLocation, BlockConnectivityDef>()

  register(def: BlockConnectivityDef): void {
    this.rules.set(def.blockId, def)
  }

  get(blockId: ResourceLocation): BlockConnectivityDef | undefined {
    return this.rules.get(blockId)
  }

  has(blockId: ResourceLocation): boolean {
    return this.rules.has(blockId)
  }
}

export const globalConnectivityRegistry = new ConnectivityRegistry()

// ── AdjacencyEvaluator ─────────────────────────────────────────────────────

export class AdjacencyEvaluator {
  constructor(
    private readonly chunkStorage: ChunkStorage,
    private readonly connectivityRegistry: ConnectivityRegistry
  ) {}

  /**
   * Evaluate connectivity properties for a block at the given position.
   * Returns a property override map { propertyName: value } that should
   * be merged with the block's stored properties before blockstate lookup.
   *
   * Returns null if the block has no connectivity rules (no-op, common case).
   */
  evaluate(pos: BlockPos, blockId: ResourceLocation): Record<string, string> | null {
    const def = this.connectivityRegistry.get(blockId)
    if (!def || def.rules.length === 0) return null

    const result: Record<string, string> = {}

    for (const rule of def.rules) {
      const neighborVec = DIRECTION_VECTORS[rule.direction]
      const neighborPos: BlockPos = {
        x: pos.x + neighborVec.x,
        y: pos.y + neighborVec.y,
        z: pos.z + neighborVec.z,
      }
      const neighborStateId = this.chunkStorage.getBlockAt(neighborPos)
      const conditionMet = this.evaluateCondition(rule.condition, neighborStateId, blockId)
      result[rule.propertyName] = conditionMet ? rule.trueValue : rule.falseValue
    }

    return result
  }

  private evaluateCondition(
    condition: ConnectivityCondition,
    neighborStateId: BlockStateId,
    sourceBlockId: ResourceLocation
  ): boolean {
    const neighborState = globalBlockStateRegistry.resolve(neighborStateId)

    switch (condition.type) {
      case 'isSolid':
        return globalBlockRegistry.isOpaque(neighborState.id)

      case 'isAir':
        return globalBlockRegistry.isAir(neighborState.id)

      case 'sameBlock':
        return neighborState.id === sourceBlockId

      case 'hasTag':
        // Tag evaluation requires the tag registry (loaded from data/*.json)
        // For now, delegate to a static tag check
        return globalTagRegistry.blockHasTag(neighborState.id, condition.tag)

      case 'hasProperty': {
        const val = neighborState.properties[condition.name]
        return val === condition.value
      }

      case 'any':
        return condition.conditions.some(c =>
          this.evaluateCondition(c, neighborStateId, sourceBlockId)
        )

      case 'all':
        return condition.conditions.every(c =>
          this.evaluateCondition(c, neighborStateId, sourceBlockId)
        )
    }
  }
}

// ── Tag Registry (stub — populated by blockstate compiler Stage 5) ─────────

class TagRegistry {
  private readonly blockTags = new Map<string, Set<ResourceLocation>>()

  registerTag(tag: string, blockIds: ResourceLocation[]): void {
    const set = this.blockTags.get(tag) ?? new Set()
    for (const id of blockIds) set.add(id)
    this.blockTags.set(tag, set)
  }

  blockHasTag(blockId: ResourceLocation, tag: string): boolean {
    return this.blockTags.get(tag)?.has(blockId) ?? false
  }
}

export const globalTagRegistry = new TagRegistry()

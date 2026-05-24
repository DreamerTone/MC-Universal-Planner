/**
 * packages/world-engine/src/chunk/BlockStateId.ts
 *
 * Global blockstate ID system.
 *
 * WHY a numeric ID?
 * Storing BlockState objects (with ResourceLocation + properties map) in every
 * voxel of a chunk section would cost thousands of allocations and garbage
 * collection pressure per chunk load.
 *
 * Instead, we maintain a global registry mapping:
 *   BlockState (id + properties) ← → u16 BlockStateId (0..65535)
 *
 * 0 is always AIR (minecraft:air, no properties).
 * IDs are assigned at runtime when a blockstate is first registered.
 * IDs are NOT stable across sessions unless persisted — projects must store
 * full BlockState objects and re-register at load time.
 *
 * The maximum of 65535 blockstate IDs is sufficient for vanilla (≈24,000)
 * and even large modpacks (typically <50,000 unique states).
 * If exceeded, the runtime throws — forcing investigation rather than
 * silent corruption.
 *
 * Thread safety: BlockStateIdRegistry is only written from the main thread.
 * Worker threads receive a snapshot of the registry for read-only access.
 */

import type { BlockState, ResourceLocation } from '@mc-planner/shared'

/** A globally unique numeric identifier for a specific block state */
export type BlockStateId = number & { readonly __brand: 'BlockStateId' }

export const AIR_BLOCKSTATE_ID = 0 as BlockStateId
const MAX_BLOCKSTATE_ID = 0xFFFF // 65535

/**
 * Deterministic key for a BlockState that maps uniquely to its properties.
 * Format: "minecraft:oak_stairs[facing=north,half=bottom,shape=straight]"
 */
function blockStateKey(state: BlockState): string {
  const props = Object.keys(state.properties)
    .sort()
    .map(k => `${k}=${state.properties[k]}`)
    .join(',')
  return props.length > 0 ? `${state.id}[${props}]` : state.id
}

export class BlockStateIdRegistry {
  private readonly idByKey = new Map<string, BlockStateId>()
  private readonly stateById: BlockState[] = []
  private nextId = 1 // 0 reserved for air

  constructor() {
    // Register air as ID 0
    this.stateById[0] = { id: 'minecraft:air' as ResourceLocation, properties: {} }
  }

  /**
   * Get or create a numeric ID for a BlockState.
   * Idempotent: calling with the same state always returns the same ID.
   */
  register(state: BlockState): BlockStateId {
    const key = blockStateKey(state)
    const existing = this.idByKey.get(key)
    if (existing !== undefined) return existing

    if (this.nextId > MAX_BLOCKSTATE_ID) {
      throw new Error(
        `[BlockStateIdRegistry] Exceeded maximum blockstate count (${MAX_BLOCKSTATE_ID}). ` +
        'This indicates an unusually large modpack or a registration bug.'
      )
    }

    const id = this.nextId++ as BlockStateId
    this.idByKey.set(key, id)
    this.stateById[id] = state
    return id
  }

  /**
   * Resolve a numeric ID back to its full BlockState.
   * Returns air for ID 0 or unknown IDs.
   */
  resolve(id: BlockStateId): BlockState {
    return this.stateById[id] ?? this.stateById[0]!
  }

  getOrNull(id: BlockStateId): BlockState | null {
    return this.stateById[id] ?? null
  }

  get registeredCount(): number {
    return this.nextId
  }

  /**
   * Export a snapshot for transfer to worker threads.
   * Workers receive this once at startup and treat it as read-only.
   */
  snapshot(): BlockStateRegistrySnapshot {
    return {
      states: this.stateById.slice(),
    }
  }
}

export interface BlockStateRegistrySnapshot {
  states: (BlockState | undefined)[]
}

/** The global singleton registry — one per renderer process */
export const globalBlockStateRegistry = new BlockStateIdRegistry()

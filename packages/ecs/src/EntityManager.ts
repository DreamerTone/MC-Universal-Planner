/**
 * packages/ecs/src/EntityManager.ts
 *
 * Entity lifecycle management.
 *
 * Entities are u32 integers. We use a free list (recycled IDs) to keep
 * entity IDs dense, which is critical for ComponentStore array indexing.
 *
 * Implementation uses a typed Uint32Array free list for O(1) create/destroy.
 * Maximum entity count is configurable (default: 1M entities).
 *
 * Generation counters: each ID slot has a generation byte packed into the
 * high 8 bits. This lets us detect use-after-free bugs where old EntityId
 * references are used after an entity is destroyed.
 *
 *  EntityId layout (32 bits):
 *  [ generation:8 | index:24 ]
 *
 * This supports up to 16M entities (24-bit index) with 256 generations.
 */

import type { EntityId } from './types'

const MAX_ENTITIES = 1 << 20 // 1,048,576
const INDEX_BITS = 24
const INDEX_MASK = (1 << INDEX_BITS) - 1
const GEN_SHIFT = INDEX_BITS

export class Entity {
  static getIndex(id: EntityId): number {
    return id & INDEX_MASK
  }

  static getGeneration(id: EntityId): number {
    return (id >>> GEN_SHIFT) & 0xFF
  }

  static make(index: number, generation: number): EntityId {
    return ((generation & 0xFF) << GEN_SHIFT | (index & INDEX_MASK)) as EntityId
  }
}

export class EntityManager {
  private readonly generations: Uint8Array
  private readonly freeList: Uint32Array
  private freeHead = 0
  private freeTail = 0
  private freeCount = 0
  private nextFreshIndex = 0
  private _liveCount = 0

  constructor(maxEntities = MAX_ENTITIES) {
    this.generations = new Uint8Array(maxEntities)
    this.freeList = new Uint32Array(maxEntities)
  }

  get liveCount(): number { return this._liveCount }

  /**
   * Allocate a new entity ID.
   * Reuses a recycled ID if available, otherwise mints a fresh index.
   */
  create(): EntityId {
    let index: number

    if (this.freeCount > 0) {
      // Pop from free list
      index = this.freeList[this.freeHead % this.freeList.length]!
      this.freeHead++
      this.freeCount--
    } else {
      if (this.nextFreshIndex >= this.generations.length) {
        throw new Error(`[ECS] Entity limit reached (${this.generations.length})`)
      }
      index = this.nextFreshIndex++
    }

    this._liveCount++
    return Entity.make(index, this.generations[index]!)
  }

  /**
   * Destroy an entity, incrementing its generation to invalidate stale IDs.
   */
  destroy(id: EntityId): void {
    const index = Entity.getIndex(id)
    const gen = this.generations[index]!

    if (Entity.getGeneration(id) !== gen) {
      // Stale ID — entity was already destroyed. This is a bug.
      console.warn(`[ECS] Attempted to destroy stale entity ${id}`)
      return
    }

    // Increment generation (wraps at 256)
    this.generations[index] = (gen + 1) & 0xFF

    // Push to free list
    this.freeList[this.freeTail % this.freeList.length] = index
    this.freeTail++
    this.freeCount++
    this._liveCount--
  }

  /**
   * Check whether an EntityId is still alive.
   * Uses generation comparison to detect use-after-free.
   */
  isAlive(id: EntityId): boolean {
    const index = Entity.getIndex(id)
    if (index >= this.nextFreshIndex) return false
    return Entity.getGeneration(id) === this.generations[index]
  }
}

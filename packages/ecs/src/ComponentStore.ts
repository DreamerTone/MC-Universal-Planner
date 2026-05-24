/**
 * packages/ecs/src/ComponentStore.ts
 *
 * Typed component storage backed by a dense Map<EntityId, T>.
 *
 * WHY not use a flat TypedArray (SoA layout)?
 *  For our use case, blocks and simulation entities have heterogeneous
 *  component types that don't fit neatly into flat TypedArrays.
 *  Future: hot-path components (Transform, Velocity) will be migrated to
 *  SoA TypedArrays for WASM transfer. This store handles general components.
 *
 * Future optimization path:
 *  Hot components → Float32Array / Int32Array in SoA layout
 *  Cold components → this Map-based store
 *
 * The interface is stable regardless of backing storage,
 * so migration is non-breaking.
 */

import type { EntityId, ComponentDef } from './types'

export class ComponentStore<T extends object> {
  private readonly data = new Map<EntityId, T>()
  readonly def: ComponentDef<T>

  constructor(def: ComponentDef<T>) {
    this.def = def
  }

  /** Add a component to an entity with default values, optionally overridden */
  add(entityId: EntityId, override?: Partial<T>): T {
    const value = this.def.create()
    if (override) Object.assign(value, override)
    this.data.set(entityId, value)
    return value
  }

  /** Get component data, or undefined if entity doesn't have this component */
  get(entityId: EntityId): T | undefined {
    return this.data.get(entityId)
  }

  /** Get component data, throwing if not present (use in systems that assume presence) */
  getRequired(entityId: EntityId): T {
    const value = this.data.get(entityId)
    if (value === undefined) {
      throw new Error(
        `[ECS] Component '${this.def.name}' not found on entity ${entityId}`
      )
    }
    return value
  }

  /** Check if an entity has this component */
  has(entityId: EntityId): boolean {
    return this.data.has(entityId)
  }

  /** Remove a component from an entity */
  remove(entityId: EntityId): boolean {
    return this.data.delete(entityId)
  }

  /** Iterate all entities with this component */
  *entities(): IterableIterator<EntityId> {
    yield* this.data.keys()
  }

  /** Iterate all (entity, component) pairs */
  *entries(): IterableIterator<[EntityId, T]> {
    yield* this.data.entries()
  }

  get size(): number {
    return this.data.size
  }
}

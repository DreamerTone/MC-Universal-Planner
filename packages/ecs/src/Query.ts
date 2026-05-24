/**
 * packages/ecs/src/Query.ts
 *
 * ECS query system — efficiently finds entities matching component signatures.
 *
 * Queries are cached and updated incrementally:
 *  - On component add: check if entity now matches any registered queries
 *  - On component remove: check if entity no longer matches
 *  - No per-frame full scan needed after initial build
 *
 * This is the key performance primitive. Systems iterate query results,
 * not all entities, keeping the hot path tight.
 */

import type { EntityId, ComponentDef, QueryDef } from './types'
import type { ComponentStore } from './ComponentStore'

export class Query {
  private readonly matchingEntities = new Set<EntityId>()
  readonly def: QueryDef

  constructor(def: QueryDef) {
    this.def = def
  }

  /** Check if an entity matches this query's component requirements */
  private matches(
    entityId: EntityId,
    stores: ReadonlyMap<ComponentDef, ComponentStore<object>>
  ): boolean {
    // All 'all' components must be present
    for (const component of this.def.all) {
      const store = stores.get(component)
      if (!store?.has(entityId)) return false
    }

    // None of 'none' components may be present
    if (this.def.none) {
      for (const component of this.def.none) {
        const store = stores.get(component)
        if (store?.has(entityId)) return false
      }
    }

    // At least one 'any' component must be present
    if (this.def.any && this.def.any.length > 0) {
      let anyFound = false
      for (const component of this.def.any) {
        const store = stores.get(component)
        if (store?.has(entityId)) { anyFound = true; break }
      }
      if (!anyFound) return false
    }

    return true
  }

  /** Called when a component is added to or removed from an entity */
  notifyComponentChange(
    entityId: EntityId,
    stores: ReadonlyMap<ComponentDef, ComponentStore<object>>
  ): void {
    if (this.matches(entityId, stores)) {
      this.matchingEntities.add(entityId)
    } else {
      this.matchingEntities.delete(entityId)
    }
  }

  /** Called when an entity is destroyed */
  notifyEntityDestroyed(entityId: EntityId): void {
    this.matchingEntities.delete(entityId)
  }

  /** Iterate all matching entity IDs */
  *[Symbol.iterator](): IterableIterator<EntityId> {
    yield* this.matchingEntities
  }

  get size(): number {
    return this.matchingEntities.size
  }
}

/**
 * packages/ecs/src/World.ts
 *
 * The ECS World — central container for all entities, components, queries.
 *
 * The World is the object passed to every system during execution.
 * It provides:
 *  - Entity creation/destruction
 *  - Component add/get/remove
 *  - Query registration and iteration
 *  - System execution via the scheduler
 *
 * There is ONE World per simulation context:
 *  - Main world: runs in the renderer process (block entities, contraptions)
 *  - Simulation world: runs in a dedicated worker (belt networks, machines)
 *
 * The two worlds are synchronized via serialized snapshots, not shared memory,
 * which keeps the simulation worker fully deterministic.
 */

import { EntityManager } from './EntityManager'
import { ComponentStore } from './ComponentStore'
import { Query } from './Query'
import { SystemScheduler } from './SystemScheduler'
import type { EntityId, ComponentDef, QueryDef, SystemDef } from './types'

export class World {
  private readonly entityManager = new EntityManager()
  private readonly stores = new Map<ComponentDef, ComponentStore<object>>()
  private readonly queries: Query[] = []
  readonly scheduler = new SystemScheduler(this)

  // ── Entity Lifecycle ───────────────────────────────────────────────────

  createEntity(): EntityId {
    return this.entityManager.create()
  }

  destroyEntity(entityId: EntityId): void {
    // Remove all components
    for (const store of this.stores.values()) {
      store.remove(entityId)
    }

    // Update all queries
    for (const query of this.queries) {
      query.notifyEntityDestroyed(entityId)
    }

    this.entityManager.destroy(entityId)
  }

  isAlive(entityId: EntityId): boolean {
    return this.entityManager.isAlive(entityId)
  }

  get entityCount(): number {
    return this.entityManager.liveCount
  }

  // ── Component Store Registration ───────────────────────────────────────

  /**
   * Register a component type with this world.
   * Must be called before any entity can have this component.
   * Typically called at world initialization, before any systems run.
   */
  registerComponent<T extends object>(def: ComponentDef<T>): ComponentStore<T> {
    if (this.stores.has(def)) {
      return this.stores.get(def) as ComponentStore<T>
    }
    const store = new ComponentStore<T>(def)
    this.stores.set(def, store as ComponentStore<object>)
    return store
  }

  // ── Component Operations ───────────────────────────────────────────────

  addComponent<T extends object>(entityId: EntityId, def: ComponentDef<T>, data?: Partial<T>): T {
    let store = this.stores.get(def) as ComponentStore<T> | undefined
    if (!store) {
      store = this.registerComponent(def)
    }
    const result = store.add(entityId, data)
    this.notifyComponentChange(entityId)
    return result
  }

  getComponent<T extends object>(entityId: EntityId, def: ComponentDef<T>): T | undefined {
    return (this.stores.get(def) as ComponentStore<T> | undefined)?.get(entityId)
  }

  getRequiredComponent<T extends object>(entityId: EntityId, def: ComponentDef<T>): T {
    return (this.stores.get(def) as ComponentStore<T> | undefined)?.getRequired(entityId)
      ?? (() => { throw new Error(`Component '${def.name}' not registered`) })()
  }

  hasComponent<T extends object>(entityId: EntityId, def: ComponentDef<T>): boolean {
    return (this.stores.get(def) as ComponentStore<T> | undefined)?.has(entityId) ?? false
  }

  removeComponent<T extends object>(entityId: EntityId, def: ComponentDef<T>): void {
    const store = this.stores.get(def) as ComponentStore<T> | undefined
    if (store?.remove(entityId)) {
      this.notifyComponentChange(entityId)
    }
  }

  // ── Query System ───────────────────────────────────────────────────────

  /**
   * Register a query and get back a Query object for iteration.
   * Queries are updated automatically when components change.
   *
   * Typical usage in a system:
   *   const movingEntities = world.registerQuery({ all: [Position, Velocity] })
   *   for (const id of movingEntities) { ... }
   */
  registerQuery(def: QueryDef): Query {
    const query = new Query(def)
    this.queries.push(query)

    // Populate with existing entities that already match
    // (necessary if query is registered after some entities already exist)
    for (const store of this.stores.values()) {
      for (const entityId of store.entities()) {
        query.notifyComponentChange(entityId, this.stores as ReadonlyMap<ComponentDef, ComponentStore<object>>)
      }
    }

    return query
  }

  // ── System Registration ────────────────────────────────────────────────

  addSystem(def: SystemDef): void {
    this.scheduler.register(def)
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  tick(dt: number): void {
    this.scheduler.execute(dt)
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private notifyComponentChange(entityId: EntityId): void {
    for (const query of this.queries) {
      query.notifyComponentChange(entityId, this.stores as ReadonlyMap<ComponentDef, ComponentStore<object>>)
    }
  }
}

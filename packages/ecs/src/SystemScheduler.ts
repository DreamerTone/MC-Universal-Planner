/**
 * packages/ecs/src/SystemScheduler.ts
 *
 * Deterministic system execution scheduler.
 *
 * Systems are organized into execution groups and sorted topologically
 * based on 'after' dependencies. The sorted order is computed once at
 * startup, not per-tick, so runtime cost is a flat array iteration.
 *
 * Execution groups (in order):
 *   preUpdate  → input handling, state sync from workers
 *   update     → simulation systems (belts, machines, physics)
 *   postUpdate → state finalization, dirty flag clearing
 *   render     → extract render state, update uniforms
 *
 * WHY deterministic ordering?
 *  The simulation engine runs at 20 TPS in a worker. For multiplayer,
 *  all clients must produce identical results from identical inputs.
 *  Any nondeterminism (random system order) breaks rollback/replay.
 */

import type { SystemDef, SystemContext } from './types'

type ExecutionGroup = 'preUpdate' | 'update' | 'postUpdate' | 'render'

const GROUP_ORDER: ExecutionGroup[] = ['preUpdate', 'update', 'postUpdate', 'render']

export class SystemScheduler {
  private readonly systems = new Map<string, SystemDef>()
  private sortedSystems: SystemDef[] = []
  private dirty = false // needs re-sort
  private tickCount = 0
  private world: unknown // circular ref avoided via unknown

  constructor(world: unknown) {
    this.world = world
  }

  register(system: SystemDef): void {
    if (this.systems.has(system.name)) {
      throw new Error(`[ECS] System '${system.name}' already registered`)
    }
    this.systems.set(system.name, system)
    this.dirty = true
  }

  /**
   * Execute all systems in their scheduled order.
   * Rebuilds sort order lazily if new systems were added since last tick.
   */
  execute(dt: number): void {
    if (this.dirty) {
      this.sortedSystems = this.topologicalSort()
      this.dirty = false
    }

    const context: SystemContext = {
      dt,
      tick: this.tickCount,
      timestamp: performance.now(),
    }

    for (const system of this.sortedSystems) {
      system.execute(context)
    }

    this.tickCount++
  }

  /**
   * Topological sort with group ordering.
   * First sorts by group, then respects 'after' dependency constraints.
   */
  private topologicalSort(): SystemDef[] {
    const systemList = Array.from(this.systems.values())

    // Build dependency graph
    const inDegree = new Map<string, number>()
    const dependents = new Map<string, string[]>()

    for (const system of systemList) {
      inDegree.set(system.name, 0)
      dependents.set(system.name, [])
    }

    for (const system of systemList) {
      if (system.after) {
        for (const dep of system.after) {
          if (!this.systems.has(dep)) {
            throw new Error(
              `[ECS] System '${system.name}' depends on unknown system '${dep}'`
            )
          }
          dependents.get(dep)!.push(system.name)
          inDegree.set(system.name, (inDegree.get(system.name) ?? 0) + 1)
        }
      }
    }

    // Kahn's algorithm, respecting group order
    const getGroupIndex = (s: SystemDef) =>
      GROUP_ORDER.indexOf(s.group ?? 'update')

    const queue = systemList
      .filter(s => inDegree.get(s.name) === 0)
      .sort((a, b) => getGroupIndex(a) - getGroupIndex(b))

    const sorted: SystemDef[] = []

    while (queue.length > 0) {
      // Pull from front, preferring lower group index
      const system = queue.shift()!
      sorted.push(system)

      for (const depName of dependents.get(system.name)!) {
        const newDegree = (inDegree.get(depName) ?? 0) - 1
        inDegree.set(depName, newDegree)
        if (newDegree === 0) {
          const depSystem = this.systems.get(depName)!
          // Insert in group order
          const insertIdx = queue.findIndex(
            s => getGroupIndex(s) > getGroupIndex(depSystem)
          )
          if (insertIdx === -1) queue.push(depSystem)
          else queue.splice(insertIdx, 0, depSystem)
        }
      }
    }

    if (sorted.length !== systemList.length) {
      throw new Error('[ECS] Circular dependency detected in system graph')
    }

    return sorted
  }
}

/**
 * packages/ecs/src/index.ts
 *
 * Entity Component System foundation.
 *
 * WHY a custom ECS instead of using bitECS or ecsy?
 *  - bitECS uses SharedArrayBuffer which requires COOP/COEP headers
 *    (breaks some Electron CSP setups and complicates worker sharing)
 *  - ecsy is deprecated
 *  - Our ECS needs tight integration with the chunk system (spatial queries)
 *    and simulation engine (deterministic tick ordering)
 *  - We need typed component stores with direct TypedArray backing for
 *    zero-copy transfer to Web Workers and future Rust native modules
 *
 * Architecture:
 *  World       → owns all entities and component stores
 *  Entity      → just a u32 ID (dense integer, recycled via free list)
 *  Component   → data struct stored in a typed ComponentStore
 *  System      → function that queries entities and operates on components
 *  Query       → cached set of entities matching a component signature
 */

export { World } from './World'
export { Entity, EntityManager } from './EntityManager'
export { ComponentStore } from './ComponentStore'
export { SystemScheduler } from './SystemScheduler'
export { Query } from './Query'
export type {
  ComponentDef,
  SystemDef,
  SystemContext,
  QueryDef,
} from './types'

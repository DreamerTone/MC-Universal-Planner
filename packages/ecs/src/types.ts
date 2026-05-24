/**
 * packages/ecs/src/types.ts
 *
 * Core ECS type definitions.
 */

export type EntityId = number & { readonly __brand: 'EntityId' }

export interface ComponentDef<T extends object = object> {
  /** Unique name for debugging and serialization */
  readonly name: string
  /** Factory for default component data */
  readonly create: () => T
}

export interface QueryDef {
  /** Component types that must ALL be present */
  readonly all: readonly ComponentDef[]
  /** Component types that must NONE be present */
  readonly none?: readonly ComponentDef[]
  /** Component types where at least ONE must be present */
  readonly any?: readonly ComponentDef[]
}

export interface SystemContext {
  /** Delta time in seconds since last tick */
  readonly dt: number
  /** Current simulation tick number */
  readonly tick: number
  /** Wall clock timestamp of this tick */
  readonly timestamp: number
}

export interface SystemDef {
  readonly name: string
  /** Execution group controls ordering: 'preUpdate' | 'update' | 'postUpdate' | 'render' */
  readonly group?: 'preUpdate' | 'update' | 'postUpdate' | 'render'
  /** Systems this system must run AFTER */
  readonly after?: readonly string[]
  execute(context: SystemContext): void
}

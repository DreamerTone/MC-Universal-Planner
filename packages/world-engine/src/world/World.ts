/**
 * packages/world-engine/src/world/World.ts
 *
 * The top-level world object — the single entry point for all world operations.
 *
 * This wraps ChunkStorage with higher-level operations:
 *  - Block placement with full blockstate resolution
 *  - Selection management (WorldEdit-style region selection)
 *  - Clipboard (copy/paste with offset)
 *  - History (undo/redo stack)
 *  - Schematic import/export
 *
 * The World also holds the ECS world reference for block entities and
 * simulation entities (Create machines, furnaces, etc.).
 *
 * It is the object that the React UI and renderer interact with.
 * The simulation worker gets a snapshot, not a reference to this.
 *
 * Undo/Redo:
 *  Operations are recorded as ChangeSet[] (list of before/after block pairs).
 *  Undo replays the before states; redo replays the after states.
 *  The stack is bounded at 256 entries to prevent unbounded memory growth.
 */

import type { BlockPos, BlockState } from '@mc-planner/shared'
import { AIR_BLOCK_STATE } from '@mc-planner/shared'
import { ChunkStorage } from '../chunk/ChunkStorage'
import { globalBlockStateRegistry, type BlockStateId, AIR_BLOCKSTATE_ID } from '../chunk/BlockStateId'
import { globalBlockRegistry } from '../block/BlockRegistry'
import { AdjacencyEvaluator, globalConnectivityRegistry } from '../adjacency/AdjacencyEvaluator'

const MAX_UNDO_STACK = 256

export interface BlockChange {
  pos: BlockPos
  from: BlockStateId
  to: BlockStateId
}

export type ChangeSet = BlockChange[]

export class World {
  readonly chunks: ChunkStorage
  private readonly adjacency: AdjacencyEvaluator
  private readonly undoStack: ChangeSet[] = []
  private readonly redoStack: ChangeSet[] = []

  constructor() {
    this.chunks = new ChunkStorage()
    this.adjacency = new AdjacencyEvaluator(this.chunks, globalConnectivityRegistry)
  }

  // ── Block Access ───────────────────────────────────────────────────────────

  getBlockState(pos: BlockPos): BlockState {
    const id = this.chunks.getBlockAt(pos)
    return globalBlockStateRegistry.resolve(id)
  }

  /**
   * Place a block at a position.
   * Records the change for undo and triggers neighbor connectivity updates.
   */
  placeBlock(pos: BlockPos, state: BlockState, recordUndo = true): void {
    const fromId = this.chunks.getBlockAt(pos)
    const toId = globalBlockStateRegistry.register(state)

    if (fromId === toId) return

    if (recordUndo) {
      this.pushUndoChange([{ pos, from: fromId, to: toId }])
    }

    this.chunks.setBlockAt(pos, toId)
    this.invalidateNeighborConnectivity(pos)
  }

  removeBlock(pos: BlockPos, recordUndo = true): void {
    this.placeBlock(pos, AIR_BLOCK_STATE, recordUndo)
  }

  /**
   * Place multiple blocks atomically — one undo entry for the whole batch.
   * Used for paste operations, schematic import, fill.
   */
  placeBlocks(operations: { pos: BlockPos; state: BlockState }[], recordUndo = true): void {
    const changes: BlockChange[] = []

    for (const { pos, state } of operations) {
      const fromId = this.chunks.getBlockAt(pos)
      const toId = globalBlockStateRegistry.register(state)
      if (fromId !== toId) {
        changes.push({ pos, from: fromId, to: toId })
        this.chunks.setBlockAt(pos, toId)
      }
    }

    if (recordUndo && changes.length > 0) {
      this.pushUndoChange(changes)
    }

    // Invalidate connectivity for all affected positions and their neighbors
    for (const change of changes) {
      this.invalidateNeighborConnectivity(change.pos)
    }
  }

  // ── Blockstate Evaluation ──────────────────────────────────────────────────

  /**
   * Get the fully evaluated blockstate at a position.
   * This applies connectivity overrides from the adjacency system,
   * returning the state the blockstate compiler should use for model selection.
   *
   * The STORED state only has user-set properties (e.g. facing=north).
   * The EVALUATED state adds derived properties (e.g. north=true, south=false).
   */
  getEvaluatedBlockState(pos: BlockPos): BlockState {
    const stored = this.getBlockState(pos)
    if (stored.id === 'minecraft:air' as typeof stored.id) return stored

    const overrides = this.adjacency.evaluate(pos, stored.id)
    if (!overrides) return stored

    return {
      id: stored.id,
      properties: { ...stored.properties, ...overrides },
    }
  }

  // ── Connectivity Invalidation ──────────────────────────────────────────────

  /**
   * When a block changes, its 6 neighbors need connectivity re-evaluation.
   * This marks those neighbors' sections dirty so the mesher re-bakes them.
   *
   * We do NOT re-evaluate immediately — the mesher evaluates on demand.
   * This avoids double-evaluation when multiple neighbors change at once
   * (e.g. during paste operations).
   */
  private invalidateNeighborConnectivity(pos: BlockPos): void {
    const neighbors: BlockPos[] = [
      { x: pos.x - 1, y: pos.y, z: pos.z },
      { x: pos.x + 1, y: pos.y, z: pos.z },
      { x: pos.x, y: pos.y - 1, z: pos.z },
      { x: pos.x, y: pos.y + 1, z: pos.z },
      { x: pos.x, y: pos.y, z: pos.z - 1 },
      { x: pos.x, y: pos.y, z: pos.z + 1 },
    ]

    for (const neighbor of neighbors) {
      const neighborState = this.getBlockState(neighbor)
      if (globalConnectivityRegistry.has(neighborState.id)) {
        // Force the neighbor's chunk section dirty
        this.chunks.setBlock(neighbor.x, neighbor.y, neighbor.z,
          this.chunks.getBlock(neighbor.x, neighbor.y, neighbor.z))
      }
    }
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  private pushUndoChange(changes: ChangeSet): void {
    this.undoStack.push(changes)
    if (this.undoStack.length > MAX_UNDO_STACK) {
      this.undoStack.shift()
    }
    // Any new action clears the redo stack
    this.redoStack.length = 0
  }

  undo(): boolean {
    const changes = this.undoStack.pop()
    if (!changes) return false

    // Apply in reverse order
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i]!
      this.chunks.setBlockAt(change.pos, change.from)
    }

    this.redoStack.push(changes)
    return true
  }

  redo(): boolean {
    const changes = this.redoStack.pop()
    if (!changes) return false

    for (const change of changes) {
      this.chunks.setBlockAt(change.pos, change.to)
    }

    this.undoStack.push(changes)
    return true
  }

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  // ── Stats ──────────────────────────────────────────────────────────────────

  get loadedChunks(): number { return this.chunks.loadedChunkCount }
}

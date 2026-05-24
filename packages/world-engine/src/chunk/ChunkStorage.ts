/**
 * packages/world-engine/src/chunk/ChunkStorage.ts
 *
 * Sparse world storage — the map of all loaded chunks.
 *
 * Architecture:
 *  ChunkStorage is the central data structure of the world engine.
 *  It owns all Chunk instances and provides the block-access API used by
 *  every downstream system: chunk mesher, adjacency evaluator, simulation.
 *
 * Key design choices:
 *
 * 1. Packed chunk key (u64 via BigInt):
 *    Chunk positions can be negative (cx/cz in [-1,000,000, 1,000,000]).
 *    We pack (cx << 32 | cz) as a BigInt string key for the Map.
 *    This avoids string concatenation ('cx,cz' style) which creates garbage.
 *
 * 2. Dirty queue:
 *    When blocks change, the affected (chunkPos, sectionY) is pushed to
 *    a dirty queue. The mesh worker manager drains this queue each frame
 *    and dispatches remesh jobs. This decouples world mutation from rendering.
 *
 * 3. Cross-chunk adjacency:
 *    getBlockAt() handles positions that cross chunk boundaries transparently.
 *    The mesher uses this to look up neighbor faces at chunk edges.
 *
 * 4. Bulk operations:
 *    setBlocks() accepts an array of [pos, stateId] pairs and batches dirty
 *    notification — critical for paste operations (schematic placement)
 *    where thousands of blocks change simultaneously.
 *
 * Thread note:
 *    ChunkStorage lives in the renderer process.
 *    The simulation worker gets a serialized snapshot, not a shared reference.
 *    Contraption chunks are duplicated into the simulation worker's own storage.
 */

import { type ChunkPos, type BlockPos, blockToChunkPos, CHUNK_SIZE } from '@mc-planner/shared'
import { Chunk, type SectionIndex, type SerializedChunk } from './Chunk'
import { type BlockStateId, AIR_BLOCKSTATE_ID } from './BlockStateId'

export interface DirtyEntry {
  chunkPos: ChunkPos
  sectionY: SectionIndex
}

function packChunkKey(cx: number, cz: number): bigint {
  // Pack as 64-bit: high 32 bits = cx, low 32 bits = cz
  return (BigInt(cx) << 32n) | (BigInt(cz) & 0xFFFFFFFFn)
}

export class ChunkStorage {
  private readonly chunks = new Map<bigint, Chunk>()
  private readonly dirtyQueue: DirtyEntry[] = []
  private dirtySetForDedup = new Set<bigint>()

  // ── Chunk Management ───────────────────────────────────────────────────────

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(packChunkKey(cx, cz))
  }

  getChunkAt(worldX: number, worldZ: number): Chunk | undefined {
    const pos = blockToChunkPos(worldX, worldZ)
    return this.getChunk(pos.cx, pos.cz)
  }

  /**
   * Get or create a chunk at the given chunk coordinates.
   * Used by paste/load operations to ensure the target chunk exists.
   */
  getOrCreateChunk(cx: number, cz: number): Chunk {
    const key = packChunkKey(cx, cz)
    let chunk = this.chunks.get(key)
    if (!chunk) {
      chunk = new Chunk(
        { cx, cz },
        (pos, sectionY) => this.onChunkDirty(pos, sectionY)
      )
      this.chunks.set(key, chunk)
    }
    return chunk
  }

  removeChunk(cx: number, cz: number): void {
    this.chunks.delete(packChunkKey(cx, cz))
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(packChunkKey(cx, cz))
  }

  get loadedChunkCount(): number {
    return this.chunks.size
  }

  *loadedChunks(): IterableIterator<Chunk> {
    yield* this.chunks.values()
  }

  // ── Block Access ───────────────────────────────────────────────────────────

  /**
   * Get the blockstate ID at any world position.
   * Crosses chunk boundaries transparently.
   * Returns AIR for unloaded chunks.
   */
  getBlock(x: number, y: number, z: number): BlockStateId {
    const chunk = this.getChunkAt(x, z)
    if (!chunk) return AIR_BLOCKSTATE_ID
    return chunk.getBlock(x, y, z)
  }

  /** Get a block using a BlockPos struct */
  getBlockAt(pos: BlockPos): BlockStateId {
    return this.getBlock(pos.x, pos.y, pos.z)
  }

  /**
   * Set a block at a world position.
   * Creates the chunk if it doesn't exist.
   */
  setBlock(x: number, y: number, z: number, stateId: BlockStateId): void {
    const { cx, cz } = blockToChunkPos(x, z)
    const chunk = this.getOrCreateChunk(cx, cz)
    chunk.setBlock(x, y, z, stateId)
  }

  setBlockAt(pos: BlockPos, stateId: BlockStateId): void {
    this.setBlock(pos.x, pos.y, pos.z, stateId)
  }

  /**
   * Bulk block placement — used for schematic paste, fill operations.
   * Batches dirty notifications: each chunk is notified once per section
   * rather than once per block, reducing mesher queue pressure.
   */
  setBlocks(operations: ReadonlyArray<{ pos: BlockPos; stateId: BlockStateId }>): void {
    for (const { pos, stateId } of operations) {
      this.setBlock(pos.x, pos.y, pos.z, stateId)
    }
    // Dirty notifications are handled per-block inside Chunk.setBlock,
    // but the dedup set in onChunkDirty ensures each section queues once.
  }

  /**
   * Fill a 3D region with a single blockstate.
   * Optimized to avoid the overhead of the full setBlock path per-block.
   */
  fill(from: BlockPos, to: BlockPos, stateId: BlockStateId): void {
    const minX = Math.min(from.x, to.x)
    const maxX = Math.max(from.x, to.x)
    const minY = Math.min(from.y, to.y)
    const maxY = Math.max(from.y, to.y)
    const minZ = Math.min(from.z, to.z)
    const maxZ = Math.max(from.z, to.z)

    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const chunk = this.getOrCreateChunk(
          Math.floor(x / CHUNK_SIZE),
          Math.floor(z / CHUNK_SIZE)
        )
        for (let y = minY; y <= maxY; y++) {
          chunk.setBlock(x, y, z, stateId)
        }
      }
    }
  }

  // ── Neighbor Queries ───────────────────────────────────────────────────────

  /**
   * Returns the six direct neighbor block IDs for a given position.
   * Used by the adjacency system (blockstate evaluation) and AO generator.
   * Order: [north, south, east, west, up, down] matching Direction enum.
   */
  getNeighbors(x: number, y: number, z: number): BlockStateId[] {
    return [
      this.getBlock(x,     y,     z - 1), // north
      this.getBlock(x,     y,     z + 1), // south
      this.getBlock(x + 1, y,     z),     // east
      this.getBlock(x - 1, y,     z),     // west
      this.getBlock(x,     y + 1, z),     // up
      this.getBlock(x,     y - 1, z),     // down
    ]
  }

  // ── Dirty Queue ────────────────────────────────────────────────────────────

  /**
   * Drain and return all pending dirty entries.
   * Called by the mesh worker manager each frame.
   * Clears the queue after draining.
   */
  drainDirtyQueue(): DirtyEntry[] {
    if (this.dirtyQueue.length === 0) return []
    const result = this.dirtyQueue.splice(0)
    this.dirtySetForDedup.clear()
    return result
  }

  /**
   * Mark all sections in all chunks dirty.
   * Used after bulk load operations (opening a project).
   */
  markAllDirty(): void {
    for (const chunk of this.chunks.values()) {
      for (let s = 0; s < 24; s++) {
        this.onChunkDirty(chunk.pos, s as SectionIndex)
      }
    }
  }

  private onChunkDirty(chunkPos: ChunkPos, sectionY: SectionIndex): void {
    // Deduplicate: only enqueue each (chunk, section) pair once per drain cycle
    const key = (BigInt(chunkPos.cx) << 37n) | (BigInt(chunkPos.cz) << 5n) | BigInt(sectionY)
    if (!this.dirtySetForDedup.has(key)) {
      this.dirtySetForDedup.add(key)
      this.dirtyQueue.push({ chunkPos, sectionY })
    }
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  serialize(): SerializedChunk[] {
    return Array.from(this.chunks.values()).map(c => c.serialize())
  }

  static deserialize(data: SerializedChunk[]): ChunkStorage {
    const storage = new ChunkStorage()
    for (const chunkData of data) {
      const chunk = Chunk.deserialize(
        chunkData,
        (pos, sectionY) => storage.onChunkDirty(pos, sectionY)
      )
      storage.chunks.set(packChunkKey(chunk.pos.cx, chunk.pos.cz), chunk)
    }
    return storage
  }
}

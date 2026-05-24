/**
 * packages/world-engine/src/world/MeshDirtyQueue.ts
 *
 * Mesh dirty queue manager — bridges world mutations to the mesh worker.
 *
 * The lifecycle is:
 *  1. Block is placed/removed → ChunkStorage marks section dirty
 *  2. Each frame, MeshDirtyQueue.drain() pulls all dirty entries
 *  3. Dirty entries are sorted by priority (distance to camera, first)
 *  4. Entries are dispatched to the mesh worker as job messages
 *  5. Worker returns completed mesh data
 *  6. RendererCore uploads the mesh to GPU
 *
 * Priority:
 *  Sections closest to the camera are meshed first. This prevents the
 *  common artifact of distant chunks appearing before nearby ones during
 *  initial world load or large paste operations.
 *
 * Throttling:
 *  We dispatch at most MAX_JOBS_PER_FRAME jobs per frame to avoid
 *  flooding the worker. The queue naturally handles backpressure.
 *
 * Deduplication:
 *  If a section is dirtied multiple times between drains (e.g. multiple
 *  blocks placed in the same section), only one job is dispatched.
 *  This is handled by ChunkStorage's deduplicated dirty set.
 */

import type { ChunkPos } from '@mc-planner/shared'
import type { SectionIndex } from '../chunk/Chunk'
import type { DirtyEntry } from '../chunk/ChunkStorage'

const MAX_JOBS_PER_FRAME = 4

export interface MeshJob {
  chunkPos: ChunkPos
  sectionY: SectionIndex
  priority: number
}

export class MeshDirtyQueue {
  private pending: MeshJob[] = []
  private readonly inFlight = new Set<string>()

  enqueue(entries: DirtyEntry[], cameraX: number, cameraZ: number): void {
    for (const entry of entries) {
      const key = `${entry.chunkPos.cx},${entry.chunkPos.cz},${entry.sectionY}`
      if (this.inFlight.has(key)) continue

      const dx = entry.chunkPos.cx * 16 - cameraX
      const dz = entry.chunkPos.cz * 16 - cameraZ
      const priority = dx * dx + dz * dz // squared distance, lower = higher priority

      this.pending.push({ chunkPos: entry.chunkPos, sectionY: entry.sectionY, priority })
    }

    // Keep sorted ascending (lowest distance first = highest priority)
    this.pending.sort((a, b) => a.priority - b.priority)
  }

  dequeue(): MeshJob[] {
    const batch = this.pending.splice(0, MAX_JOBS_PER_FRAME)
    for (const job of batch) {
      const key = `${job.chunkPos.cx},${job.chunkPos.cz},${job.sectionY}`
      this.inFlight.add(key)
    }
    return batch
  }

  markComplete(chunkPos: ChunkPos, sectionY: SectionIndex): void {
    const key = `${chunkPos.cx},${chunkPos.cz},${sectionY}`
    this.inFlight.delete(key)
  }

  get pendingCount(): number { return this.pending.length }
  get inFlightCount(): number { return this.inFlight.size }
}

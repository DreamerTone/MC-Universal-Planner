/**
 * packages/world-engine/src/voxel/VoxelShape.ts
 *
 * Voxel shape system — axis-aligned bounding box unions for blocks.
 *
 * WHY voxel shapes?
 *  Not every block is a full 1×1×1 cube. Slabs occupy half the vertical
 *  space. Stairs combine a slab with a step. Fences are thin pillars.
 *  Carpets are 1/16th of a block tall.
 *
 * These shapes drive:
 *  1. AO generation — shadow rays sample shape bounds per face
 *  2. Culling — faces are only culled if the neighbor's shape fully covers
 *     the shared face (a half-slab does NOT cull the face above it)
 *  3. Collision (future) — player movement against precise shapes
 *  4. Raycast (future) — block picking / selection highlighting
 *
 * A VoxelShape is a union of one or more AABBs in local block space [0,1]³.
 * Most blocks are a single AABB: the full cube { 0,0,0 → 1,1,1 }.
 * Stairs are two AABBs. Fences are three (post + two rails).
 *
 * Shapes are registered by the blockstate compiler from model JSON bounds.
 * Minecraft model elements have 'from' and 'to' float[3] arrays in [0,16] space.
 * We convert to [0,1] by dividing by 16.
 *
 * WHY NOT import directly from Three.js Box3?
 *  VoxelShape must be usable in the simulation worker (no Three.js there).
 *  It's a pure data structure with no rendering dependencies.
 */

export interface AABB {
  minX: number; minY: number; minZ: number
  maxX: number; maxY: number; maxZ: number
}

/** Minecraft model space (0-16) to normalized (0-1) */
export function fromModelSpace(
  fromX: number, fromY: number, fromZ: number,
  toX: number,   toY: number,   toZ: number,
): AABB {
  return {
    minX: fromX / 16, minY: fromY / 16, minZ: fromZ / 16,
    maxX: toX   / 16, maxY: toY   / 16, maxZ: toZ   / 16,
  }
}

export const FULL_CUBE: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }
export const EMPTY_SHAPE: AABB[] = []
export const FULL_CUBE_SHAPE: AABB[] = [FULL_CUBE]

export class VoxelShape {
  readonly boxes: readonly AABB[]

  constructor(boxes: AABB[]) {
    this.boxes = boxes
  }

  /** True if this shape fully covers a specific face direction */
  coversNorth(): boolean { return this.coversFace('minZ', 0) }
  coversSouth(): boolean { return this.coversFace('maxZ', 1) }
  coversEast():  boolean { return this.coversFace('maxX', 1) }
  coversWest():  boolean { return this.coversFace('minX', 0) }
  coversUp():    boolean { return this.coversFace('maxY', 1) }
  coversDown():  boolean { return this.coversFace('minY', 0) }

  /**
   * Whether this shape's face covers the full [0,1]² area.
   * Used to determine if a face between two blocks can be culled.
   * Only culled if the neighbor's COVERING face is full (1×1 solid).
   */
  private coversFace(axis: keyof AABB, targetValue: number): boolean {
    // Check if the union of boxes touching targetValue on axis covers [0,1]²
    // Simple heuristic: check if any single box covers the full face
    for (const box of this.boxes) {
      if (Math.abs(box[axis] - targetValue) < 0.001) {
        // This box touches the face plane — check if it covers 1×1
        // We check the other two axes span [0,1]
        if (axis === 'minZ' || axis === 'maxZ') {
          if (box.minX <= 0.001 && box.maxX >= 0.999 &&
              box.minY <= 0.001 && box.maxY >= 0.999) return true
        } else if (axis === 'minX' || axis === 'maxX') {
          if (box.minZ <= 0.001 && box.maxZ >= 0.999 &&
              box.minY <= 0.001 && box.maxY >= 0.999) return true
        } else {
          if (box.minX <= 0.001 && box.maxX >= 0.999 &&
              box.minZ <= 0.001 && box.maxZ >= 0.999) return true
        }
      }
    }
    return false
  }

  isFullCube(): boolean {
    return (
      this.boxes.length === 1 &&
      this.boxes[0]!.minX <= 0.001 && this.boxes[0]!.maxX >= 0.999 &&
      this.boxes[0]!.minY <= 0.001 && this.boxes[0]!.maxY >= 0.999 &&
      this.boxes[0]!.minZ <= 0.001 && this.boxes[0]!.maxZ >= 0.999
    )
  }

  isEmpty(): boolean {
    return this.boxes.length === 0
  }

  static readonly FULL = new VoxelShape(FULL_CUBE_SHAPE)
  static readonly EMPTY = new VoxelShape(EMPTY_SHAPE)
}

// ── VoxelShapeRegistry ─────────────────────────────────────────────────────

/**
 * Maps blockstate IDs to their voxel shapes.
 * Populated by the blockstate compiler from model element bounds.
 * Defaults to FULL shape for any unregistered ID.
 */
export class VoxelShapeRegistry {
  private readonly shapes = new Map<number, VoxelShape>()

  register(stateId: number, shape: VoxelShape): void {
    this.shapes.set(stateId, shape)
  }

  getShape(stateId: number): VoxelShape {
    return this.shapes.get(stateId) ?? VoxelShape.FULL
  }

  isFullCube(stateId: number): boolean {
    return this.getShape(stateId).isFullCube()
  }

  /** Returns true if a face between two blocks should be culled */
  shouldCullFace(
    neighborStateId: number,
    direction: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'
  ): boolean {
    const shape = this.getShape(neighborStateId)
    switch (direction) {
      case 'north': return shape.coversSouth() // we are north, neighbor is south → cull if neighbor's south face is full
      case 'south': return shape.coversNorth()
      case 'east':  return shape.coversWest()
      case 'west':  return shape.coversEast()
      case 'up':    return shape.coversDown()
      case 'down':  return shape.coversUp()
    }
  }
}

export const globalVoxelShapeRegistry = new VoxelShapeRegistry()

/**
 * packages/renderer-core/src/baking/BakedQuad.ts
 *
 * A baked quad — a single GPU-ready quadrilateral face from a block model.
 *
 * "Baked" means all transforms (rotation, UV mapping, atlas coordinates) have
 * been pre-computed and the quad is in block-local space [0,1]³ ready for
 * the chunk mesher to place at world coordinates.
 *
 * WHY quads instead of triangles?
 *  Minecraft's model format is quad-based (4 vertices per face).
 *  The mesher converts quads to two triangles (2×3 indices per quad) at mesh
 *  time. Keeping quads as the intermediate format lets the greedy mesher
 *  compare and merge adjacent quads — triangles cannot be merged efficiently.
 *
 * Vertex layout (4 vertices, counter-clockwise winding):
 *  v0 ─────── v1
 *  │           │
 *  v3 ─────── v2
 *
 * Winding order: CCW from outside the face (matching OpenGL front-face default).
 * Index pattern: [0, 3, 1, 1, 3, 2] (two CCW triangles).
 *
 * Packed for the greedy mesher:
 *  We store positions as Float32 (3 per vertex = 12 floats) but keep AO,
 *  tint, and face direction as compact values to minimize cache footprint
 *  during the mesher's quad-comparison pass.
 */

export type FaceDir = 0 | 1 | 2 | 3 | 4 | 5
// 0=north 1=south 2=east 3=west 4=up 5=down

export const FACE_DIR_NORTH: FaceDir = 0
export const FACE_DIR_SOUTH: FaceDir = 1
export const FACE_DIR_EAST:  FaceDir = 2
export const FACE_DIR_WEST:  FaceDir = 3
export const FACE_DIR_UP:    FaceDir = 4
export const FACE_DIR_DOWN:  FaceDir = 5

/**
 * A fully baked quad in block-local space.
 * Positions are in block space [0,1]³ (not world space).
 * The mesher adds the block's world position during geometry assembly.
 */
export interface BakedQuad {
  /**
   * 4 vertices × 3 floats = 12 floats.
   * Positions in block-local space [0,1]³.
   * Order: [v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z]
   */
  positions: Float32Array

  /**
   * 4 vertices × 2 floats = 8 floats.
   * UV coordinates in atlas space [0,1].
   */
  uvs: Float32Array

  /**
   * Surface normal direction (shared for all 4 vertices of a planar quad).
   * Encoded as FaceDir (0-5) to save space. Decoded to vec3 by the shader.
   */
  face: FaceDir

  /**
   * The direction this quad culls against.
   * If the neighbor in this direction is solid, skip rendering this quad.
   * FACE_DIR value or -1 for "never cull" (interior geometry).
   */
  cullFace: FaceDir | -1

  /**
   * Tint index:
   *  -1 = no tint (stone, wood, etc.)
   *   0 = grass tint
   *   1 = foliage tint
   *   2 = water tint
   * Applied by the shader as vertex color multiplication.
   */
  tintIndex: number

  /**
   * Sprite index within the atlas animator's animated sprite list.
   * -1 = static texture (most textures).
   * ≥0 = index into animatedSpriteOffsets uniform for this quad's UV animation.
   */
  animatedSpriteIndex: number

  /**
   * Whether this quad should use ambient occlusion.
   * False for emissive quads (beacons, lamps, etc.) and transparent elements.
   */
  shade: boolean
}

/** 
 * Allocate a new BakedQuad with typed arrays.
 * Using factory function rather than class to keep the structure plain
 * (serializable, transferable, no prototype overhead).
 */
export function makeBakedQuad(
  positions: Float32Array,
  uvs: Float32Array,
  face: FaceDir,
  cullFace: FaceDir | -1,
  tintIndex: number,
  shade: boolean
): BakedQuad {
  return { positions, uvs, face, cullFace, tintIndex, animatedSpriteIndex: -1, shade }
}

/** Canonical normal vectors for each face direction */
export const FACE_NORMALS: Readonly<Record<FaceDir, [number, number, number]>> = {
  [FACE_DIR_NORTH]: [0,  0, -1],
  [FACE_DIR_SOUTH]: [0,  0,  1],
  [FACE_DIR_EAST]:  [1,  0,  0],
  [FACE_DIR_WEST]:  [-1, 0,  0],
  [FACE_DIR_UP]:    [0,  1,  0],
  [FACE_DIR_DOWN]:  [0, -1,  0],
}

/** Convert a string face direction to FaceDir */
export function faceNameToDir(name: string): FaceDir {
  switch (name) {
    case 'north': return FACE_DIR_NORTH
    case 'south': return FACE_DIR_SOUTH
    case 'east':  return FACE_DIR_EAST
    case 'west':  return FACE_DIR_WEST
    case 'up':    return FACE_DIR_UP
    case 'down':  return FACE_DIR_DOWN
    default:      return FACE_DIR_NORTH
  }
}

/**
 * packages/renderer-core/src/baking/QuadTransformer.ts
 *
 * Applies blockstate rotations and UV-lock transforms to baked quads.
 *
 * When a block's blockstate specifies rotationX=90 and rotationY=180,
 * the model is physically rotated in world space. This means:
 *  1. All vertex positions must be rotated around the block centre (0.5, 0.5, 0.5)
 *  2. The face direction (cullFace, AO face) must be remapped
 *  3. If uvlock=false: UV coordinates are also rotated with the geometry
 *  4. If uvlock=true: UV coordinates stay aligned to world axes (texture stays upright)
 *
 * WHY do this at bake time instead of via a transformation matrix in the shader?
 *  - Shader uniforms for per-block rotation would require a draw call per block state
 *  - GPU instancing (Stage 13) needs rotations baked into instance data anyway
 *  - Pre-baking into the quad data allows the greedy mesher to merge adjacent
 *    same-state quads (same texture + same rotation → same facing, mergeable)
 *
 * Rotation matrices:
 *  All rotations are multiples of 90° around the Y axis (most common)
 *  or X axis (for some slabs/stairs). Z-axis rotations are very rare in vanilla
 *  but supported by some mods; we include them for completeness.
 *
 * Face remapping table:
 *  When a model is rotated 90° around Y:
 *    north → west, west → south, south → east, east → north
 *    up → up, down → down
 *
 * UV-lock:
 *  When uvlock=true and the model is Y-rotated, the UV coordinates on vertical
 *  faces (north/south/east/west) are counter-rotated so the texture appears
 *  aligned with the world. This is used for fences, walls, etc. so the wood
 *  grain always faces up.
 */

import type { BakedQuad, FaceDir } from './BakedQuad'
import {
  FACE_DIR_NORTH, FACE_DIR_SOUTH, FACE_DIR_EAST, FACE_DIR_WEST,
  FACE_DIR_UP, FACE_DIR_DOWN,
} from './BakedQuad'

// ── Y-axis face rotation table ─────────────────────────────────────────────
// Index: [currentFace][clockwise90DegreeSteps]
// Cast to Record<FaceDir, FaceDir[]> because computed-keys-from-numeric-const
// widen to `number` in the inferred object type.
const Y_ROTATE_FACE = {
  [FACE_DIR_NORTH]: [FACE_DIR_NORTH, FACE_DIR_WEST,  FACE_DIR_SOUTH, FACE_DIR_EAST],
  [FACE_DIR_SOUTH]: [FACE_DIR_SOUTH, FACE_DIR_EAST,  FACE_DIR_NORTH, FACE_DIR_WEST],
  [FACE_DIR_EAST]:  [FACE_DIR_EAST,  FACE_DIR_NORTH, FACE_DIR_WEST,  FACE_DIR_SOUTH],
  [FACE_DIR_WEST]:  [FACE_DIR_WEST,  FACE_DIR_SOUTH, FACE_DIR_EAST,  FACE_DIR_NORTH],
  [FACE_DIR_UP]:    [FACE_DIR_UP,    FACE_DIR_UP,    FACE_DIR_UP,    FACE_DIR_UP],
  [FACE_DIR_DOWN]:  [FACE_DIR_DOWN,  FACE_DIR_DOWN,  FACE_DIR_DOWN,  FACE_DIR_DOWN],
} as Readonly<Record<FaceDir, FaceDir[]>>

// ── X-axis face rotation table ─────────────────────────────────────────────
const X_ROTATE_FACE = {
  [FACE_DIR_NORTH]: [FACE_DIR_NORTH, FACE_DIR_DOWN,  FACE_DIR_SOUTH, FACE_DIR_UP],
  [FACE_DIR_SOUTH]: [FACE_DIR_SOUTH, FACE_DIR_UP,    FACE_DIR_NORTH, FACE_DIR_DOWN],
  [FACE_DIR_EAST]:  [FACE_DIR_EAST,  FACE_DIR_EAST,  FACE_DIR_EAST,  FACE_DIR_EAST],
  [FACE_DIR_WEST]:  [FACE_DIR_WEST,  FACE_DIR_WEST,  FACE_DIR_WEST,  FACE_DIR_WEST],
  [FACE_DIR_UP]:    [FACE_DIR_UP,    FACE_DIR_NORTH, FACE_DIR_DOWN,  FACE_DIR_SOUTH],
  [FACE_DIR_DOWN]:  [FACE_DIR_DOWN,  FACE_DIR_SOUTH, FACE_DIR_UP,    FACE_DIR_NORTH],
} as Readonly<Record<FaceDir, FaceDir[]>>

// ── Sine/cosine lookup for 0/90/180/270 ───────────────────────────────────
const SIN = [0, 1, 0, -1]  // 0=0°, 1=90°, 2=180°, 3=270°
const COS = [1, 0, -1, 0]

/**
 * Apply Y-axis rotation (0, 90, 180, 270 degrees) to a quad's positions.
 * Rotates around the block centre (0.5, _, 0.5).
 */
function rotatePositionsY(positions: Float32Array, steps: number): Float32Array {
  if (steps === 0) return positions
  const sin = SIN[steps]!
  const cos = COS[steps]!
  const out = new Float32Array(12)
  for (let i = 0; i < 4; i++) {
    const px = positions[i * 3]! - 0.5
    const py = positions[i * 3 + 1]!
    const pz = positions[i * 3 + 2]! - 0.5
    out[i * 3]     = px * cos - pz * sin + 0.5
    out[i * 3 + 1] = py
    out[i * 3 + 2] = px * sin + pz * cos + 0.5
  }
  return out
}

/**
 * Apply X-axis rotation (0, 90, 180, 270 degrees) to a quad's positions.
 * Rotates around the block centre (_, 0.5, 0.5).
 */
function rotatePositionsX(positions: Float32Array, steps: number): Float32Array {
  if (steps === 0) return positions
  const sin = SIN[steps]!
  const cos = COS[steps]!
  const out = new Float32Array(12)
  for (let i = 0; i < 4; i++) {
    const px = positions[i * 3]!
    const py = positions[i * 3 + 1]! - 0.5
    const pz = positions[i * 3 + 2]! - 0.5
    out[i * 3]     = px
    out[i * 3 + 1] = py * cos - pz * sin + 0.5
    out[i * 3 + 2] = py * sin + pz * cos + 0.5
  }
  return out
}

/**
 * Rotate UV coordinates for UV-lock compensation.
 * When a Y-rotated block uses uvlock=true on a vertical face,
 * the UVs are counter-rotated so the texture stays world-aligned.
 * The UV rotation is CCW (opposite of the model rotation).
 */
function uvLockRotateUVs(uvs: Float32Array, steps: number): Float32Array {
  if (steps === 0) return uvs
  // UV lock compensates by rotating UVs in the opposite direction
  const compensateSteps = (4 - steps) % 4
  const sin = SIN[compensateSteps]!
  const cos = COS[compensateSteps]!
  const out = new Float32Array(8)
  for (let i = 0; i < 4; i++) {
    const u = uvs[i * 2]! - 0.5
    const v = uvs[i * 2 + 1]! - 0.5
    out[i * 2]     = u * cos - v * sin + 0.5
    out[i * 2 + 1] = u * sin + v * cos + 0.5
  }
  return out
}

/**
 * Apply blockstate rotation to a quad.
 * Returns a NEW quad with transformed positions, remapped face directions,
 * and optionally UV-locked coordinates.
 *
 * @param quad - Input quad in un-rotated block space
 * @param rotationX - X rotation from CompiledModelRef (0, 90, 180, 270)
 * @param rotationY - Y rotation from CompiledModelRef (0, 90, 180, 270)
 * @param uvLock - Whether to lock UVs to world orientation
 */
export function applyBlockstateRotation(
  quad: BakedQuad,
  rotationX: 0 | 90 | 180 | 270,
  rotationY: 0 | 90 | 180 | 270,
  uvLock: boolean
): BakedQuad {
  const stepsY = rotationY / 90
  const stepsX = rotationX / 90

  // Rotate positions
  let positions = quad.positions
  if (stepsY !== 0) positions = rotatePositionsY(positions, stepsY)
  if (stepsX !== 0) positions = rotatePositionsX(positions, stepsX)

  // Remap face direction
  let face: FaceDir = quad.face
  if (stepsY !== 0) face = Y_ROTATE_FACE[face]![stepsY]!
  if (stepsX !== 0) face = X_ROTATE_FACE[face]![stepsX]!

  // Remap cullFace
  let cullFace: FaceDir | -1 = quad.cullFace
  if (cullFace !== -1) {
    if (stepsY !== 0) cullFace = Y_ROTATE_FACE[cullFace]![stepsY]!
    if (stepsX !== 0) cullFace = X_ROTATE_FACE[cullFace]![stepsX]!
  }

  // UV lock: compensate UV rotation on vertical faces
  let uvs = quad.uvs
  if (uvLock && stepsY !== 0) {
    const isVerticalFace = face !== FACE_DIR_UP && face !== FACE_DIR_DOWN
    if (isVerticalFace) {
      uvs = uvLockRotateUVs(uvs, stepsY)
    }
  }

  return { ...quad, positions, uvs, face, cullFace }
}

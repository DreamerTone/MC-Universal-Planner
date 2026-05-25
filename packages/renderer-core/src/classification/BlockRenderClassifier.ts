import type { BakedModel } from '../baking/ModelBaker'
import type { BakedQuad, FaceDir } from '../baking/BakedQuad'
import {
  FACE_DIR_NORTH,
  FACE_DIR_SOUTH,
  FACE_DIR_EAST,
  FACE_DIR_WEST,
  FACE_DIR_UP,
  FACE_DIR_DOWN,
} from '../baking/BakedQuad'
import type { RenderProfile, SimpleCubeProfile } from './RenderProfile'
import { EMPTY_RENDER_PROFILE } from './RenderProfile'

const ALL_FACES: FaceDir[] = [
  FACE_DIR_NORTH,
  FACE_DIR_SOUTH,
  FACE_DIR_EAST,
  FACE_DIR_WEST,
  FACE_DIR_UP,
  FACE_DIR_DOWN,
]

export function classifyBakedModels(models: BakedModel[]): RenderProfile {
  if (models.length === 0) return EMPTY_RENDER_PROFILE

  // The first safe/valuable classification is the one that solves most blocks:
  // exactly one full-cube model with one outward quad per face. That covers
  // stone, dirt, ores, planks, bricks, concrete, many modded decorative cubes,
  // and simple per-face cubes like grass/log-like models once resolved.
  if (models.length === 1 && models[0]?.isFullCube) {
    const cube = classifySimpleCube(models[0])
    if (cube) return cube
  }

  // Multipart blocks and complex static models stay on the generic fallback.
  // This keeps fences/panes/stairs/flowers safe while cube blocks get the
  // cleaner cube path.
  return {
    kind: models.length > 1 ? 'multipart_model' : 'static_model',
    opaque: models.some(m => m.isFullCube && !m.hasTranslucency),
    reason: 'not a single six-face full cube',
  }
}

function classifySimpleCube(model: BakedModel): SimpleCubeProfile | null {
  if (!model.isFullCube) return null
  if (model.quads.length < 6) return null

  const byFace = new Map<FaceDir, BakedQuad>()

  for (const quad of model.quads) {
    // Only exterior cube faces qualify for the simple cube path. Interior or
    // no-cull quads imply custom/static-model geometry.
    if (quad.cullFace !== quad.face) return null
    if (byFace.has(quad.face)) return null
    byFace.set(quad.face, quad)
  }

  for (const face of ALL_FACES) {
    if (!byFace.has(face)) return null
  }

  const faces = {} as SimpleCubeProfile['faces']
  for (const face of ALL_FACES) {
    const quad = byFace.get(face)!
    let u0 = quad.uvs[0]!
    let v0 = quad.uvs[1]!
    let u1 = quad.uvs[0]!
    let v1 = quad.uvs[1]!

    for (let i = 1; i < 4; i++) {
      const u = quad.uvs[i * 2]!
      const v = quad.uvs[i * 2 + 1]!
      if (u < u0) u0 = u
      if (v < v0) v0 = v
      if (u > u1) u1 = u
      if (v > v1) v1 = v
    }

    faces[face] = {
      face,
      u0,
      v0,
      u1,
      v1,
      tintIndex: quad.tintIndex,
      shade: quad.shade,
    }
  }

  return {
    kind: 'simple_cube',
    opaque: !model.hasTranslucency,
    faces,
  }
}

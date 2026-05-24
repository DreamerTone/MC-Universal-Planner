/**
 * packages/renderer-core/src/baking/ModelBaker.ts
 *
 * Model baker — converts a ResolvedModel into BakedQuad[].
 *
 * This is the heart of the rendering pipeline. Given a fully resolved model
 * (parent inheritance walked, textures resolved, geometry flattened) and the
 * atlas sprite registry, it produces a list of BakedQuads in block-local space.
 *
 * Each BakedQuad is GPU-ready:
 *  - Positions in block space [0,1]³ (divided from model space [0,16])
 *  - UVs in atlas space [0,1] (remapped from texture space [0,16] via AtlasSprite)
 *  - CullFace direction for the mesher to skip hidden faces
 *  - TintIndex for biome color application
 *  - Shade flag for AO application
 *
 * Element rotation:
 *  Model elements can have their own rotation (±22.5°, ±45° around any axis).
 *  These are different from blockstate rotations — they're per-element geometry
 *  tweaks (e.g. the slight tilt in grass, the diagonal cross in flower models).
 *  We apply them here by rotating each vertex around the element's rotation origin.
 *
 * Blockstate rotation (rotationX/Y from CompiledModelRef) is applied by
 * QuadTransformer AFTER the element bake — it transforms the whole model.
 *
 * Cache strategy:
 *  Baked quads are cached keyed by:
 *    `${modelId}|${rotationX}|${rotationY}|${uvLock}`
 *  After the atlas is built, baking is a one-time cost per unique model+rotation.
 *  The bake cache is invalidated when the atlas is rebuilt (JAR reload).
 *
 * Vertex generation (4 vertices per quad):
 *  For each element face, we generate 4 corner vertices of the face rectangle
 *  in block-local space, then map each corner's texture coordinates to atlas UV.
 *
 * UV interpolation:
 *  The face UV rectangle [u1,v1, u2,v2] in [0,16] space maps to a sub-region
 *  of the sprite in atlas space. The four corners are:
 *    v0: (u1, v1)  v1: (u2, v1)
 *    v3: (u1, v2)  v2: (u2, v2)
 */

import type { ResourceLocation } from '@mc-planner/shared'
import type { ResolvedModel, ResolvedElement, ResolvedFace } from '../model/ModelResolver'
import type { CompiledModelRef } from '../blockstate/CompiledBlockstate'
import type { AtlasSpriteRegistry } from '../atlas/AtlasBuilder'
import { modelUVToAtlas } from '../atlas/AtlasSprite'
import {
  type BakedQuad, type FaceDir,
  makeBakedQuad, faceNameToDir,
  FACE_DIR_NORTH, FACE_DIR_SOUTH, FACE_DIR_EAST, FACE_DIR_WEST,
  FACE_DIR_UP, FACE_DIR_DOWN,
} from './BakedQuad'
import { applyBlockstateRotation } from './QuadTransformer'

export interface BakedModel {
  /** All quads in block-local space, grouped by cull-face direction */
  quads: BakedQuad[]
  /** True if this model fills the entire 1×1×1 block volume */
  isFullCube: boolean
  /** True if this model has any translucent quads (glass, water) */
  hasTranslucency: boolean
}

export class ModelBaker {
  private readonly cache = new Map<string, BakedModel>()

  constructor(private readonly sprites: AtlasSpriteRegistry) {}

  /**
   * Bake a model ref into GPU-ready quads.
   * Results are cached by (modelId, rotX, rotY, uvlock) key.
   */
  bake(
    modelRef: CompiledModelRef,
    resolvedModel: ResolvedModel
  ): BakedModel {
    const cacheKey =
      `${modelRef.modelId}|${modelRef.rotationX}|${modelRef.rotationY}|${modelRef.uvLock}`

    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const result = this.bakeUncached(modelRef, resolvedModel)
    this.cache.set(cacheKey, result)
    return result
  }

  private bakeUncached(
    modelRef: CompiledModelRef,
    model: ResolvedModel
  ): BakedModel {
    if (!model.elements || model.elements.length === 0) {
      // Entity/generated model — no geometry to bake
      return { quads: [], isFullCube: false, hasTranslucency: false }
    }

    const quads: BakedQuad[] = []
    let hasTranslucency = false

    for (const element of model.elements) {
      const elementQuads = this.bakeElement(element, model.ambientOcclusion)
      for (const quad of elementQuads) {
        // Apply blockstate rotation (Y and X axes)
        const rotated = applyBlockstateRotation(
          quad,
          modelRef.rotationX,
          modelRef.rotationY,
          modelRef.uvLock
        )
        quads.push(rotated)
      }
    }

    const isFullCube = this.checkIsFullCube(model.elements)

    return { quads, isFullCube, hasTranslucency }
  }

  private bakeElement(element: ResolvedElement, ambientOcclusion: boolean): BakedQuad[] {
    const quads: BakedQuad[] = []
    const [fx, fy, fz] = element.from
    const [tx, ty, tz] = element.to

    // Positions in BLOCK space [0,1] (divide by 16)
    const x0 = fx / 16, y0 = fy / 16, z0 = fz / 16
    const x1 = tx / 16, y1 = ty / 16, z1 = tz / 16

    const shade = element.shade && ambientOcclusion

    // Generate one quad per declared face
    const faceDirs: FaceDir[] = [
      FACE_DIR_NORTH, FACE_DIR_SOUTH, FACE_DIR_EAST,
      FACE_DIR_WEST, FACE_DIR_UP, FACE_DIR_DOWN,
    ]
    const faceNames = ['north', 'south', 'east', 'west', 'up', 'down'] as const

    for (let i = 0; i < 6; i++) {
      const dir = faceDirs[i]!
      const name = faceNames[i]!
      const face = element.faces[name]
      if (!face) continue  // Face not declared → not rendered

      const quad = this.bakeFace(
        dir, name, face, x0, y0, z0, x1, y1, z1, shade
      )
      if (quad) quads.push(quad)
    }

    // Apply per-element rotation (axis-angle, ±22.5° or ±45°) if present
    if (element.rotation) {
      const rotated = quads.map(q => applyElementRotation(q, element.rotation!))
      return rotated
    }

    return quads
  }

  private bakeFace(
    dir: FaceDir,
    dirName: 'north' | 'south' | 'east' | 'west' | 'up' | 'down',
    face: ResolvedFace,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    shade: boolean
  ): BakedQuad | null {
    const sprite = this.sprites.get(face.texture)
    const [uv_u1, uv_v1, uv_u2, uv_v2] = face.uv

    // Generate 4 UV corners, applying atlas mapping and UV rotation
    const getUV = (mu: number, mv: number): [number, number] =>
      modelUVToAtlas(sprite, mu, mv, face.uvRotation)

    const [au1, av1] = getUV(uv_u1, uv_v1)
    const [au2, av1b] = getUV(uv_u2, uv_v1)
    const [au2b, av2] = getUV(uv_u2, uv_v2)
    const [au1b, av2b] = getUV(uv_u1, uv_v2)

    const uvs = new Float32Array([
      au1,  av1,   // v0
      au2,  av1b,  // v1
      au2b, av2,   // v2
      au1b, av2b,  // v3
    ])

    // Generate 4 corner positions for this face
    const positions = this.facePositions(dir, x0, y0, z0, x1, y1, z1)

    const cullFace: FaceDir | -1 = face.cullface
      ? faceNameToDir(face.cullface) as FaceDir
      : -1

    return makeBakedQuad(positions, uvs, dir, cullFace, face.tintIndex, shade)
  }

  /**
   * Generate the 4 corner positions of a face in block-local space [0,1]³.
   *
   * Vertex ordering (CCW from outside):
   *  v0 ─────── v1
   *  │           │
   *  v3 ─────── v2
   *
   * This ordering matches the UV mapping:
   *  v0: top-left, v1: top-right, v2: bottom-right, v3: bottom-left
   */
  private facePositions(
    dir: FaceDir,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number
  ): Float32Array {
    switch (dir) {
      case FACE_DIR_NORTH: // z = z0 plane, facing -Z
        return new Float32Array([
          x1, y1, z0,   // v0: top-right
          x0, y1, z0,   // v1: top-left
          x0, y0, z0,   // v2: bottom-left
          x1, y0, z0,   // v3: bottom-right
        ])
      case FACE_DIR_SOUTH: // z = z1 plane, facing +Z
        return new Float32Array([
          x0, y1, z1,
          x1, y1, z1,
          x1, y0, z1,
          x0, y0, z1,
        ])
      case FACE_DIR_EAST: // x = x1 plane, facing +X
        return new Float32Array([
          x1, y1, z1,
          x1, y1, z0,
          x1, y0, z0,
          x1, y0, z1,
        ])
      case FACE_DIR_WEST: // x = x0 plane, facing -X
        return new Float32Array([
          x0, y1, z0,
          x0, y1, z1,
          x0, y0, z1,
          x0, y0, z0,
        ])
      case FACE_DIR_UP: // y = y1 plane, facing +Y
        return new Float32Array([
          x0, y1, z0,
          x1, y1, z0,
          x1, y1, z1,
          x0, y1, z1,
        ])
      case FACE_DIR_DOWN: // y = y0 plane, facing -Y
        return new Float32Array([
          x0, y0, z1,
          x1, y0, z1,
          x1, y0, z0,
          x0, y0, z0,
        ])
    }
  }

  private checkIsFullCube(elements: ResolvedElement[]): boolean {
    if (elements.length !== 1) return false
    const e = elements[0]!
    return (
      e.from[0] <= 0.01 && e.from[1] <= 0.01 && e.from[2] <= 0.01 &&
      e.to[0]   >= 15.99 && e.to[1]  >= 15.99 && e.to[2]  >= 15.99
    )
  }

  get cachedModelCount(): number { return this.cache.size }

  clearCache(): void { this.cache.clear() }
}

// ── Per-element rotation ───────────────────────────────────────────────────

/**
 * Apply per-element rotation to a quad's positions.
 * Rotates around element.rotation.origin by element.rotation.angle degrees
 * on the specified axis.
 *
 * Minecraft only allows ±22.5° and ±45° (to keep vertices on pixel grid).
 * Non-multiples-of-90 angles mean we can't use the integer SIN/COS table.
 */
function applyElementRotation(
  quad: BakedQuad,
  rotation: {
    origin: [number, number, number]
    axis: 'x' | 'y' | 'z'
    angle: number
    rescale: boolean
  }
): BakedQuad {
  const rad = (rotation.angle * Math.PI) / 180
  const sin = Math.sin(rad)
  const cos = Math.cos(rad)
  const [ox, oy, oz] = rotation.origin.map(v => v / 16) as [number, number, number]

  const positions = new Float32Array(12)

  for (let i = 0; i < 4; i++) {
    let px = quad.positions[i * 3]!     - ox
    let py = quad.positions[i * 3 + 1]! - oy
    let pz = quad.positions[i * 3 + 2]! - oz

    let rx = px, ry = py, rz = pz

    switch (rotation.axis) {
      case 'y': rx =  px * cos - pz * sin; rz = px * sin + pz * cos; ry = py; break
      case 'x': ry =  py * cos - pz * sin; rz = py * sin + pz * cos; rx = px; break
      case 'z': rx =  px * cos - py * sin; ry = px * sin + py * cos; rz = pz; break
    }

    // Rescale: compensate for the longer diagonal after rotation
    // (makes rotated elements fill their original bounding box)
    if (rotation.rescale) {
      const scale = 1 / Math.cos(rad)
      rx *= scale; ry *= scale; rz *= scale
    }

    positions[i * 3]     = rx + ox
    positions[i * 3 + 1] = ry + oy
    positions[i * 3 + 2] = rz + oz
  }

  return { ...quad, positions }
}

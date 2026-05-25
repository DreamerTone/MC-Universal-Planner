/**
 * packages/renderer-core/src/baking/ModelBaker.ts
 *
 * Model baker — converts a ResolvedModel into BakedQuad[].
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
  quads: BakedQuad[]
  isFullCube: boolean
  hasTranslucency: boolean
}

const loggedTextureIssues = new Set<string>()

export class ModelBaker {
  private readonly cache = new Map<string, BakedModel>()

  constructor(private readonly sprites: AtlasSpriteRegistry) {}

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
      return { quads: [], isFullCube: false, hasTranslucency: false }
    }

    const quads: BakedQuad[] = []
    let hasTranslucency = false

    for (const element of model.elements) {
      const elementQuads = this.bakeElement(element, model.ambientOcclusion, modelRef.modelId)
      for (const quad of elementQuads) {
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

  private bakeElement(element: ResolvedElement, ambientOcclusion: boolean, modelId: ResourceLocation): BakedQuad[] {
    const quads: BakedQuad[] = []
    const [fx, fy, fz] = element.from
    const [tx, ty, tz] = element.to

    const x0 = fx / 16, y0 = fy / 16, z0 = fz / 16
    const x1 = tx / 16, y1 = ty / 16, z1 = tz / 16
    const shade = element.shade && ambientOcclusion

    const faceDirs: FaceDir[] = [
      FACE_DIR_NORTH, FACE_DIR_SOUTH, FACE_DIR_EAST,
      FACE_DIR_WEST, FACE_DIR_UP, FACE_DIR_DOWN,
    ]
    const faceNames = ['north', 'south', 'east', 'west', 'up', 'down'] as const

    for (let i = 0; i < 6; i++) {
      const dir = faceDirs[i]!
      const name = faceNames[i]!
      const face = element.faces[name]
      if (!face) continue

      const quad = this.bakeFace(
        dir, face, x0, y0, z0, x1, y1, z1, shade, modelId
      )
      if (quad) quads.push(quad)
    }

    if (element.rotation) {
      return quads.map(q => applyElementRotation(q, element.rotation!))
    }

    return quads
  }

  private bakeFace(
    dir: FaceDir,
    face: ResolvedFace,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    shade: boolean,
    modelId: ResourceLocation
  ): BakedQuad | null {
    this.logMissingTextureOnce(modelId, face.texture)

    const sprite = this.sprites.get(face.texture)
    const [uv_u1, uv_v1, uv_u2, uv_v2] = face.uv

    const getUV = (mu: number, mv: number): [number, number] =>
      modelUVToAtlas(sprite, mu, mv, face.uvRotation)

    const [au1, av1] = getUV(uv_u1, uv_v1)
    const [au2, av1b] = getUV(uv_u2, uv_v1)
    const [au2b, av2] = getUV(uv_u2, uv_v2)
    const [au1b, av2b] = getUV(uv_u1, uv_v2)

    const uvs = new Float32Array([
      au1,  av1,
      au2,  av1b,
      au2b, av2,
      au1b, av2b,
    ])

    const positions = this.facePositions(dir, x0, y0, z0, x1, y1, z1)
    const cullFace: FaceDir | -1 = face.cullface
      ? faceNameToDir(face.cullface) as FaceDir
      : -1

    return makeBakedQuad(positions, uvs, dir, cullFace, face.tintIndex, shade)
  }

  private logMissingTextureOnce(modelId: ResourceLocation, texture: ResourceLocation): void {
    if (this.sprites.has(texture) && texture !== 'minecraft:block/missing') return
    const key = `${modelId}|${texture}`
    if (loggedTextureIssues.has(key)) return
    loggedTextureIssues.add(key)

    // Debug-level because missing model/texture references are common in real
    // Minecraft jars and modpacks. They should not look like pipeline failure
    // once the atlas and classification passes are healthy.
    console.debug(`[ModelBaker] Missing texture fallback: model=${modelId}, texture=${texture}`)
  }

  private facePositions(
    dir: FaceDir,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number
  ): Float32Array {
    switch (dir) {
      case FACE_DIR_NORTH:
        return new Float32Array([
          x1, y1, z0,
          x0, y1, z0,
          x0, y0, z0,
          x1, y0, z0,
        ])
      case FACE_DIR_SOUTH:
        return new Float32Array([
          x0, y1, z1,
          x1, y1, z1,
          x1, y0, z1,
          x0, y0, z1,
        ])
      case FACE_DIR_EAST:
        return new Float32Array([
          x1, y1, z1,
          x1, y1, z0,
          x1, y0, z0,
          x1, y0, z1,
        ])
      case FACE_DIR_WEST:
        return new Float32Array([
          x0, y1, z0,
          x0, y1, z1,
          x0, y0, z1,
          x0, y0, z0,
        ])
      case FACE_DIR_UP:
        return new Float32Array([
          x0, y1, z0,
          x1, y1, z0,
          x1, y1, z1,
          x0, y1, z1,
        ])
      case FACE_DIR_DOWN:
        return new Float32Array([
          x0, y0, z1,
          x1, y0, z1,
          x1, y0, z0,
          x0, y0, z0,
        ])
      default:
        return new Float32Array(12)
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

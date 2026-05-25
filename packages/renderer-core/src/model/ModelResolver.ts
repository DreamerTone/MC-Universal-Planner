/**
 * packages/renderer-core/src/model/ModelResolver.ts
 *
 * Model resolution — walks parent inheritance chains and produces a
 * fully-flattened model ready for baking.
 *
 * WHY a separate resolver step?
 * Minecraft model inheritance can be DEEP. A typical block model:
 *
 *   minecraft:block/grass_block
 *     inherits: minecraft:block/block (defines element geometry)
 *     textures: { "top": "grass_top", "side": "grass_side_overlay", ... }
 *
 *   minecraft:block/cube_column
 *     inherits: minecraft:block/block
 *     textures: { "end": "...", "side": "..." }
 *
 * Some mods have inheritance chains 8-10 levels deep. Resolving the chain
 * at bake time (per-model) would walk the chain every time a model is baked.
 * Instead, we resolve once and cache the flattened result.
 *
 * Resolution algorithm:
 *  1. Fetch model JSON for the given resource location
 *  2. If it has a "parent", recursively resolve the parent
 *  3. Merge (child overrides parent):
 *     - textures: child definitions override parent variables
 *     - elements: child elements REPLACE parent elements (if defined)
 *     - ambientocclusion: child overrides parent
 *  4. Resolve all "#variable" texture references to actual resource locations
 *
 * Important inheritance detail:
 *  Parent elements MUST stay raw until the full parent+child texture map is
 *  merged. Vanilla models like stone inherit cube_all/cube geometry whose
 *  faces reference #all, but #all is defined only by the child stone model.
 *  Resolving parent faces before child texture overrides exist turns those
 *  faces into minecraft:block/missing.
 *
 * Resolution terminates at:
 *  - "minecraft:builtin/generated"   (item model, flat sprite)
 *  - "minecraft:builtin/entity"      (entity model, handled by BESR)
 *  - A model with no parent and concrete elements
 *
 * Cycle detection:
 *  Tracks visited IDs during resolution to prevent infinite loops.
 *  (Some broken mod models have circular inheritance.)
 *
 * Caching:
 *  Resolved models are cached by resource location.
 *  Cache is keyed by resource location — invalidated when JARs change.
 */

import type { ResourceLocation } from '@mc-planner/shared'
import type { ModelJson, ModelElement, ModelFace, FaceDirection } from './ModelJson'

export interface ResolvedModel {
  /** The resource location this model was resolved from */
  id: ResourceLocation
  /**
   * Fully resolved elements with texture variables replaced.
   * Null for builtin models (entity, generated).
   */
  elements: ResolvedElement[] | null
  /** Whether to apply ambient occlusion */
  ambientOcclusion: boolean
  /** Resolved textures: variable name → actual resource location */
  textures: Record<string, ResourceLocation>
  /**
   * Special model type for non-geometry models.
   * Most blocks are 'geometry'; items without custom models are 'generated'.
   */
  modelType: 'geometry' | 'generated' | 'entity'
}

export interface ResolvedElement {
  from: [number, number, number]
  to:   [number, number, number]
  rotation?: {
    origin: [number, number, number]
    axis: 'x' | 'y' | 'z'
    angle: number
    rescale: boolean
  }
  shade: boolean
  faces: Partial<Record<FaceDirection, ResolvedFace>>
}

export interface ResolvedFace {
  /** UV in texture space [0, 16] */
  uv: [number, number, number, number]
  /** Resolved texture resource location (e.g. 'minecraft:block/stone') */
  texture: ResourceLocation
  /** Face direction to cull against (or null for no culling) */
  cullface: FaceDirection | null
  /** UV rotation degrees */
  uvRotation: 0 | 90 | 180 | 270
  /** Tint index (-1 = no tint) */
  tintIndex: number
}

interface MergedRawModel {
  id: ResourceLocation
  elements: ModelElement[] | null
  ambientOcclusion: boolean
  textures: Record<string, string>
  modelType: 'geometry' | 'generated' | 'entity'
}

// ── Model Resolver ─────────────────────────────────────────────────────────

type JsonFetcher = (id: ResourceLocation) => Promise<string | null>

export class ModelResolver {
  private readonly cache = new Map<ResourceLocation, ResolvedModel>()
  private readonly inflight = new Map<ResourceLocation, Promise<ResolvedModel | null>>()

  constructor(private readonly fetchJson: JsonFetcher) {}

  /**
   * Resolve a model by resource location.
   * Returns null for builtin/invalid models.
   * Results are cached — subsequent calls for the same ID are instant.
   */
  async resolve(modelId: ResourceLocation): Promise<ResolvedModel | null> {
    if (this.cache.has(modelId)) return this.cache.get(modelId)!

    // Deduplicate concurrent requests for the same model
    if (this.inflight.has(modelId)) return this.inflight.get(modelId)!

    const promise = this.resolveUncached(modelId)
    this.inflight.set(modelId, promise)

    const result = await promise
    this.inflight.delete(modelId)
    if (result) this.cache.set(modelId, result)

    return result
  }

  private async resolveUncached(
    modelId: ResourceLocation,
    visitedIds: Set<ResourceLocation> = new Set()
  ): Promise<ResolvedModel | null> {
    const merged = await this.resolveMergedRaw(modelId, visitedIds)
    if (!merged) return this.makeMissingModel(modelId)

    if (merged.modelType === 'entity' || merged.modelType === 'generated') {
      return {
        id: modelId,
        elements: null,
        ambientOcclusion: merged.ambientOcclusion,
        textures: {},
        modelType: merged.modelType,
      }
    }

    const resolvedTextures = resolveTextureMap(merged.textures)
    const elements = merged.elements
      ? merged.elements.map(el => resolveElement(el, resolvedTextures))
      : null

    return {
      id: modelId,
      elements,
      ambientOcclusion: merged.ambientOcclusion,
      textures: resolvedTextures,
      modelType: merged.modelType,
    }
  }

  private async resolveMergedRaw(
    modelId: ResourceLocation,
    visitedIds: Set<ResourceLocation>
  ): Promise<MergedRawModel | null> {
    // Cycle detection
    if (visitedIds.has(modelId)) {
      console.warn(`[ModelResolver] Circular model inheritance detected at ${modelId}`)
      return null
    }
    visitedIds.add(modelId)

    // Check builtin terminals
    if (modelId.includes('builtin/entity')) {
      return { id: modelId, elements: null, ambientOcclusion: false, textures: {}, modelType: 'entity' }
    }
    if (modelId.includes('builtin/generated') || modelId.includes('builtin/')) {
      return { id: modelId, elements: null, ambientOcclusion: true, textures: {}, modelType: 'generated' }
    }

    // Fetch raw JSON
    const json = await this.fetchJson(modelId)
    if (!json) {
      // Missing model — return a fallback "error" cube (magenta/black checkerboard texture is conventional)
      return null
    }

    let modelData: ModelJson
    try {
      modelData = JSON.parse(json) as ModelJson
    } catch {
      console.error(`[ModelResolver] Failed to parse model JSON for ${modelId}`)
      return null
    }

    // Resolve parent first (depth-first), but keep inherited elements raw.
    let parentMerged: MergedRawModel | null = null
    if (modelData.parent) {
      const parentId = normalizeModelId(modelData.parent)
      parentMerged = await this.resolveMergedRaw(parentId, new Set(visitedIds))
    }

    return mergeRawModels(modelId, modelData, parentMerged)
  }

  private makeMissingModel(id: ResourceLocation): ResolvedModel {
    // A full unit cube with a "missing" texture reference
    // The atlas builder substitutes a magenta/black checkerboard for missing textures
    return {
      id,
      ambientOcclusion: true,
      modelType: 'geometry',
      textures: { all: 'minecraft:block/missing' as ResourceLocation },
      elements: [{
        from: [0, 0, 0],
        to: [16, 16, 16],
        shade: true,
        faces: {
          north: { uv: [0, 0, 16, 16], texture: 'minecraft:block/missing' as ResourceLocation, cullface: 'north', uvRotation: 0, tintIndex: -1 },
          south: { uv: [0, 0, 16, 16], texture: 'minecraft:block/missing' as ResourceLocation, cullface: 'south', uvRotation: 0, tintIndex: -1 },
          east:  { uv: [0, 0, 16, 16], texture: 'minecraft:block/missing' as ResourceLocation, cullface: 'east',  uvRotation: 0, tintIndex: -1 },
          west:  { uv: [0, 0, 16, 16], texture: 'minecraft:block/missing' as ResourceLocation, cullface: 'west',  uvRotation: 0, tintIndex: -1 },
          up:    { uv: [0, 0, 16, 16], texture: 'minecraft:block/missing' as ResourceLocation, cullface: 'up',    uvRotation: 0, tintIndex: -1 },
          down:  { uv: [0, 0, 16, 16], texture: 'minecraft:block/missing' as ResourceLocation, cullface: 'down',  uvRotation: 0, tintIndex: -1 },
        },
      }],
    }
  }

  get cachedCount(): number { return this.cache.size }

  clearCache(): void {
    this.cache.clear()
  }
}

// ── Merge Logic ────────────────────────────────────────────────────────────

/**
 * Merge a child model onto a raw merged parent.
 *
 * Rules:
 * - textures: child overrides parent (but both contribute to the final map)
 * - elements: child elements REPLACE parent if child has any elements
 * - ambientocclusion: child overrides if specified
 */
function mergeRawModels(
  id: ResourceLocation,
  child: ModelJson,
  parent: MergedRawModel | null
): MergedRawModel {
  const baseTextures: Record<string, string> = { ...(parent?.textures ?? {}) }
  const baseElements = parent?.elements ?? null
  const baseAO = parent?.ambientOcclusion ?? true
  const baseType = parent?.modelType ?? 'geometry'

  const mergedTextures: Record<string, string> = { ...baseTextures, ...(child.textures ?? {}) }

  const elements = child.elements && child.elements.length > 0
    ? child.elements
    : baseElements

  return {
    id,
    elements,
    ambientOcclusion: child.ambientocclusion ?? baseAO,
    textures: mergedTextures,
    modelType: baseType,
  }
}

/**
 * Resolve all "#variable" references in a texture map.
 * May need multiple passes if variables reference other variables.
 * e.g. { "all": "#base", "base": "minecraft:block/stone" }
 */
function resolveTextureMap(raw: Record<string, string>): Record<string, ResourceLocation> {
  const resolved: Record<string, string> = { ...raw }
  const MAX_PASSES = 10

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let anyResolved = false
    for (const [key, value] of Object.entries(resolved)) {
      if (value.startsWith('#')) {
        const varName = value.slice(1)
        const target = resolved[varName]
        if (target && !target.startsWith('#')) {
          resolved[key] = target
          anyResolved = true
        }
      }
    }
    if (!anyResolved) break
  }

  // Any remaining "#..." refs are unresolved — substitute missing texture
  for (const [key, value] of Object.entries(resolved)) {
    if (value.startsWith('#')) {
      resolved[key] = 'minecraft:block/missing'
    } else if (!value.includes(':')) {
      resolved[key] = `minecraft:${value}`
    }
  }

  return resolved as Record<string, ResourceLocation>
}

/**
 * Resolve a raw ModelElement: replace "#variable" texture refs, normalize UVs.
 */
function resolveElement(el: ModelElement, textures: Record<string, string>): ResolvedElement {
  const resolvedFaces: Partial<Record<FaceDirection, ResolvedFace>> = {}

  const faceDirections: FaceDirection[] = ['north', 'south', 'east', 'west', 'up', 'down']

  for (const dir of faceDirections) {
    const face = el.faces?.[dir]
    if (!face) continue

    resolvedFaces[dir] = resolveFace(face, el.from, el.to, dir, textures)
  }

  const out: ResolvedElement = {
    from: el.from,
    to:   el.to,
    shade:  el.shade ?? true,
    faces:  resolvedFaces,
  }
  if (el.rotation) {
    out.rotation = {
      origin: el.rotation.origin,
      axis:   el.rotation.axis,
      angle:  el.rotation.angle,
      rescale: el.rotation.rescale ?? false,
    }
  }
  return out
}

function resolveFace(
  face: ModelFace,
  from: [number, number, number],
  to: [number, number, number],
  dir: FaceDirection,
  textures: Record<string, string>
): ResolvedFace {
  // Resolve texture variable
  let texRef = face.texture
  if (texRef.startsWith('#')) {
    texRef = textures[texRef.slice(1)] ?? 'minecraft:block/missing'
  }

  // Compute default UV if not specified (projects the face onto the texture)
  const uv: [number, number, number, number] = face.uv
    ? [...face.uv] as [number, number, number, number]
    : computeDefaultUV(from, to, dir)

  return {
    uv,
    texture: (texRef.includes(':') ? texRef : `minecraft:${texRef}`) as ResourceLocation,
    cullface: face.cullface ?? null,
    uvRotation: face.rotation ?? 0,
    tintIndex: face.tintindex ?? -1,
  }
}

/**
 * Compute the default UV for a face when no explicit UV is provided.
 * Projects the element's bounds onto the face plane.
 * Results are in texture space [0, 16].
 */
function computeDefaultUV(
  from: [number, number, number],
  to: [number, number, number],
  dir: FaceDirection
): [number, number, number, number] {
  switch (dir) {
    case 'north': return [16 - to[0],   16 - to[1],   16 - from[0], 16 - from[1]]
    case 'south': return [from[0],       16 - to[1],   to[0],        16 - from[1]]
    case 'east':  return [16 - to[2],   16 - to[1],   16 - from[2], 16 - from[1]]
    case 'west':  return [from[2],       16 - to[1],   to[2],        16 - from[1]]
    case 'up':    return [from[0],       from[2],      to[0],        to[2]]
    case 'down':  return [from[0],       16 - to[2],   to[0],        16 - from[2]]
  }
}

/**
 * Normalize a model resource location:
 * "block/stone" → "minecraft:block/stone"
 * "minecraft:block/stone" → "minecraft:block/stone"
 */
function normalizeModelId(raw: string): ResourceLocation {
  if (raw.includes(':')) return raw as ResourceLocation
  return `minecraft:${raw}` as ResourceLocation
}

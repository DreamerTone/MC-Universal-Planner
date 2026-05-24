/**
 * packages/renderer-core/src/model/ModelJson.ts
 *
 * TypeScript types mirroring Minecraft's block/item model JSON format.
 *
 * Source: https://minecraft.wiki/w/Tutorials/Models#Block_models
 *
 * Key features of the format:
 *
 * PARENT INHERITANCE:
 *   Every model can have a "parent" which it inherits textures and elements from.
 *   The root parent is "minecraft:block/block" (defines the 1-unit cube transform).
 *   A model inheriting from a parent OVERRIDES the parent's texture variables
 *   but does NOT re-declare elements — it uses the parent's.
 *
 *   Example chain:
 *     minecraft:block/stone
 *       → parent: minecraft:block/cube_all
 *         → parent: minecraft:block/cube
 *           → parent: minecraft:block/block
 *
 * TEXTURE VARIABLES:
 *   Texture references use "#variable" syntax.
 *   e.g. { "all": "minecraft:block/stone" } defines "#all".
 *   A face references "#all" → resolved to "minecraft:block/stone" at bake time.
 *
 * ELEMENTS:
 *   A model element is a box (cuboid) in model space [0, 16]^3.
 *   Each face of the box has a UV rectangle and texture reference.
 *   Faces can specify 'cullface' to hide when the adjacent block is solid.
 *   Faces can specify 'tintindex' for biome coloring.
 *
 * DISPLAY TRANSFORMS:
 *   Optional per-context transforms (head, hand, gui, ground, etc.).
 *   Used for item rendering, not block rendering. Included for completeness.
 */

export interface ModelJson {
  /** Parent model resource location, e.g. "minecraft:block/cube_all" */
  parent?: string
  /** Ambient occlusion flag (default: true) */
  ambientocclusion?: boolean
  /** Texture variable definitions: { "all": "minecraft:block/stone" } */
  textures?: Record<string, string>
  /** Cuboid elements defining the model geometry */
  elements?: ModelElement[]
  /** Per-context display transforms (item rendering) */
  display?: Partial<Record<DisplayContext, ModelTransform>>
  /** Minecraft 1.9+ face overrides (not widely used) */
  overrides?: unknown[]
}

export type DisplayContext =
  | 'thirdperson_righthand' | 'thirdperson_lefthand'
  | 'firstperson_righthand' | 'firstperson_lefthand'
  | 'gui' | 'head' | 'ground' | 'fixed'

export interface ModelTransform {
  rotation?: [number, number, number]
  translation?: [number, number, number]
  scale?: [number, number, number]
}

// ── Elements ───────────────────────────────────────────────────────────────

export interface ModelElement {
  /** Start corner in model space [0, 16]^3 */
  from: [number, number, number]
  /** End corner in model space [0, 16]^3 */
  to:   [number, number, number]
  /** Optional rotation for this element */
  rotation?: ElementRotation
  /** Whether to shade this element (default: true) */
  shade?: boolean
  /** Faces of this element. Missing faces are invisible. */
  faces?: Partial<Record<FaceDirection, ModelFace>>
}

export type FaceDirection = 'north' | 'south' | 'east' | 'west' | 'up' | 'down'

export interface ElementRotation {
  /** Pivot point in model space [0, 16]^3 */
  origin: [number, number, number]
  /** Axis to rotate around */
  axis: 'x' | 'y' | 'z'
  /** Angle in degrees: -45, -22.5, 0, 22.5, 45 */
  angle: number
  /** Whether to rescale the element after rotation (default: false) */
  rescale?: boolean
}

export interface ModelFace {
  /**
   * UV rectangle [u1, v1, u2, v2] in texture space [0, 16].
   * Defaults to the projected face bounds if omitted.
   */
  uv?: [number, number, number, number]
  /**
   * Texture variable reference, e.g. "#all" or "#side".
   * Must resolve to a texture resource location.
   */
  texture: string
  /**
   * Cull this face when the block in this direction is solid.
   * Matches the face direction unless explicitly overridden.
   */
  cullface?: FaceDirection
  /**
   * Rotate the UV coordinates: 0, 90, 180, 270 degrees.
   * Different from element rotation — only rotates the texture.
   */
  rotation?: 0 | 90 | 180 | 270
  /**
   * Tint index for biome coloring:
   *  -1 or absent = no tint
   *   0 = grass tint
   *   1 = foliage tint
   *   2 = water tint
   */
  tintindex?: number
}

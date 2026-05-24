/**
 * packages/renderer-core/src/atlas/AtlasSprite.ts
 *
 * Sprite descriptor — a texture's location within the atlas.
 *
 * The atlas is a single large GPU texture (DataTexture, RGBA8).
 * Every block texture in the loaded JAR set occupies a rectangular region.
 * A sprite records that region in BOTH pixel coordinates and UV [0,1] space.
 *
 * UV computation:
 *  The model baker needs UV coordinates in atlas space [0,1].
 *  Model JSON UV coordinates are in texture space [0,16].
 *  Conversion:
 *    atlasU = (spriteX + modelU / 16 * spriteW) / atlasW
 *    atlasV = (spriteY + modelV / 16 * spriteH) / atlasH
 *
 * Animated textures:
 *  Some textures are animated (lava, water, fire, prismarine).
 *  Minecraft stores animated textures as tall vertical strips:
 *  a 16×176 PNG contains 11 frames of a 16×16 animated texture.
 *  The atlas stores ONLY the first frame (or all frames if animation is on).
 *  AtlasAnimator (separate system) swaps UV offsets each game tick.
 *
 * Tint support:
 *  Biome-tinted textures (grass, leaves, water) need their base color
 *  multiplied by the biome tint at render time. The sprite records
 *  whether it expects a tint, which the shader reads from vertex attributes.
 */

export interface AtlasSprite {
  /** Resource location of this texture, e.g. 'minecraft:block/stone' */
  resourceLocation: string

  /** Pixel X of this sprite's top-left corner in the atlas */
  x: number
  /** Pixel Y of this sprite's top-left corner in the atlas */
  y: number
  /** Pixel width of this sprite in the atlas (always a power of 2) */
  width: number
  /** Pixel height of this sprite in the atlas (always a power of 2, for square frames) */
  height: number

  /** Atlas total width — needed for UV normalization */
  atlasWidth: number
  /** Atlas total height */
  atlasHeight: number

  /** Number of animation frames. 1 = static. */
  frameCount: number
  /** Frame duration in ticks (20 ticks = 1 second). -1 = not animated. */
  frameTicks: number

  /**
   * Interpolated UV min/max in atlas space [0,1].
   * These are the UV coordinates for the first (or only) frame.
   * Updated by AtlasAnimator each tick for animated sprites.
   */
  u0: number  // left UV edge
  v0: number  // top UV edge (note: OpenGL has Y-up, atlas is Y-down, handled here)
  u1: number  // right UV edge
  v1: number  // bottom UV edge
}

/**
 * Convert model-space UV (in [0,16]) to atlas UV (in [0,1]) for a sprite.
 *
 * @param sprite - The atlas sprite for this texture
 * @param modelU - Horizontal UV in model space [0,16]
 * @param modelV - Vertical UV in model space [0,16]
 * @param uvRotation - UV rotation in degrees (0, 90, 180, 270)
 */
export function modelUVToAtlas(
  sprite: AtlasSprite,
  modelU: number,
  modelV: number,
  uvRotation: 0 | 90 | 180 | 270
): [number, number] {
  // Apply UV rotation (rotates within the 0-16 texture space)
  let u = modelU
  let v = modelV

  switch (uvRotation) {
    case 90:  [u, v] = [16 - v, u];       break
    case 180: [u, v] = [16 - u, 16 - v];  break
    case 270: [u, v] = [v, 16 - u];       break
  }

  // Normalize to [0,1] within the sprite
  const spriteU = u / 16
  const spriteV = v / 16

  // Map to atlas UV space
  const atlasU = (sprite.x + spriteU * sprite.width)  / sprite.atlasWidth
  const atlasV = (sprite.y + spriteV * sprite.height) / sprite.atlasHeight

  return [atlasU, atlasV]
}

/**
 * Missing texture sprite — a 2×2 magenta/black checkerboard.
 * Returned when a texture resource location has no atlas entry.
 */
export function makeMissingSprite(atlasWidth: number, atlasHeight: number): AtlasSprite {
  return {
    resourceLocation: 'minecraft:block/missing',
    x: 0, y: 0, width: 2, height: 2,
    atlasWidth, atlasHeight,
    frameCount: 1, frameTicks: -1,
    u0: 0, v0: 0, u1: 2 / atlasWidth, v1: 2 / atlasHeight,
  }
}

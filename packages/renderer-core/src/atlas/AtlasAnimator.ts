/**
 * packages/renderer-core/src/atlas/AtlasAnimator.ts
 *
 * Manages animated block textures (lava, water, fire, sea lanterns, etc.).
 *
 * Minecraft's animation system:
 *  Animated textures are stored as vertical strips in the PNG file:
 *  a 16×160 PNG = 10 frames of 16×16 each.
 *  The sidecar .png.mcmeta file controls frame timing and order:
 *  { "animation": { "frametime": 2, "frames": [0,1,2,3,4,...] } }
 *
 *  "frametime" is in game ticks (20 ticks = 1 second).
 *  "frames" can specify non-sequential order and repeated frames.
 *
 * Atlas strategy for animation:
 *  Option A: Store ALL frames in the atlas (increases atlas size significantly)
 *  Option B: Store one frame, update UV offset each tick (current approach)
 *
 *  We use Option B: the atlas stores ONLY the first frame of each animated
 *  texture at build time. The AnimatedSprite record tracks the full strip.
 *  Each tick, AtlasAnimator updates the sprite's u0/v0/u1/v1 to point to
 *  the current frame. The shader uniform reads these per-frame UVs.
 *
 *  This approach is O(active_animated_sprites) per tick — very cheap.
 *
 * Shader integration:
 *  Animated sprites use a per-quad UV offset that the chunk shader applies.
 *  Since chunk geometry is uploaded once (not per-frame), animated quads
 *  store their FRAME-0 UV in the vertex buffer plus a sprite index.
 *  Each frame tick, the shader reads the current offset from a uniform buffer
 *  (animatedSpriteOffsets: Float32Array, 4 floats per sprite: du0 dv0 du1 dv1).
 *
 *  For now (pre-shader stage), AtlasAnimator updates the sprite UV directly.
 *  Full shader integration is wired in Stage 11.
 */

import type { AtlasSpriteRegistry } from './AtlasBuilder'

/** Metadata about one animated texture from .png.mcmeta */
export interface AnimationMeta {
  resourceLocation: string
  /** Frame count (number of 16×16 frames in the vertical strip) */
  frameCount: number
  /** Default ticks per frame */
  frametime: number
  /** Frame sequence (indices into the strip) */
  frames: number[]
  /** Whether to interpolate between frames */
  interpolate: boolean
}

export class AtlasAnimator {
  private readonly animated: AnimationMeta[] = []
  private tick = 0

  register(meta: AnimationMeta): void {
    this.animated.push(meta)
  }

  /**
   * Advance one game tick (called at 20 TPS).
   * Updates AtlasSprite UV offsets for all animated textures.
   */
  advance(registry: AtlasSpriteRegistry): void {
    this.tick++

    for (const meta of this.animated) {
      const sprite = registry.get(meta.resourceLocation)
      const frameIdx = Math.floor(this.tick / meta.frametime) % meta.frames.length
      const frame = meta.frames[frameIdx] ?? 0

      // Each frame is spriteHeight / frameCount tall
      const frameH = sprite.height / meta.frameCount
      const frameY = sprite.y + frame * frameH

      sprite.v0 = frameY / sprite.atlasHeight
      sprite.v1 = (frameY + frameH) / sprite.atlasHeight
    }
  }

  get animatedCount(): number { return this.animated.length }

  reset(): void {
    this.tick = 0
    this.animated.length = 0
  }
}

export const globalAtlasAnimator = new AtlasAnimator()

/**
 * Parse Minecraft animation metadata from .png.mcmeta JSON.
 * Returns null if the file is absent or has no animation section.
 */
export function parseAnimationMeta(
  resourceLocation: string,
  mcmetaJson: string
): AnimationMeta | null {
  try {
    const data = JSON.parse(mcmetaJson) as {
      animation?: {
        frametime?: number
        frames?: (number | { index: number; time: number })[]
        interpolate?: boolean
      }
    }
    const anim = data.animation
    if (!anim) return null

    const frametime = anim.frametime ?? 1
    const rawFrames = anim.frames

    // Normalize frame list: [0, 1, {index: 2, time: 4}, ...]
    // Expand timed frames into repeated indices
    const frames: number[] = []
    if (!rawFrames) {
      // No explicit frame list — use sequential frames
      // We don't know frameCount here; caller must supply it
      return {
        resourceLocation,
        frameCount: -1, // filled in by AtlasBuilder from texture height
        frametime,
        frames: [],   // filled in by AtlasBuilder
        interpolate: anim.interpolate ?? false,
      }
    }

    for (const f of rawFrames) {
      if (typeof f === 'number') {
        frames.push(f)
      } else {
        // Expand: repeat this frame for f.time ticks
        for (let t = 0; t < (f.time ?? frametime); t++) {
          frames.push(f.index)
        }
      }
    }

    return {
      resourceLocation,
      frameCount: Math.max(...frames) + 1,
      frametime,
      frames,
      interpolate: anim.interpolate ?? false,
    }
  } catch {
    return null
  }
}

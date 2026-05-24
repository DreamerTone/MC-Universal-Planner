/**
 * packages/renderer-core/src/atlas/AtlasPacker.ts
 *
 * Shelf-Next-Fit rectangle packing algorithm.
 *
 * WHY this algorithm?
 * Texture atlases must pack N rectangles (block textures) into one large
 * rectangle (the GPU texture) with minimal wasted space.
 *
 * Algorithms by quality:
 *   Shelf-Next-Fit  → O(n), ~20% waste — fast enough for live modpack loads
 *   Guillotine      → O(n log n), ~10% waste
 *   MaxRects        → O(n²), ~5% waste — used by TexturePacker, too slow for runtime
 *
 * For our use case (500-5000 textures loaded once per session), Shelf-Next-Fit
 * is the right tradeoff. Minecraft's own atlas uses a similar approach.
 *
 * Constraints:
 *  - All textures are power-of-2 square (16×16, 32×32, 64×64, 128×128).
 *    Larger mods (Create, Farmer's Delight) use 32×32 or 64×64 for detail.
 *  - Textures are sorted by height descending before packing (improves fit).
 *  - Atlas dimensions are always power-of-2 to satisfy GPU alignment requirements.
 *    Most GPUs require width×height to be a power of 2 for mipmap generation.
 *  - Max atlas size: 16384×16384 (guaranteed by WebGL2 spec minimum).
 *    In practice we target 8192×8192 to stay within mobile GPU limits.
 *
 * Output:
 *  Each input texture gets a { x, y } placement within the atlas.
 *  The caller (AtlasBuilder) reads the pixel data and blits it into the right slot.
 */

export interface PackRect {
  id: string
  width: number
  height: number
}

export interface PackedRect extends PackRect {
  x: number
  y: number
}

export interface PackResult {
  placements: PackedRect[]
  atlasWidth: number
  atlasHeight: number
  /** Fraction of atlas space actually used (diagnostic) */
  utilization: number
}

const MAX_ATLAS_DIM = 8192

/**
 * Pack a list of rectangles into the smallest power-of-2 atlas.
 * Uses Shelf-Next-Fit (SNF) with height-descending sort.
 */
export function packRects(rects: PackRect[]): PackResult {
  if (rects.length === 0) {
    return { placements: [], atlasWidth: 1, atlasHeight: 1, utilization: 0 }
  }

  // Sort by height descending (tallest first → less vertical waste per shelf)
  const sorted = [...rects].sort((a, b) => b.height - a.height || b.width - a.width)

  // Binary search for the smallest atlas width that fits everything
  for (let atlasWidth = 256; atlasWidth <= MAX_ATLAS_DIM; atlasWidth *= 2) {
    const result = tryPack(sorted, atlasWidth)
    if (result) {
      const atlasHeight = nextPow2(result.usedHeight)
      const totalArea = atlasWidth * atlasHeight
      const usedArea = rects.reduce((a, r) => a + r.width * r.height, 0)
      return {
        placements: result.placements,
        atlasWidth,
        atlasHeight: Math.min(atlasHeight, MAX_ATLAS_DIM),
        utilization: usedArea / totalArea,
      }
    }
  }

  throw new Error(
    `[AtlasPacker] Cannot fit ${rects.length} textures within ${MAX_ATLAS_DIM}×${MAX_ATLAS_DIM} atlas. ` +
    'Consider splitting into multiple atlases (future: multi-atlas support).'
  )
}

interface ShelfPackResult {
  placements: PackedRect[]
  usedHeight: number
}

function tryPack(sorted: PackRect[], atlasWidth: number): ShelfPackResult | null {
  const placements: PackedRect[] = []
  let shelfX = 0
  let shelfY = 0
  let shelfH = 0

  for (const rect of sorted) {
    if (rect.width > atlasWidth) return null // single texture wider than atlas

    // Does it fit on the current shelf?
    if (shelfX + rect.width > atlasWidth) {
      // Start a new shelf
      shelfY += shelfH
      shelfX = 0
      shelfH = 0
    }

    if (shelfY + rect.height > MAX_ATLAS_DIM) return null // atlas too tall

    placements.push({ ...rect, x: shelfX, y: shelfY })
    shelfX += rect.width
    shelfH = Math.max(shelfH, rect.height)
  }

  return { placements, usedHeight: shelfY + shelfH }
}

function nextPow2(n: number): number {
  if (n <= 1) return 1
  return Math.pow(2, Math.ceil(Math.log2(n)))
}

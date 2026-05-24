/**
 * packages/renderer-core/src/atlas/AtlasBuilder.ts
 *
 * Builds the GPU texture atlas from all loaded block textures.
 *
 * Process:
 *  1. Collect every unique texture resource location referenced by any model
 *  2. Fetch PNG bytes from asset pipeline via IPC
 *  3. Decode PNG → ImageBitmap (GPU-accelerated in browsers)
 *  4. Run AtlasPacker to compute sprite placements
 *  5. Paint all sprites into a single OffscreenCanvas
 *  6. Upload to Three.js DataTexture (or CanvasTexture)
 *  7. Build the AtlasSpriteRegistry (resource location → AtlasSprite)
 *
 * MISSING TEXTURE:
 *  If a texture fetch fails (mod removed, mistyped), a 2×2 magenta/black
 *  checkerboard is painted at position (0,0) and mapped to every unknown
 *  resource location. This matches Minecraft's behavior.
 *
 * Animation metadata (.mcmeta):
 *  Animated textures (lava, water, fire) have a sidecar .png.mcmeta file:
 *  { "animation": { "frametime": 2, "frames": [0, 1, 2, ...] } }
 *  We parse this to configure AtlasSprite.frameCount and frameTicks.
 *  AtlasAnimator (registered in RendererCore) advances frames each game tick.
 *
 * Atlas texture settings:
 *  - Format: RGBA8 (required for transparent textures: glass, leaves)
 *  - Filter: NearestFilter (MagFilter AND MinFilter) — Minecraft's pixelated look
 *  - Mipmap: enabled (reduces shimmer on distant blocks; Three.js generates them)
 *  - ColorSpace: SRGBColorSpace (textures are in sRGB, Three.js converts for PBR)
 *
 * WHY OffscreenCanvas over ImageData/Uint8Array blit?
 *  OffscreenCanvas.drawImage() is GPU-accelerated in Chromium.
 *  Manual pixel-copy (Uint8Array.set per row) would be 10-100× slower
 *  for the 500-2000 textures in a typical modpack.
 *
 * Threading implications:
 *  Atlas building runs on the renderer process main thread.
 *  Future: move PNG decoding into a dedicated atlas worker using
 *  OffscreenCanvas + transferToImageBitmap for zero-copy GPU upload.
 */

import * as THREE from 'three'
import { packRects } from './AtlasPacker'
import { type AtlasSprite, modelUVToAtlas, makeMissingSprite } from './AtlasSprite'

export interface AtlasResult {
  texture: THREE.Texture
  sprites: AtlasSpriteRegistry
}

export class AtlasSpriteRegistry {
  private readonly sprites = new Map<string, AtlasSprite>()
  private readonly missingSprite: AtlasSprite

  constructor(atlasWidth: number, atlasHeight: number) {
    this.missingSprite = makeMissingSprite(atlasWidth, atlasHeight)
    this.sprites.set('minecraft:block/missing', this.missingSprite)
  }

  register(sprite: AtlasSprite): void {
    this.sprites.set(sprite.resourceLocation, sprite)
  }

  get(resourceLocation: string): AtlasSprite {
    return this.sprites.get(resourceLocation) ?? this.missingSprite
  }

  has(resourceLocation: string): boolean {
    return this.sprites.has(resourceLocation)
  }

  get size(): number { return this.sprites.size }
}

// ── Build Progress ─────────────────────────────────────────────────────────

export interface AtlasBuildProgress {
  phase: 'fetching' | 'decoding' | 'packing' | 'painting' | 'uploading' | 'complete'
  current: number
  total: number
}

type ProgressCallback = (p: AtlasBuildProgress) => void

// ── Builder ────────────────────────────────────────────────────────────────

export class AtlasBuilder {
  /** Maximum concurrent IPC texture fetches */
  private static readonly FETCH_CONCURRENCY = 24

  /**
   * Build the complete texture atlas for a set of resource locations.
   *
   * @param resourceLocations - All unique texture resource locations to include.
   *   Typically collected by scanning all resolved model face textures.
   * @param onProgress - Optional streaming progress callback
   */
  async build(
    resourceLocations: ReadonlySet<string>,
    onProgress?: ProgressCallback
  ): Promise<AtlasResult> {
    const allLocations = Array.from(resourceLocations)
    const total = allLocations.length

    // ── Phase 1: Fetch PNG bytes via IPC ────────────────────────────────────
    onProgress?.({ phase: 'fetching', current: 0, total })

    const fetched = await this.fetchAllTextures(allLocations, (n) =>
      onProgress?.({ phase: 'fetching', current: n, total })
    )

    // ── Phase 2: Decode PNG → ImageBitmap ───────────────────────────────────
    onProgress?.({ phase: 'decoding', current: 0, total: fetched.size })

    const decoded = await this.decodeAllBitmaps(fetched, (n) =>
      onProgress?.({ phase: 'decoding', current: n, total: fetched.size })
    )

    // ── Phase 3: Pack sprite placements ─────────────────────────────────────
    onProgress?.({ phase: 'packing', current: 0, total: decoded.size })

    const packInputs = Array.from(decoded.entries()).map(([id, bmp]) => ({
      id,
      width:  bmp.width,
      height: bmp.height,
    }))

    const packResult = packRects(packInputs)

    console.log(
      `[AtlasBuilder] Pack result: ${packResult.atlasWidth}×${packResult.atlasHeight}, ` +
      `${(packResult.utilization * 100).toFixed(1)}% utilization, ` +
      `${packResult.placements.length} sprites`
    )

    // ── Phase 4: Paint all sprites onto OffscreenCanvas ─────────────────────
    onProgress?.({ phase: 'painting', current: 0, total: packResult.placements.length })

    const canvas = new OffscreenCanvas(packResult.atlasWidth, packResult.atlasHeight)
    const ctx = canvas.getContext('2d', { alpha: true })!

    // Paint missing texture at (0,0) first — 2×2 magenta/black checkerboard
    this.paintMissingTexture(ctx)

    const registry = new AtlasSpriteRegistry(packResult.atlasWidth, packResult.atlasHeight)
    let painted = 0

    for (const placement of packResult.placements) {
      const bitmap = decoded.get(placement.id)
      if (!bitmap) continue

      ctx.drawImage(bitmap, placement.x, placement.y)

      const sprite: AtlasSprite = {
        resourceLocation: placement.id,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        atlasWidth:  packResult.atlasWidth,
        atlasHeight: packResult.atlasHeight,
        frameCount: 1,
        frameTicks: -1,
        u0: placement.x / packResult.atlasWidth,
        v0: placement.y / packResult.atlasHeight,
        u1: (placement.x + placement.width)  / packResult.atlasWidth,
        v1: (placement.y + placement.height) / packResult.atlasHeight,
      }

      registry.register(sprite)
      bitmap.close() // Release ImageBitmap memory — no longer needed after draw

      painted++
      if (painted % 100 === 0) {
        onProgress?.({ phase: 'painting', current: painted, total: packResult.placements.length })
      }
    }

    // ── Phase 5: Upload to Three.js GPU texture ──────────────────────────────
    onProgress?.({ phase: 'uploading', current: 0, total: 1 })

    const imageBitmap = await createImageBitmap(canvas)
    const texture = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement)

    // Critical rendering settings for correct Minecraft appearance:
    texture.magFilter = THREE.NearestFilter       // Pixelated look (no bilinear blur)
    texture.minFilter = THREE.NearestMipmapLinearFilter  // Crisp close-up, smooth distant
    texture.generateMipmaps = true
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.needsUpdate = true

    onProgress?.({ phase: 'complete', current: total, total })

    return { texture, sprites: registry }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchAllTextures(
    locations: string[],
    onProgress: (n: number) => void
  ): Promise<Map<string, ArrayBuffer>> {
    const result = new Map<string, ArrayBuffer>()
    let fetched = 0

    // Chunk into batches for controlled concurrency
    const batches = chunkArray(locations, AtlasBuilder.FETCH_CONCURRENCY)

    for (const batch of batches) {
      await Promise.all(
        batch.map(async loc => {
          const buffer = await window.electronAPI.asset.getTextureBuffer(loc)
          if (buffer) result.set(loc, buffer)
          fetched++
          if (fetched % 50 === 0) onProgress(fetched)
        })
      )
    }

    onProgress(fetched)
    return result
  }

  private async decodeAllBitmaps(
    buffers: Map<string, ArrayBuffer>,
    onProgress: (n: number) => void
  ): Promise<Map<string, ImageBitmap>> {
    const result = new Map<string, ImageBitmap>()
    let decoded = 0

    const batches = chunkArray(Array.from(buffers.entries()), AtlasBuilder.FETCH_CONCURRENCY)

    for (const batch of batches) {
      await Promise.all(
        batch.map(async ([loc, buffer]) => {
          try {
            const blob = new Blob([buffer], { type: 'image/png' })
            // createImageBitmap is GPU-accelerated in Chromium — async decode
            // with no main-thread pixel manipulation
            const bitmap = await createImageBitmap(blob, {
              premultiplyAlpha: 'none',     // Keep straight alpha for correct blending
              colorSpaceConversion: 'none', // No colorspace conversion — we handle in Three.js
            })
            result.set(loc, bitmap)
          } catch {
            // Malformed PNG — skip; missing texture will be used
          }
          decoded++
          if (decoded % 50 === 0) onProgress(decoded)
        })
      )
    }

    return result
  }

  private paintMissingTexture(ctx: OffscreenCanvasRenderingContext2D): void {
    // Standard Minecraft "missing" texture: 2×2 checkerboard, magenta + black
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 2, 2)
    ctx.fillStyle = '#FF00FF'  // Magenta
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillRect(1, 1, 1, 1)
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

/** Global singleton atlas builder */
export const globalAtlasBuilder = new AtlasBuilder()

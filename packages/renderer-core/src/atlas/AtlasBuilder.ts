/**
 * packages/renderer-core/src/atlas/AtlasBuilder.ts
 *
 * Builds the GPU texture atlas from all loaded block textures.
 */

import * as THREE from 'three'
import { packRects } from './AtlasPacker'
import { type AtlasSprite, makeMissingSprite } from './AtlasSprite'

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

export interface AtlasBuildProgress {
  phase: 'fetching' | 'decoding' | 'packing' | 'painting' | 'uploading' | 'complete'
  current: number
  total: number
}

type ProgressCallback = (p: AtlasBuildProgress) => void

export class AtlasBuilder {
  private static readonly FETCH_CONCURRENCY = 24

  async build(
    resourceLocations: ReadonlySet<string>,
    onProgress?: ProgressCallback
  ): Promise<AtlasResult> {
    const allLocations = Array.from(resourceLocations)
    const total = allLocations.length

    onProgress?.({ phase: 'fetching', current: 0, total })
    const fetched = await this.fetchAllTextures(allLocations, (n) =>
      onProgress?.({ phase: 'fetching', current: n, total })
    )

    onProgress?.({ phase: 'decoding', current: 0, total: fetched.size })
    const decoded = await this.decodeAllBitmaps(fetched, (n) =>
      onProgress?.({ phase: 'decoding', current: n, total: fetched.size })
    )

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

    onProgress?.({ phase: 'painting', current: 0, total: packResult.placements.length })
    const canvas = new OffscreenCanvas(packResult.atlasWidth, packResult.atlasHeight)
    const ctx = canvas.getContext('2d', { alpha: true })!
    this.paintMissingTexture(ctx)

    const registry = new AtlasSpriteRegistry(packResult.atlasWidth, packResult.atlasHeight)
    let painted = 0

    for (const placement of packResult.placements) {
      const bitmap = decoded.get(placement.id)
      if (!bitmap) continue

      ctx.drawImage(bitmap, placement.x, placement.y)

      registry.register({
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
      })

      bitmap.close()
      painted++
      if (painted % 100 === 0) {
        onProgress?.({ phase: 'painting', current: painted, total: packResult.placements.length })
      }
    }

    onProgress?.({ phase: 'uploading', current: 0, total: 1 })
    const imageBitmap = await createImageBitmap(canvas)
    const texture = new THREE.Texture(imageBitmap as unknown as HTMLImageElement)

    texture.magFilter = THREE.NearestFilter
    // Atlas sprites are currently packed edge-to-edge without gutter/extrusion.
    // Mipmaps blend neighboring packed sprites at shallow viewing angles, which
    // creates dark grid-like seams across stone faces. Disable mipmaps until the
    // packer grows padding and extrudes sprite borders into that padding.
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.flipY = false
    texture.needsUpdate = true

    onProgress?.({ phase: 'complete', current: total, total })
    return { texture, sprites: registry }
  }

  private async fetchAllTextures(
    locations: string[],
    onProgress: (n: number) => void
  ): Promise<Map<string, ArrayBuffer>> {
    const result = new Map<string, ArrayBuffer>()
    let fetched = 0
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
            const bitmap = await createImageBitmap(blob, {
              premultiplyAlpha: 'none',
              colorSpaceConversion: 'none',
            })
            result.set(loc, bitmap)
          } catch {
            // Malformed PNG — skip; missing texture will be used.
          }
          decoded++
          if (decoded % 50 === 0) onProgress(decoded)
        })
      )
    }

    return result
  }

  private paintMissingTexture(ctx: OffscreenCanvasRenderingContext2D): void {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 2, 2)
    ctx.fillStyle = '#FF00FF'
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

export const globalAtlasBuilder = new AtlasBuilder()

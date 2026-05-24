/**
 * packages/renderer-core/src/RendererCore.ts
 *
 * Central renderer — owns WebGL2 context, Three.js scene, and RAF loop.
 *
 * Integration points (updated Stage 7+8):
 *  - setBlockMaterial(): replaces placeholder material with block shader
 *  - invalidateAllChunks(): re-queues all sections for remeshing after pipeline
 *  - pipeline: PipelineOrchestrator drives atlas→baker→shader flow
 */

import * as THREE from 'three'
import type { World } from '@mc-planner/world-engine'
import { WorldRenderer } from './WorldRenderer'
import type { BlockShaderUniforms } from './shaders/BlockShader'

export interface RendererOptions {
  antialias?: boolean
  preferWebGL2?: boolean
  maxPixelRatio?: number
}

export class RendererCore {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly chunkGroup: THREE.Group
  private worldRenderer: WorldRenderer | null = null
  private currentWorld: World | null = null
  private blockMaterial: THREE.ShaderMaterial | null = null
  private blockShaderUniforms: BlockShaderUniforms | null = null
  private resizeObserver: ResizeObserver
  private animFrameId: number | null = null
  private lastTime = 0
  private frameCount = 0
  private fpsAccum = 0
  private destroyed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: RendererOptions = {}
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      alpha: false,
    })

    if (!this.renderer.capabilities.isWebGL2) {
      console.warn('[Renderer] WebGL2 not available')
    }

    const dpr = Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2.0)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.logarithmicDepthBuffer = true

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87CEEB)
    this.scene.fog = new THREE.Fog(0x87CEEB, 128, 512)

    this.camera = new THREE.PerspectiveCamera(70, canvas.clientWidth / canvas.clientHeight, 0.1, 2048)
    this.camera.position.set(8, 80, 8)
    this.camera.lookAt(0, 64, 0)

    this.chunkGroup = new THREE.Group()
    this.chunkGroup.name = 'chunks'
    this.scene.add(this.chunkGroup)

    const grid = new THREE.GridHelper(512, 32, 0x444444, 0x333333)
    grid.position.y = 63.5
    this.scene.add(grid)

    const ambient = new THREE.AmbientLight(0xffffff, 0.4)
    const sun = new THREE.DirectionalLight(0xffffff, 0.8)
    sun.position.set(100, 200, 50)
    this.scene.add(ambient, sun)

    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(canvas)
    this.startLoop()

    console.log('[RendererCore] Initialized — WebGL2:', this.renderer.capabilities.isWebGL2)
  }

  // ── Pipeline integration ─────────────────────────────────────────────────

  /**
   * Called by PipelineOrchestrator after atlas and shader are ready.
   * Replaces the placeholder MeshStandardMaterial with the block shader.
   */
  setBlockMaterial(material: THREE.ShaderMaterial, uniforms: BlockShaderUniforms): void {
    this.blockMaterial = material
    this.blockShaderUniforms = uniforms

    // Propagate to WorldRenderer so new section meshes use the block shader
    if (this.worldRenderer) {
      this.worldRenderer.setBlockMaterial(material)
    }

    // Keep fog uniforms in sync with scene fog
    if (this.scene.fog instanceof THREE.Fog) {
      uniforms.uFogColor.value.set(this.scene.fog.color)
      uniforms.uFogNear.value = this.scene.fog.near
      uniforms.uFogFar.value = this.scene.fog.far
    }

    console.log('[RendererCore] Block shader material installed')
  }

  /** Force all loaded chunks to re-mesh with the new pipeline data */
  invalidateAllChunks(): void {
    this.currentWorld?.chunks.markAllDirty()
    console.log('[RendererCore] All chunks invalidated for remesh')
  }

  // ── World integration ────────────────────────────────────────────────────

  attachWorld(world: World): void {
    this.worldRenderer?.dispose()
    this.currentWorld = world
    this.worldRenderer = new WorldRenderer(world, this)
    if (this.blockMaterial) {
      this.worldRenderer.setBlockMaterial(this.blockMaterial)
    }
    console.log('[RendererCore] World attached')
  }

  detachWorld(): void {
    this.worldRenderer?.dispose()
    this.worldRenderer = null
    this.currentWorld = null
  }

  // ── Render loop ──────────────────────────────────────────────────────────

  private startLoop(): void {
    const loop = (time: number) => {
      if (this.destroyed) return
      this.animFrameId = requestAnimationFrame(loop)
      const dt = Math.min((time - this.lastTime) / 1000, 0.1)
      this.lastTime = time
      this.update(dt)
      this.render()
      this.trackFps(dt)
    }
    this.animFrameId = requestAnimationFrame(loop)
  }

  private update(_dt: number): void {
    if (this.worldRenderer) {
      const cam = this.camera.position
      this.worldRenderer.update(cam.x, cam.z)
    }
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  private trackFps(dt: number): void {
    this.frameCount++
    this.fpsAccum += dt
    if (this.fpsAccum >= 1.0) {
      const fps = Math.round(this.frameCount / this.fpsAccum)
      window.dispatchEvent(new CustomEvent('renderer:fps', { detail: { fps } }))
      this.frameCount = 0
      this.fpsAccum = 0
    }
  }

  private onResize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  destroy(): void {
    this.destroyed = true
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId)
    this.resizeObserver.disconnect()
    this.worldRenderer?.dispose()
    this.blockMaterial?.dispose()
    this.renderer.dispose()
    console.log('[RendererCore] Destroyed')
  }

  get webGLRenderer(): THREE.WebGLRenderer { return this.renderer }
  get threeScene(): THREE.Scene { return this.scene }
  get threeCamera(): THREE.PerspectiveCamera { return this.camera }
  get worldChunkGroup(): THREE.Group { return this.chunkGroup }
}

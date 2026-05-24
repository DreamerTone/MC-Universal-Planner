/**
 * packages/renderer-core/src/WorldRenderer.ts
 *
 * Bridges the world engine (block data) with the renderer (Three.js scene).
 * Stage 7+8 update: supports block shader material hot-swap.
 */

import * as THREE from 'three'
import type { World, MeshJob } from '@mc-planner/world-engine'
import { MeshDirtyQueue } from '@mc-planner/world-engine'
import type { RendererCore } from './RendererCore'

export interface ChunkMeshData {
  cx: number; cz: number; sectionY: number
  positions: Float32Array; normals: Float32Array
  uvs: Float32Array; aos: Float32Array
  tints: Float32Array   // 3 floats per vertex (rgb tint, default 1,1,1)
  indices: Uint32Array
  vertexCount: number; indexCount: number
}

function sectionKey(cx: number, cz: number, sectionY: number): string {
  return `${cx},${cz},${sectionY}`
}

export class WorldRenderer {
  private readonly dirtyQueue: MeshDirtyQueue
  private readonly sectionMeshes = new Map<string, THREE.Mesh>()
  private readonly chunkGroup: THREE.Group
  private worker: Worker | null = null
  private activeMaterial: THREE.Material

  private readonly placeholderMaterial = new THREE.MeshStandardMaterial({
    vertexColors: false,
    color: 0x888888,
    roughness: 1.0,
    metalness: 0.0,
  })

  constructor(
    private readonly world: World,
    private readonly renderer: RendererCore
  ) {
    this.dirtyQueue = new MeshDirtyQueue()
    this.chunkGroup = renderer.worldChunkGroup
    this.activeMaterial = this.placeholderMaterial
    this.initMeshWorker()
  }

  /** Called by PipelineOrchestrator after block shader is ready */
  setBlockMaterial(material: THREE.ShaderMaterial): void {
    this.activeMaterial = material
    // Update all existing section meshes to use the new material
    for (const mesh of this.sectionMeshes.values()) {
      mesh.material = material
    }
    console.log(`[WorldRenderer] Block shader applied to ${this.sectionMeshes.size} existing meshes`)
  }

  update(cameraX: number, cameraZ: number): void {
    const dirtyEntries = this.world.chunks.drainDirtyQueue()
    if (dirtyEntries.length > 0) {
      this.dirtyQueue.enqueue(dirtyEntries, cameraX, cameraZ)
    }
    const jobs = this.dirtyQueue.dequeue()
    for (const job of jobs) this.dispatchMeshJob(job)
  }

  private initMeshWorker(): void {
    // Placeholder inline worker — replaced by real greedy mesher in Stage 9
    const src = `
      self.onmessage = function(e) {
        const { cx, cz, sectionY } = e.data;
        // Placeholder: generate a tiny test quad at section origin
        const positions = new Float32Array(0);
        const normals   = new Float32Array(0);
        const uvs       = new Float32Array(0);
        const aos       = new Float32Array(0);
        const tints     = new Float32Array(0);
        const indices   = new Uint32Array(0);
        self.postMessage({ cx, cz, sectionY, positions, normals, uvs, aos, tints, indices, vertexCount: 0, indexCount: 0 },
          [positions.buffer, normals.buffer, uvs.buffer, aos.buffer, tints.buffer, indices.buffer]);
      };
    `
    const blob = new Blob([src], { type: 'application/javascript' })
    this.worker = new Worker(URL.createObjectURL(blob))
    this.worker.onmessage = (e: MessageEvent<ChunkMeshData>) => this.onMeshComplete(e.data)
  }

  private dispatchMeshJob(job: MeshJob): void {
    this.worker?.postMessage({ cx: job.chunkPos.cx, cz: job.chunkPos.cz, sectionY: job.sectionY })
  }

  private onMeshComplete(data: ChunkMeshData): void {
    this.dirtyQueue.markComplete({ cx: data.cx, cz: data.cz }, data.sectionY as any)
    const key = sectionKey(data.cx, data.cz, data.sectionY)
    if (data.vertexCount === 0) { this.removeSectionMesh(key); return }
    this.uploadSectionMesh(key, data)
  }

  private uploadSectionMesh(key: string, data: ChunkMeshData): void {
    let mesh = this.sectionMeshes.get(key)

    if (!mesh) {
      const geometry = new THREE.BufferGeometry()
      mesh = new THREE.Mesh(geometry, this.activeMaterial)
      mesh.name = `section_${key}`
      mesh.frustumCulled = true
      this.chunkGroup.add(mesh)
      this.sectionMeshes.set(key, mesh)
    }

    const geo = mesh.geometry as THREE.BufferGeometry
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geo.setAttribute('normal',   new THREE.BufferAttribute(data.normals, 3))
    geo.setAttribute('uv',       new THREE.BufferAttribute(data.uvs, 2))
    geo.setAttribute('ao',       new THREE.BufferAttribute(data.aos, 1))
    geo.setAttribute('tintColor',new THREE.BufferAttribute(data.tints, 3))
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1))
    geo.computeBoundingBox()
    geo.computeBoundingSphere()

    mesh.position.set(data.cx * 16, -64 + data.sectionY * 16, data.cz * 16)
  }

  private removeSectionMesh(key: string): void {
    const mesh = this.sectionMeshes.get(key)
    if (!mesh) return
    mesh.geometry.dispose()
    this.chunkGroup.remove(mesh)
    this.sectionMeshes.delete(key)
  }

  dispose(): void {
    this.worker?.terminate()
    for (const key of [...this.sectionMeshes.keys()]) this.removeSectionMesh(key)
    this.placeholderMaterial.dispose()
  }

  get sectionMeshCount(): number { return this.sectionMeshes.size }
}

/**
 * packages/renderer-core/src/WorldRenderer.ts
 *
 * Bridges the world engine (block data) with the Three.js scene.
 */

import * as THREE from 'three';
import type { World, MeshJob, ChunkSection } from '@mc-planner/world-engine';
import { MeshDirtyQueue, SECTION_VOLUME } from '@mc-planner/world-engine';
import type { RendererCore } from './RendererCore';
import type { BakedModelRegistry } from './baking/BakedModelRegistry';
import type { BakedModel } from './baking/ModelBaker';
import type { BakedQuad, FaceDir } from './baking/BakedQuad';
import type { MeshingRequest, MeshingResult, MeshSampleQuad, RenderBuffers } from './types/meshing';
import type { RenderProfile, SimpleCubeProfile } from './classification/RenderProfile';

export interface ChunkMeshData {
    cx: number; cz: number; sectionY: number;
    positions: Float32Array; normals: Float32Array;
    uvs: Float32Array; aos: Float32Array;
    tints: Float32Array;
    indices: Uint32Array;
    vertexCount: number; indexCount: number;
}

function sectionKey(cx: number, cz: number, sectionY: number): string {
    return `${cx},${cz},${sectionY}`;
}

function bakedFaceToMesherFace(face: FaceDir): number {
    switch (face) {
        case 0: return 2;
        case 1: return 3;
        case 2: return 5;
        case 3: return 4;
        case 4: return 1;
        case 5: return 0;
        default: return 1;
    }
}

function profileFaceToMesherFace(face: FaceDir): number {
    return bakedFaceToMesherFace(face);
}

export class WorldRenderer {
    private readonly dirtyQueue: MeshDirtyQueue;
    private readonly chunkGroup: THREE.Group;
    private readonly opaqueMeshes = new Map<string, THREE.Mesh>();
    private readonly translucentMeshes = new Map<string, THREE.Mesh>();
    private worker: Worker | null = null;
    private nextJobId = 1;

    private opaqueMaterial: THREE.Material;
    private translucentMaterial: THREE.Material;

    private readonly placeholderOpaque = new THREE.MeshStandardMaterial({
        vertexColors: false,
        color: 0x888888,
        roughness: 1.0,
        metalness: 0.0,
    });
    private readonly placeholderTranslucent = new THREE.MeshStandardMaterial({
        vertexColors: false,
        color: 0x88AAFF,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
    });

    private opaqueIdSet = new Set<number>();

    constructor(
        private readonly world: World,
        private readonly renderer: RendererCore,
    ) {
        this.dirtyQueue = new MeshDirtyQueue();
        this.chunkGroup = renderer.worldChunkGroup;
        this.opaqueMaterial = this.placeholderOpaque;
        this.translucentMaterial = this.placeholderTranslucent;
        this.initMeshWorker();
    }

    setBlockMaterial(material: THREE.Material): void {
        this.opaqueMaterial = material;
        for (const mesh of this.opaqueMeshes.values()) {
            mesh.material = material;
        }
        console.log(`[WorldRenderer] Block shader applied to ${this.opaqueMeshes.size} opaque meshes`);
    }

    setBakedModelRegistry(registry: BakedModelRegistry): void {
        if (!this.worker) return;

        const cacheEntries: [number, MeshSampleQuad[]][] = [];
        const opaqueIds: number[] = [];
        let simpleCubeCount = 0;
        let fallbackCount = 0;

        for (const [stateId, entry] of registry.stateEntries()) {
            const sampleQuads = this.profileToSampleQuads(entry.profile);
            if (sampleQuads.length > 0) {
                cacheEntries.push([stateId as number, sampleQuads]);
                simpleCubeCount++;
            } else {
                const fallbackQuads = this.modelsToSampleQuads(entry.models);
                if (fallbackQuads.length > 0) {
                    cacheEntries.push([stateId as number, fallbackQuads]);
                    fallbackCount++;
                }
            }

            if (this.profileIsOpaque(entry.profile) || this.isFullCubeOpaque(entry.models)) {
                opaqueIds.push(stateId as number);
            }
        }

        this.opaqueIdSet = new Set(opaqueIds);

        this.worker.postMessage({ type: 'INIT_REGISTRIES', opaqueIds });
        if (cacheEntries.length > 0) {
            this.worker.postMessage({ type: 'UPDATE_BAKED_CACHE', cacheEntries });
        }

        console.log(
            `[WorldRenderer] Worker synced — ${cacheEntries.length} mesh entries ` +
            `(${simpleCubeCount} simple cubes, ${fallbackCount} baked fallbacks), ` +
            `${opaqueIds.length} opaque states`,
        );
    }

    update(cameraX: number, cameraZ: number): void {
        const dirtyEntries = this.world.chunks.drainDirtyQueue();
        if (dirtyEntries.length > 0) {
            this.dirtyQueue.enqueue(dirtyEntries, cameraX, cameraZ);
        }
        const jobs = this.dirtyQueue.dequeue();
        for (const job of jobs) this.dispatchMeshJob(job);
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        for (const key of [...this.opaqueMeshes.keys()]) this.removeMesh(this.opaqueMeshes, key);
        for (const key of [...this.translucentMeshes.keys()]) this.removeMesh(this.translucentMeshes, key);
        this.placeholderOpaque.dispose();
        this.placeholderTranslucent.dispose();
    }

    get sectionMeshCount(): number {
        return this.opaqueMeshes.size + this.translucentMeshes.size;
    }

    private initMeshWorker(): void {
        try {
            this.worker = new Worker(
                new URL('./meshing/MeshWorker.ts', import.meta.url),
                { type: 'module' },
            );
            this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e.data);
            this.worker.onerror = (e: ErrorEvent) => {
                console.error('[WorldRenderer] MeshWorker error:', e.message);
            };
        } catch (err) {
            console.error('[WorldRenderer] Failed to spawn MeshWorker:', err);
            this.worker = null;
        }
    }

    private onWorkerMessage(data: any): void {
        if (!data || typeof data.type !== 'string') return;
        if (data.type === 'MESH_RESPONSE') {
            this.onMeshComplete(data.result as MeshingResult);
            return;
        }
        if (data.type === 'MESH_ERROR') {
            console.warn(`[WorldRenderer] Mesh job ${data.jobId} failed: ${data.error}`);
        }
    }

    private dispatchMeshJob(job: MeshJob): void {
        if (!this.worker) return;

        const { cx, cz } = job.chunkPos;
        const sy = job.sectionY;
        const centreChunk = this.world.chunks.getChunk(cx, cz);
        if (!centreChunk) return;

        const centreSection = centreChunk.getSection(sy);
        const mainSection = this.sectionToFlatArray(centreSection);

        const neighbors: { [key: string]: Uint32Array } = {};
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const ny = sy + dy;
                    if (ny < 0 || ny > 23) continue;

                    const neighbourChunk =
                        dx === 0 && dz === 0
                            ? centreChunk
                            : this.world.chunks.getChunk(cx + dx, cz + dz);
                    if (!neighbourChunk) continue;

                    const neighbourSection = neighbourChunk.getSection(ny);
                    if (!neighbourSection || neighbourSection.isEmpty) continue;
                    neighbors[`${dx}|${dy}|${dz}`] = this.sectionToFlatArray(neighbourSection);
                }
            }
        }

        const transferables: ArrayBuffer[] = [mainSection.buffer as ArrayBuffer];
        for (const key of Object.keys(neighbors)) {
            transferables.push(neighbors[key]!.buffer as ArrayBuffer);
        }

        const request: MeshingRequest = {
            jobId: this.nextJobId++,
            sectionX: cx,
            sectionY: sy,
            sectionZ: cz,
            mainSection,
            neighbors,
        };

        this.worker.postMessage({ type: 'MESH_REQUEST', request }, transferables);
    }

    private onMeshComplete(result: MeshingResult): void {
        this.dirtyQueue.markComplete({ cx: result.sectionX, cz: result.sectionZ }, result.sectionY);
        const key = sectionKey(result.sectionX, result.sectionZ, result.sectionY);
        this.uploadOrRemove(this.opaqueMeshes, key, result.buffers.opaque, this.opaqueMaterial,
            result.sectionX, result.sectionY, result.sectionZ);
        this.uploadOrRemove(this.translucentMeshes, key, result.buffers.translucent, this.translucentMaterial,
            result.sectionX, result.sectionY, result.sectionZ);
    }

    private uploadOrRemove(
        store: Map<string, THREE.Mesh>,
        key: string,
        buffers: RenderBuffers | null,
        material: THREE.Material,
        cx: number, sectionY: number, cz: number,
    ): void {
        if (!buffers) {
            this.removeMesh(store, key);
            return;
        }

        let mesh = store.get(key);
        if (!mesh) {
            mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
            mesh.name = `section_${key}_${store === this.translucentMeshes ? 't' : 'o'}`;
            mesh.frustumCulled = true;
            this.chunkGroup.add(mesh);
            store.set(key, mesh);
        } else {
            mesh.material = material;
        }

        const geo = mesh.geometry as THREE.BufferGeometry;
        geo.setAttribute('position',  new THREE.BufferAttribute(buffers.position, 3));
        geo.setAttribute('normal',    new THREE.BufferAttribute(buffers.normal, 3));
        geo.setAttribute('uv',        new THREE.BufferAttribute(buffers.uv, 2));
        geo.setAttribute('ao',        new THREE.BufferAttribute(buffers.ao, 1));
        geo.setAttribute('tintColor', new THREE.BufferAttribute(buffers.tintColor, 3));
        geo.setIndex(new THREE.BufferAttribute(buffers.index, 1));
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        mesh.position.set(cx * 16, -64 + sectionY * 16, cz * 16);
    }

    private removeMesh(store: Map<string, THREE.Mesh>, key: string): void {
        const mesh = store.get(key);
        if (!mesh) return;
        mesh.geometry.dispose();
        this.chunkGroup.remove(mesh);
        store.delete(key);
    }

    private sectionToFlatArray(section: ChunkSection | undefined): Uint32Array {
        const out = new Uint32Array(SECTION_VOLUME);
        if (!section || section.isEmpty) return out;
        for (let i = 0; i < SECTION_VOLUME; i++) {
            out[i] = section.getBlockState(i) as number;
        }
        return out;
    }

    private profileToSampleQuads(profile: RenderProfile): MeshSampleQuad[] {
        if (profile.kind !== 'simple_cube') return [];
        return this.simpleCubeToSampleQuads(profile);
    }

    private simpleCubeToSampleQuads(profile: SimpleCubeProfile): MeshSampleQuad[] {
        const out: MeshSampleQuad[] = [];
        for (const face of Object.values(profile.faces)) {
            out.push({
                faceDir: profileFaceToMesherFace(face.face),
                textureAtlasId: 0,
                u0: face.u0,
                v0: face.v0,
                u1: face.u1,
                v1: face.v1,
                tintIndex: face.tintIndex,
                shade: face.shade,
                isTranslucent: !profile.opaque,
            });
        }
        return out;
    }

    private modelsToSampleQuads(models: BakedModel[]): MeshSampleQuad[] {
        const out: MeshSampleQuad[] = [];
        const cube = models.find(m => m.isFullCube);
        if (!cube) return out;

        const byFace = new Map<number, BakedQuad>();
        for (const q of cube.quads) {
            const mesherFace = bakedFaceToMesherFace(q.face);
            if (!byFace.has(mesherFace)) byFace.set(mesherFace, q);
        }

        for (const [mesherFace, q] of byFace) {
            let u0 = q.uvs[0]!, v0 = q.uvs[1]!;
            let u1 = q.uvs[0]!, v1 = q.uvs[1]!;
            for (let i = 0; i < 4; i++) {
                const u = q.uvs[i * 2]!;
                const v = q.uvs[i * 2 + 1]!;
                if (u < u0) u0 = u;
                if (v < v0) v0 = v;
                if (u > u1) u1 = u;
                if (v > v1) v1 = v;
            }

            out.push({
                faceDir: mesherFace,
                textureAtlasId: 0,
                u0, v0, u1, v1,
                tintIndex: q.tintIndex,
                shade: q.shade,
                isTranslucent: cube.hasTranslucency,
            });
        }

        return out;
    }

    private profileIsOpaque(profile: RenderProfile): boolean {
        return profile.kind === 'simple_cube' && profile.opaque;
    }

    private isFullCubeOpaque(models: BakedModel[]): boolean {
        return models.some(m => m.isFullCube && !m.hasTranslucency);
    }
}

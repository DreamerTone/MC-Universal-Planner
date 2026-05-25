/**
 * packages/renderer-core/src/WorldRenderer.ts
 *
 * Bridges the world engine (block data) with the Three.js scene.
 *
 * Responsibilities:
 *   1. Drain the world's dirty queue each frame and dispatch mesh jobs to
 *      the off-main-thread MeshWorker.
 *   2. For every dispatched job, gather the centre section plus its 26
 *      neighbour sections, decompress each one into a flat Uint32Array,
 *      and TRANSFER the buffers to the worker (zero-copy).
 *   3. Receive completed RenderBuffers from the worker and upload them to
 *      two BufferGeometry objects per section: one for the opaque pass,
 *      one for the translucent pass.
 *   4. Maintain the "is this state opaque?" set and the
 *      "id → MeshSampleQuad[]" cache used by the worker. Both are derived
 *      from the BakedModelRegistry once the asset pipeline completes.
 *
 * Data-driven rule:
 *   No block-specific behaviour lives in this file. Opacity and face
 *   geometry are pulled from BakedModelRegistry → BakedModel; any new
 *   block (vanilla or modded) flows through the same path.
 *
 * Threading:
 *   The worker is a dedicated Web Worker spawned via `new Worker(new URL(...),
 *   { type: 'module' })` — the Vite/Electron-renderer canonical form.
 *   A single worker is used today; the dispatch path is structured so a
 *   pool can replace it without touching the surrounding code.
 *
 * Future:
 *   - Per-block emission path for non-full-cube models (stairs/slabs/fences)
 *     that the greedy mesher cannot merge.
 *   - SharedArrayBuffer for chunk data to skip the decompression copy.
 *   - Translucent back-to-front depth sort per camera frame.
 */

import * as THREE from 'three';
import type { World, MeshJob, ChunkSection } from '@mc-planner/world-engine';
import { MeshDirtyQueue, SECTION_VOLUME } from '@mc-planner/world-engine';
import type { RendererCore } from './RendererCore';
import type { BakedModelRegistry } from './baking/BakedModelRegistry';
import type { BakedModel } from './baking/ModelBaker';
import type { BakedQuad, FaceDir } from './baking/BakedQuad';
import type { MeshingRequest, MeshingResult, MeshSampleQuad, RenderBuffers } from './types/meshing';

/** Public mesh-data shape, kept for downstream tooling. */
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

/** Maps the BakedQuad.face enum (0..5) to the mesher's faceDir convention. */
function bakedFaceToMesherFace(face: FaceDir): number {
    // BakedQuad: 0=N 1=S 2=E 3=W 4=Up 5=Down
    // Mesher:    0=Down 1=Up 2=N 3=S 4=W 5=E
    switch (face) {
        case 0: return 2; // North
        case 1: return 3; // South
        case 2: return 5; // East
        case 3: return 4; // West
        case 4: return 1; // Up
        case 5: return 0; // Down
        default: return 1;
    }
}

export class WorldRenderer {
    private readonly dirtyQueue: MeshDirtyQueue;
    private readonly chunkGroup: THREE.Group;

    // Two meshes per section: opaque and translucent. Lazy-created on first upload.
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

    /** Set of blockstate ids that fully occlude their neighbours' faces. */
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

    // ── Public hooks called by RendererCore / PipelineOrchestrator ───────────

    /** Called when the block shader becomes available (after pipeline run). */
    setBlockMaterial(material: THREE.Material): void {
        this.opaqueMaterial = material;
        for (const mesh of this.opaqueMeshes.values()) {
            mesh.material = material;
        }
        // For now we render translucent geometry with the same shader; a
        // future translucent variant (alpha blending + no depth write) will
        // be slotted in here.
        // eslint-disable-next-line no-console
        console.log(`[WorldRenderer] Block shader applied to ${this.opaqueMeshes.size} opaque meshes`);
    }

    /**
     * Wire the worker's resolver cache to the freshly-built BakedModelRegistry.
     *
     * This is called ONCE per pipeline run. We walk every blockstate id that
     * the registry has cached, convert its BakedModel(s) into the simplified
     * MeshSampleQuad form, and push them to the worker. We also rebuild the
     * "is opaque?" set from the same data so face culling stays consistent.
     *
     * Models that are not full-cube (stairs, fences, etc.) are SKIPPED here:
     * the greedy mesher can only merge full faces. A future per-block
     * emission path will handle them on the main thread side.
     */
    setBakedModelRegistry(registry: BakedModelRegistry): void {
        if (!this.worker) return;

        const cacheEntries: [number, MeshSampleQuad[]][] = [];
        const opaqueIds: number[] = [];

        for (const [stateId, models] of registry.entries()) {
            const sampleQuads = this.modelsToSampleQuads(models);
            if (sampleQuads.length > 0) {
                cacheEntries.push([stateId as number, sampleQuads]);
            }
            if (this.isFullCubeOpaque(models)) {
                opaqueIds.push(stateId as number);
            }
        }

        this.opaqueIdSet = new Set(opaqueIds);

        this.worker.postMessage({ type: 'INIT_REGISTRIES', opaqueIds });
        if (cacheEntries.length > 0) {
            this.worker.postMessage({ type: 'UPDATE_BAKED_CACHE', cacheEntries });
        }

        // eslint-disable-next-line no-console
        console.log(
            `[WorldRenderer] Worker synced — ${cacheEntries.length} mesh entries, ${opaqueIds.length} opaque states`,
        );
    }

    /** Per-frame tick: drain dirty queue and dispatch up to N mesh jobs. */
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

    // ── Worker plumbing ──────────────────────────────────────────────────────

    private initMeshWorker(): void {
        try {
            // Vite + Electron renderer canonical form. The `{ type: 'module' }`
            // option enables ES module imports inside the worker.
            this.worker = new Worker(
                new URL('./meshing/MeshWorker.ts', import.meta.url),
                { type: 'module' },
            );
            this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e.data);
            this.worker.onerror = (e: ErrorEvent) => {
                // eslint-disable-next-line no-console
                console.error('[WorldRenderer] MeshWorker error:', e.message);
            };
        } catch (err) {
            // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
            console.warn(`[WorldRenderer] Mesh job ${data.jobId} failed: ${data.error}`);
            return;
        }
    }

    /**
     * Gather neighbourhood, decompress every section to a flat Uint32Array,
     * and post a MESH_REQUEST to the worker with the underlying ArrayBuffers
     * transferred for zero-copy delivery.
     */
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
                    if (ny < 0 || ny > 23) continue; // outside world Y range

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

        // TS 5.7+ types TypedArray.buffer as ArrayBufferLike; these are all
        // plain ArrayBuffer-backed so the cast is safe.
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
        // Attribute names MUST match the BlockShader vertex declarations.
        geo.setAttribute('position',  new THREE.BufferAttribute(buffers.position, 3));
        geo.setAttribute('normal',    new THREE.BufferAttribute(buffers.normal, 3));
        geo.setAttribute('uv',        new THREE.BufferAttribute(buffers.uv, 2));
        geo.setAttribute('ao',        new THREE.BufferAttribute(buffers.ao, 1));
        geo.setAttribute('tintColor', new THREE.BufferAttribute(buffers.tintColor, 3));
        geo.setIndex(new THREE.BufferAttribute(buffers.index, 1));
        geo.computeBoundingBox();
        geo.computeBoundingSphere();

        // Section world origin: chunk × 16, plus the CHUNK_MIN_Y (=-64) shift.
        mesh.position.set(cx * 16, -64 + sectionY * 16, cz * 16);
    }

    private removeMesh(store: Map<string, THREE.Mesh>, key: string): void {
        const mesh = store.get(key);
        if (!mesh) return;
        mesh.geometry.dispose();
        this.chunkGroup.remove(mesh);
        store.delete(key);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Decompress a ChunkSection (palette-compressed) into a flat Uint32Array
     * indexed by `x | (z << 4) | (y << 8)`.
     *
     * Returns a fresh array each call — the caller TRANSFERS its buffer to
     * the worker, so we cannot reuse one. Allocating SECTION_VOLUME ints
     * (16KB) per dispatch is acceptable; pooling can replace this later.
     *
     * Returns an all-zero array when the section is null/empty.
     */
    private sectionToFlatArray(section: ChunkSection | undefined): Uint32Array {
        const out = new Uint32Array(SECTION_VOLUME);
        if (!section || section.isEmpty) return out;
        for (let i = 0; i < SECTION_VOLUME; i++) {
            out[i] = section.getBlockState(i) as number;
        }
        return out;
    }

    /**
     * Convert one or more BakedModels (a multipart block's full model list)
     * into the worker-side simplified MeshSampleQuad form. Only emits one
     * MeshSampleQuad per face direction; faces from non-full-cube models
     * are skipped (the greedy mesher cannot merge them).
     */
    private modelsToSampleQuads(models: BakedModel[]): MeshSampleQuad[] {
        const out: MeshSampleQuad[] = [];
        // Pick the first FULL CUBE model; non-cube models are skipped here
        // and will be emitted by a future per-block path.
        const cube = models.find(m => m.isFullCube);
        if (!cube) return out;

        // Map by mesher faceDir so duplicates from multipart blocks collapse.
        const byFace = new Map<number, BakedQuad>();
        for (const q of cube.quads) {
            const mesherFace = bakedFaceToMesherFace(q.face);
            if (!byFace.has(mesherFace)) byFace.set(mesherFace, q);
        }

        for (const [mesherFace, q] of byFace) {
            // Atlas-space UV bounding box of the quad. uvs is laid out as
            // [v0u, v0v, v1u, v1v, v2u, v2v, v3u, v3v].
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
                textureAtlasId: 0, // single atlas today
                u0, v0, u1, v1,
                tintIndex: q.tintIndex,
                shade: q.shade,
                isTranslucent: cube.hasTranslucency,
            });
        }

        return out;
    }

    /**
     * A blockstate is treated as opaque (culls neighbours) iff at least one
     * of its baked models is a full cube AND that model has no translucency.
     * This is fully data-driven — no per-block hardcoded list.
     */
    private isFullCubeOpaque(models: BakedModel[]): boolean {
        return models.some(m => m.isFullCube && !m.hasTranslucency);
    }
}

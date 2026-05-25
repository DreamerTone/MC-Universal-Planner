/**
 * packages/renderer-core/src/meshing/MeshWorker.ts
 *
 * Dedicated worker thread for chunk meshing.
 *
 * Lives entirely off the main thread to keep the 60fps render loop and
 * React UI responsive even under heavy world mutation (paste, fill, JAR
 * reload). The worker owns three pieces of long-lived state:
 *
 *   1. `opaqueRegistrySet`  — set of blockstate ids whose faces fully cull
 *                             neighbours. Sent ONCE at startup and refreshed
 *                             only when the BlockStateIdRegistry grows
 *                             (e.g. new mod loaded).
 *
 *   2. `sampleQuadCache`    — Map<stateId, MeshSampleQuad[]>. The simplified
 *                             greedy-friendly face form derived from the
 *                             BakedModelRegistry on the main thread.
 *                             Updated via UPDATE_BAKED_CACHE messages.
 *
 *   3. (transient) per-job  — MeshingRequest payload, only alive during a
 *                             single MESH_REQUEST → MESH_RESPONSE cycle.
 *
 * Message protocol (main → worker):
 *
 *   { type: 'INIT_REGISTRIES',   opaqueIds: number[] }
 *   { type: 'UPDATE_BAKED_CACHE', cacheEntries: [number, MeshSampleQuad[]][] }
 *   { type: 'MESH_REQUEST',       request: MeshingRequest }
 *   { type: 'RESET_CACHE' }       — invalidate everything (JAR reload)
 *
 * Worker → main:
 *
 *   { type: 'MESH_RESPONSE',  result: MeshingResult }
 *   { type: 'MESH_ERROR',     jobId, error }
 *
 * Transferables:
 *   The MESH_REQUEST.mainSection + neighbour Uint32Arrays are TRANSFERRED IN
 *   (main side must not touch them after posting).
 *   The MESH_RESPONSE.buffers.{position,normal,uv,ao,tintColor,index}
 *   ArrayBuffers are TRANSFERRED OUT (worker discards them after posting).
 *
 * Data-driven rule:
 *   This worker MUST NOT contain any block- or mod-specific logic. It
 *   receives all behaviour (opacity, face quads) through the message
 *   channel. Importing a new mod adds new state ids and new sample quads;
 *   the worker code itself is untouched.
 */

import { SectionSampler } from './SectionSampler';
import { GreedyMesher } from './GreedyMesher';
import { MeshBuilder } from './MeshBuilder';
import type { MeshingRequest, MeshingResult, MeshSampleQuad, RenderBuffers } from '../types/meshing';

// Thread-local registries. Initialised via INIT_REGISTRIES; mutated by UPDATE_*.
let opaqueRegistrySet: Set<number> = new Set<number>();
const sampleQuadCache: Map<number, MeshSampleQuad[]> = new Map<number, MeshSampleQuad[]>();

// Worker context is `self` in a dedicated Web Worker.
// `as any` because TS lib.webworker isn't loaded in this package's tsconfig.
const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'INIT_REGISTRIES':
            opaqueRegistrySet = new Set<number>(data.opaqueIds as number[]);
            return;

        case 'UPDATE_BAKED_CACHE': {
            // Patch-in: existing entries with the same id are overwritten,
            // untouched ids retain their previous baked quads.
            const entries = data.cacheEntries as [number, MeshSampleQuad[]][];
            for (const [id, quads] of entries) {
                sampleQuadCache.set(id, quads);
            }
            return;
        }

        case 'RESET_CACHE':
            sampleQuadCache.clear();
            opaqueRegistrySet.clear();
            return;

        case 'MESH_REQUEST':
            handleMeshRequest(data.request as MeshingRequest);
            return;

        default:
            // Unknown message — ignore; future protocol versions may add types.
            return;
    }
};

function handleMeshRequest(request: MeshingRequest): void {
    try {
        const sampler = new SectionSampler(request);
        const mesher = new GreedyMesher(
            sampler,
            (id) => opaqueRegistrySet.has(id),
            // Returns null for unknown ids — the greedy mesher silently
            // skips emission, preserving the data-driven rule. No fallback
            // cube is emitted (would create phantom geometry for placeholder
            // states during async asset loading).
            (id) => sampleQuadCache.get(id) ?? null
        );

        const { opaque, translucent } = mesher.generateMesh();

        const opaqueBuffers = MeshBuilder.buildBuffers(opaque);
        const translucentBuffers = MeshBuilder.buildBuffers(translucent);

        const result: MeshingResult = {
            jobId: request.jobId,
            sectionX: request.sectionX,
            sectionY: request.sectionY,
            sectionZ: request.sectionZ,
            buffers: {
                opaque: opaqueBuffers,
                translucent: translucentBuffers,
            },
        };

        const transferables: ArrayBuffer[] = [];
        collectTransferables(opaqueBuffers, transferables);
        collectTransferables(translucentBuffers, transferables);

        ctx.postMessage({ type: 'MESH_RESPONSE', result }, transferables);
    } catch (err) {
        ctx.postMessage({
            type: 'MESH_ERROR',
            jobId: request.jobId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Append the five typed-array buffers of a RenderBuffers block to the
 * transfer list. Skips nulls (empty mesh side) silently.
 */
function collectTransferables(b: RenderBuffers | null, out: ArrayBuffer[]): void {
    if (!b) return;
    // TS 5.7+ types TypedArray.buffer as ArrayBufferLike (covers SharedArrayBuffer).
    // We only ever construct these with plain ArrayBuffer backing, so the cast is safe.
    out.push(
        b.position.buffer as ArrayBuffer,
        b.normal.buffer as ArrayBuffer,
        b.uv.buffer as ArrayBuffer,
        b.ao.buffer as ArrayBuffer,
        b.tintColor.buffer as ArrayBuffer,
        b.index.buffer as ArrayBuffer,
    );
}

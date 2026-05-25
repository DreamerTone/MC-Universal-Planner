import { SectionSampler } from './SectionSampler';
import { GreedyMesher } from './GreedyMesher';
import { MeshBuilder } from './MeshBuilder';
import type { MeshingRequest, MeshingResult, MeshSampleQuad, RenderBuffers, StaticMeshQuad } from '../types/meshing';

let opaqueRegistrySet: Set<number> = new Set<number>();
const sampleQuadCache: Map<number, MeshSampleQuad[]> = new Map<number, MeshSampleQuad[]>();
const staticModelCache: Map<number, StaticMeshQuad[]> = new Map<number, StaticMeshQuad[]>();

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'INIT_REGISTRIES':
            opaqueRegistrySet = new Set<number>(data.opaqueIds as number[]);
            return;

        case 'UPDATE_BAKED_CACHE': {
            const entries = data.cacheEntries as [number, MeshSampleQuad[]][];
            for (const [id, quads] of entries) sampleQuadCache.set(id, quads);
            return;
        }

        case 'UPDATE_STATIC_MODEL_CACHE': {
            const entries = data.cacheEntries as [number, StaticMeshQuad[]][];
            for (const [id, quads] of entries) staticModelCache.set(id, quads);
            return;
        }

        case 'RESET_CACHE':
            sampleQuadCache.clear();
            staticModelCache.clear();
            opaqueRegistrySet.clear();
            return;

        case 'MESH_REQUEST':
            handleMeshRequest(data.request as MeshingRequest);
            return;
    }
};

function handleMeshRequest(request: MeshingRequest): void {
    try {
        const sampler = new SectionSampler(request);
        const mesher = new GreedyMesher(
            sampler,
            (id) => opaqueRegistrySet.has(id),
            (id) => sampleQuadCache.get(id) ?? null
        );

        const { opaque, translucent } = mesher.generateMesh();
        const staticBuckets = emitStaticModels(sampler);

        const opaqueBuffers = mergeBuffers(
            MeshBuilder.buildBuffers(opaque),
            MeshBuilder.buildStaticBuffers(staticBuckets.opaque)
        );
        const translucentBuffers = mergeBuffers(
            MeshBuilder.buildBuffers(translucent),
            MeshBuilder.buildStaticBuffers(staticBuckets.translucent)
        );

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

function emitStaticModels(sampler: SectionSampler): { opaque: StaticMeshQuad[]; translucent: StaticMeshQuad[] } {
    const opaque: StaticMeshQuad[] = [];
    const translucent: StaticMeshQuad[] = [];

    for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
                const stateId = sampler.getLocalBlockStateId(x, y, z);
                if (stateId === 0) continue;

                const quads = staticModelCache.get(stateId);
                if (!quads || quads.length === 0) continue;

                for (const quad of quads) {
                    if (quad.cullFace !== -1 && isCullFaceHidden(sampler, x, y, z, quad.cullFace)) {
                        continue;
                    }

                    const placed = placeStaticQuad(quad, x, y, z);
                    if (quad.isTranslucent) translucent.push(placed);
                    else opaque.push(placed);
                }
            }
        }
    }

    return { opaque, translucent };
}

function isCullFaceHidden(sampler: SectionSampler, x: number, y: number, z: number, faceDir: number): boolean {
    let nx = x, ny = y, nz = z;
    switch (faceDir) {
        case 0: ny--; break;
        case 1: ny++; break;
        case 2: nz--; break;
        case 3: nz++; break;
        case 4: nx--; break;
        case 5: nx++; break;
        default: return false;
    }
    return sampler.isFaceOpaque(nx, ny, nz, (id) => opaqueRegistrySet.has(id));
}

function placeStaticQuad(quad: StaticMeshQuad, x: number, y: number, z: number): StaticMeshQuad {
    const positions = new Array<number>(12);
    for (let i = 0; i < 4; i++) {
        positions[i * 3] = (quad.positions[i * 3] ?? 0) + x;
        positions[i * 3 + 1] = (quad.positions[i * 3 + 1] ?? 0) + y;
        positions[i * 3 + 2] = (quad.positions[i * 3 + 2] ?? 0) + z;
    }
    return { ...quad, positions };
}

function mergeBuffers(a: RenderBuffers | null, b: RenderBuffers | null): RenderBuffers | null {
    if (!a) return b;
    if (!b) return a;

    const aVertexCount = a.position.length / 3;
    const position = concatFloat32(a.position, b.position);
    const normal = concatFloat32(a.normal, b.normal);
    const uv = concatFloat32(a.uv, b.uv);
    const ao = concatFloat32(a.ao, b.ao);
    const tintColor = concatFloat32(a.tintColor, b.tintColor);

    const index = new Uint32Array(a.index.length + b.index.length);
    index.set(a.index, 0);
    for (let i = 0; i < b.index.length; i++) {
        index[a.index.length + i] = b.index[i]! + aVertexCount;
    }

    return { position, normal, uv, ao, tintColor, index };
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

function collectTransferables(b: RenderBuffers | null, out: ArrayBuffer[]): void {
    if (!b) return;
    out.push(
        b.position.buffer as ArrayBuffer,
        b.normal.buffer as ArrayBuffer,
        b.uv.buffer as ArrayBuffer,
        b.ao.buffer as ArrayBuffer,
        b.tintColor.buffer as ArrayBuffer,
        b.index.buffer as ArrayBuffer,
    );
}

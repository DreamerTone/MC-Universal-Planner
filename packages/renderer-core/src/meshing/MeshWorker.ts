import { MeshingRequest, MeshingResult } from '../types/meshing';
import { SectionSampler } from './SectionSampler';
import { GreedyMesher } from './GreedyMesher';
import { MeshBuilder } from './MeshBuilder';
import { BakedQuad } from '../baking/BakedQuad';

// Thread local mock registries sent during initial setup execution routines
let opaqueRegistrySet = new Set<number>();
// Mock resolver returning standard full size block cubes dynamically derived
let localizedBakeCache = new Map<number, BakedQuad[]>();

self.onmessage = (event: MessageEvent) => {
    const data = event.data;

    // Handle initialization configuration profiles
    if (data.type === 'INIT_REGISTRIES') {
        opaqueRegistrySet = new Set(data.opaqueIds);
        return;
    }

    // Handle localized model update registry updates
    if (data.type === 'UPDATE_BAKED_CACHE') {
        const entries: [number, BakedQuad[]][] = data.cacheEntries;
        for (const [id, quads] of entries) {
            localizedBakeCache.set(id, quads);
        }
        return;
    }

    // Handle explicit chunk meshing computations
    if (data.type === 'MESH_REQUEST') {
        const request = data.request as MeshingRequest;
        
        const sampler = new SectionSampler(request);
        const mesher = new GreedyMesher(
            sampler,
            (id) => opaqueRegistrySet.has(id),
            (id) => localizedBakeCache.get(id) || createDefaultFallbackCube(id)
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
                translucent: translucentBuffers
            }
        };

        // Collect list of internal raw underlying Transferable ArrayBuffers
        const transferables: ArrayBuffer[] = [];
        if (opaqueBuffers) {
            transferables.push(
                opaqueBuffers.position.buffer,
                opaqueBuffers.uv.buffer,
                opaqueBuffers.color.buffer,
                opaqueBuffers.normal.buffer,
                opaqueBuffers.index.buffer
            );
        }
        if (translucentBuffers) {
            transferables.push(
                translucentBuffers.position.buffer,
                translucentBuffers.uv.buffer,
                translucentBuffers.color.buffer,
                translucentBuffers.normal.buffer,
                translucentBuffers.index.buffer
            );
        }

        // Post directly back to main thread orchestration framework
        self.postMessage({ type: 'MESH_RESPONSE', result }, transferables);
    }
};

/**
 * Procedural fallback geometric quad generator to prevent empty invisible nodes
 */
function createDefaultFallbackCube(blockStateId: number): BakedQuad[] {
    const quads: BakedQuad[] = [];
    // Generate standard 6 sided structural frames spanning bounds coordinates 0 -> 16
    for (let face = 0; face < 6; face++) {
        quads.push({
            faceDir: face,
            textureAtlasId: 0, // Points to index fallback error asset space
            u0: 0, v0: 0, u1: 0.0625, v1: 0.0625, // Upper-left 16x16 window bounds mapping
            tintIndex: -1,
            shade: true,
            isTranslucent: false
        });
    }
    return quads;
}
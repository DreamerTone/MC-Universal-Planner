import { BakedQuad } from '../baking/BakedQuad';

export interface ChunkSectionData {
    x: number;
    y: number;
    z: number;
    blockStates: Uint32Array;
}

export interface NeighborChunkData {
    sections: (Uint32Array | null)[];
}

export interface MeshingRequest {
    jobId: number;
    sectionX: number;
    sectionY: number;
    sectionZ: number;
    mainSection: Uint32Array;
    neighbors: { [offsetKey: string]: Uint32Array };
}

export interface MeshingResult {
    jobId: number;
    sectionX: number;
    sectionY: number;
    sectionZ: number;
    buffers: {
        opaque: RenderBuffers | null;
        translucent: RenderBuffers | null;
    };
}

export interface RenderBuffers {
    position: Float32Array;
    normal: Float32Array;
    uv: Float32Array;
    ao: Float32Array;
    tintColor: Float32Array;
    index: Uint32Array;
}

export interface UncompressedQuad {
    x: number; y: number; z: number;
    w: number; h: number;
    faceDir: number;
    textureAtlasId: number;
    u0: number; v0: number; u1: number; v1: number;
    ao: number[];
    tintIndex: number;
    shade: boolean;
}

export interface MeshSampleQuad {
    faceDir: number;
    textureAtlasId: number;
    u0: number; v0: number;
    u1: number; v1: number;
    tintIndex: number;
    shade: boolean;
    isTranslucent: boolean;
}

/**
 * Worker-side arbitrary baked quad for non-cube static models.
 * Positions are block-local [0,1] coordinates. The worker adds the block's
 * section-local integer position before uploading.
 */
export interface StaticMeshQuad {
    positions: number[]; // 12 floats: 4 vertices × xyz
    uvs: number[];       // 8 floats: 4 vertices × uv
    faceDir: number;     // mesher convention: 0=Down 1=Up 2=N 3=S 4=W 5=E
    cullFace: number;    // same convention, or -1 for never cull
    tintIndex: number;
    shade: boolean;
    isTranslucent: boolean;
}

export type { BakedQuad };

import { BakedQuad } from '../baking/BakedQuad';

export interface ChunkSectionData {
    x: number; // Section coords (ChunkX)
    y: number; // Section coords (ChunkY, 0-23 for 384 height)
    z: number; // Section coords (ChunkZ)
    // 16x16x16 block states flattened: index = x | (z << 4) | (y << 8)
    blockStates: Uint32Array; 
}

export interface NeighborChunkData {
    // Array of 27 section datasets (including self at index 13) to allow full 1-block padding reads
    sections: (Uint32Array | null)[];
}

export interface MeshingRequest {
    jobId: number;
    sectionX: number;
    sectionY: number;
    sectionZ: number;
    mainSection: Uint32Array;
    // Neighbors mapped by relative offset: [-1, 0, 1] for X, Y, Z
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
    position: Float32Array;  // 3 floats per vertex
    uv: Float32Array;        // 2 floats per vertex
    color: Float32Array;     // 4 floats per vertex (RGBA: RGB=Tint, A=AO + Shading)
    normal: Float32Array;    // 3 floats per vertex
    index: Uint32Array;      // Triangle indices
}
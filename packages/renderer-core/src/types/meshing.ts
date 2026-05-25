/**
 * packages/renderer-core/src/types/meshing.ts
 *
 * Wire-format types shared between the main thread and the mesh worker.
 *
 * Everything in this file MUST be structured-cloneable (or transferable):
 * no class instances, no functions, no DOM refs. The mesh worker boundary
 * is strict — anything sent across it is either copied (slow) or transferred
 * (fast, zero-copy via ArrayBuffer).
 *
 * Ownership rules:
 *  - Request buffers (Uint32Array section data) are TRANSFERRED to the worker.
 *    After a postMessage, the main thread MUST NOT touch them.
 *  - Response buffers (Float32Array geometry + Uint32Array index) are
 *    TRANSFERRED back to the main thread. The worker discards them after post.
 *
 * Index layout for section voxel data:
 *  Flat index = x | (z << 4) | (y << 8)
 *  Matches Minecraft's section ordering (Y-major, Z-mid, X-inner).
 *  This MUST match ChunkSection.sectionIndex() in @mc-planner/world-engine
 *  so a decompressed section can be sent verbatim.
 */
import { BakedQuad } from '../baking/BakedQuad';

/** A 16³ section's decompressed blockstate IDs. */
export interface ChunkSectionData {
    x: number; // Section coords (ChunkX)
    y: number; // Section coords (ChunkY, 0-23 for 384 height)
    z: number; // Section coords (ChunkZ)
    /** 4096 blockstate IDs flat; index = x | (z << 4) | (y << 8). */
    blockStates: Uint32Array;
}

/**
 * Convenience grouping of the 27 sections surrounding a target (including self).
 * Index 13 is the centre section; the rest are neighbours in [-1..+1]^3.
 * Mostly used by tooling; the worker protocol uses the flat `neighbors` map
 * below because it is sparse-friendly (missing keys = uniform air).
 */
export interface NeighborChunkData {
    sections: (Uint32Array | null)[];
}

/**
 * A meshing job. Sent main → worker.
 *
 * `mainSection` and the values inside `neighbors` are TRANSFERRED — never
 * touch them on the main thread after posting. The main thread should
 * decompress each ChunkSection into a fresh Uint32Array per request.
 */
export interface MeshingRequest {
    jobId: number;
    sectionX: number;
    sectionY: number;
    sectionZ: number;
    mainSection: Uint32Array;
    /**
     * Sparse map of neighbour section blockstate arrays.
     * Key format: `${dx}|${dy}|${dz}` where each axis is -1, 0, or +1.
     * Missing entries (e.g. across the world boundary, or all-air neighbours)
     * are treated as full-air sections by the sampler.
     * The (0,0,0) entry is NOT included here — see `mainSection`.
     */
    neighbors: { [offsetKey: string]: Uint32Array };
}

/** Job result. Sent worker → main, with all typed array buffers transferred. */
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

/**
 * GPU-ready vertex buffers. Attribute names match the BlockShader contract.
 *
 *  position   vec3  — block-local space [0,16]³ for the section
 *  normal     vec3  — face normal (matches FACE_NORMALS for the quad's face)
 *  uv         vec2  — atlas UV [0,1]²
 *  ao         float — ambient-occlusion factor [0.2, 1.0] (per-vertex)
 *  tintColor  vec3  — biome tint multiplier; (1,1,1) when no tint applies
 *  index      uint32 — triangle indices
 *
 * Face shading (the darker-on-side-faces look) is NOT baked here — the
 * shader derives it from the normal so the same buffer is reusable if we
 * ever want HDR / non-Minecraft shading variants.
 */
export interface RenderBuffers {
    position: Float32Array;  // 3 floats per vertex
    normal: Float32Array;    // 3 floats per vertex
    uv: Float32Array;        // 2 floats per vertex
    ao: Float32Array;        // 1 float per vertex
    tintColor: Float32Array; // 3 floats per vertex
    index: Uint32Array;      // triangle indices
}

/**
 * Greedy-meshing intermediate form. One per merged face region.
 *
 * Lives only inside the worker — never crosses the postMessage boundary,
 * but defined here so MeshBuilder and GreedyMesher share a single source
 * of truth (avoids drift between two near-identical definitions).
 *
 *  x,y,z   — origin of the merged rectangle in section-local space (block units)
 *  w,h     — rectangle extents on the two non-axis dimensions
 *  faceDir — 0=Down 1=Up 2=North 3=South 4=West 5=East (matches AOGenerator)
 *  u0..v1  — atlas UV bounds (already tiled if w/h > 1 — see MeshBuilder)
 *  ao      — per-corner AO factor (4 values, vertex-order matched to MeshBuilder)
 *  tintIndex — -1 = no tint; >=0 = biome tint lookup (not applied yet)
 *  shade   — whether face shading + AO apply (false for emissive quads)
 *
 * (Translucent vs. opaque bucketing happens at construction time in the
 * GreedyMesher — the bucket the quad lands in encodes its translucency,
 * so we do not duplicate the flag on the quad itself.)
 */
export interface UncompressedQuad {
    x: number; y: number; z: number;
    w: number; h: number;
    faceDir: number;
    textureAtlasId: number;
    u0: number; v0: number; u1: number; v1: number;
    ao: number[]; // length 4
    tintIndex: number;
    shade: boolean;
}

/**
 * Worker-side simplified baked face.
 *
 * The full BakedQuad type (baking/BakedQuad.ts) carries 12 floats of arbitrary
 * positions — needed for stairs, slabs, fences, etc. The greedy mesher can
 * only merge full-cube faces, so we send a stripped-down form keyed by
 * face direction. Non-full-cube models are NOT registered here; they take
 * a future per-block emission path that bypasses greedy meshing entirely.
 *
 * One MeshSampleQuad per face direction per block state. Models with no
 * quad for a given face (e.g. a model with only an `up` face) simply omit
 * that face direction; the mesher skips it.
 */
export interface MeshSampleQuad {
    faceDir: number;        // 0..5
    textureAtlasId: number; // logical sprite id (currently 0 — single atlas)
    u0: number; v0: number;
    u1: number; v1: number;
    tintIndex: number;
    shade: boolean;
    isTranslucent: boolean;
}

// Re-export BakedQuad so callers that want the full form can grab it through
// the meshing types barrel without reaching into baking/.
export type { BakedQuad };

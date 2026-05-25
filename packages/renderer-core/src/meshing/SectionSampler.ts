/**
 * packages/renderer-core/src/meshing/SectionSampler.ts
 *
 * Read-only "padded view" of a single section plus its 26 neighbours.
 *
 * The greedy mesher and the AO generator both query block states at signed
 * coordinates that can extend ONE block past every face of the section
 * (e.g. AO inspects (-1,-1,-1)..(16,16,16)). Rather than spamming the world
 * for each lookup — which would also defeat the worker isolation — every
 * MeshingRequest carries the centre section AND a sparse map of neighbour
 * sections. SectionSampler hides the routing logic behind a clean API.
 *
 * Coordinate domain accepted by all read methods:
 *   x, y, z ∈ [-16, 31] (one section in any direction)
 * Anything further is clamped to the nearest border neighbour entry, which
 * means "treat as the same neighbour" — acceptable because AO only ever
 * peeks one block out.
 *
 * The neighbour key format mirrors MeshingRequest.neighbors:
 *   `${dx}|${dy}|${dz}` with each in {-1, 0, +1} (dx=dy=dz=0 reads `mainSection`)
 *
 * Missing keys = uniform air (blockstate id 0). This matches the world engine's
 * lazy-allocation model: all-air sections are simply not transmitted.
 *
 * Index layout: `x | (z << 4) | (y << 8)` — MUST match meshing.ts and
 * ChunkSection.sectionIndex() in @mc-planner/world-engine.
 */

import type { MeshingRequest } from '../types/meshing';

/** Air blockstate id (matches AIR_BLOCKSTATE_ID in @mc-planner/world-engine). */
const AIR_ID = 0;

export class SectionSampler {
    private readonly mainSection: Uint32Array;
    private readonly neighbors: { [offsetKey: string]: Uint32Array };

    constructor(request: MeshingRequest) {
        this.mainSection = request.mainSection;
        this.neighbors = request.neighbors;
    }

    /**
     * Resolve which underlying Uint32Array a (signed) coordinate belongs to,
     * and translate the coordinate into that array's [0..15] local frame.
     *
     * Returns null if the coordinate is more than one section away on any axis,
     * which the caller should treat as air. Returning the array + local index
     * keeps this in a single allocation-free call path (hot loop in the mesher).
     */
    private locate(x: number, y: number, z: number): { array: Uint32Array; index: number } | null {
        // Section offset along each axis: -1 below, 0 inside, +1 above.
        // Math.floor handles negative coords (e.g. floor(-1/16) = -1).
        const dx = Math.floor(x / 16);
        const dy = Math.floor(y / 16);
        const dz = Math.floor(z / 16);

        if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || dz < -1 || dz > 1) {
            return null;
        }

        // Local coordinate within the resolved section.
        // ((x % 16) + 16) % 16 keeps negatives in [0..15].
        const lx = ((x % 16) + 16) % 16;
        const ly = ((y % 16) + 16) % 16;
        const lz = ((z % 16) + 16) % 16;

        const array =
            dx === 0 && dy === 0 && dz === 0
                ? this.mainSection
                : this.neighbors[`${dx}|${dy}|${dz}`];

        if (!array) return null;

        // Index = x | (z << 4) | (y << 8) — MUST match world-engine.
        const index = lx | (lz << 4) | (ly << 8);
        return { array, index };
    }

    /**
     * Get the blockstate id at any (signed) coordinate.
     * Returns 0 (air) for unknown / unloaded neighbours.
     */
    public getBlockStateId(x: number, y: number, z: number): number {
        const hit = this.locate(x, y, z);
        if (!hit) return AIR_ID;
        return hit.array[hit.index] ?? AIR_ID;
    }

    /**
     * "Is the block at (x,y,z) opaque enough to cull a neighbour's face?"
     *
     * This is the question both the greedy mesher (face-culling) and the
     * AO generator (corner darkening) ask. We resolve the blockstate id and
     * delegate to the caller-supplied opacity lookup so the data is fully
     * data-driven — no hardcoded opacity per block id here.
     *
     * Air (id 0) is always non-opaque, short-circuited for hot-loop speed.
     */
    public isFaceOpaque(
        x: number, y: number, z: number,
        isOpaqueLookup: (id: number) => boolean
    ): boolean {
        const id = this.getBlockStateId(x, y, z);
        if (id === AIR_ID) return false;
        return isOpaqueLookup(id);
    }

    /**
     * Direct, fast accessor for the centre section.
     * Used by the greedy mesher's mask construction inner loop where we
     * already know we're inside [0..15]³ and want to skip the locate() cost.
     */
    public getLocalBlockStateId(lx: number, ly: number, lz: number): number {
        return this.mainSection[lx | (lz << 4) | (ly << 8)] ?? AIR_ID;
    }
}

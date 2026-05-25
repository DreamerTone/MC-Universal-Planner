/**
 * packages/renderer-core/src/meshing/GreedyMesher.ts
 *
 * 3D face mesher for visible block faces.
 *
 * This class is intentionally still named GreedyMesher because the sweep/mask
 * structure is the same pipeline that will do greedy rectangle merging again.
 * For the current atlas shader, however, visible faces are emitted as 1×1
 * block quads. A merged 16×16 or 32×32 face cannot be textured correctly with
 * only atlas-space UVs: either the sprite is stretched over the whole merge,
 * or UVs walk outside the sprite rect and sample unrelated atlas texels.
 *
 * Future greedy re-enable path:
 *   - keep sprite bounds per quad
 *   - also pass local/tile UVs to the shader
 *   - shader computes spriteMin + fract(tileUv) * spriteSize
 *
 * Inputs:
 *   - SectionSampler: padded read access to the centre section + 26 neighbours
 *   - isOpaqueLookup(stateId): "does this block fully occlude its neighbour?"
 *     Data-driven — supplied by the main thread via INIT_REGISTRIES.
 *   - quadResolver(stateId): returns the MeshSampleQuad[] for a block state
 *     (one entry per face direction). Returns null for blocks that have no
 *     greedy-friendly representation (stairs, fences, etc.) — those are
 *     skipped here and emitted via a future per-block-model pass.
 */

import { SectionSampler } from './SectionSampler';
import { AOGenerator } from '../ao/AOGenerator';
import type { MeshSampleQuad, UncompressedQuad } from '../types/meshing';

export class GreedyMesher {
    private sampler: SectionSampler;
    private isOpaqueLookup: (id: number) => boolean;
    private quadResolver: (blockStateId: number) => MeshSampleQuad[] | null;

    constructor(
        sampler: SectionSampler,
        isOpaqueLookup: (id: number) => boolean,
        quadResolver: (blockStateId: number) => MeshSampleQuad[] | null
    ) {
        this.sampler = sampler;
        this.isOpaqueLookup = isOpaqueLookup;
        this.quadResolver = quadResolver;
    }

    /**
     * Run all six face-direction sweeps and bucket the results into
     * opaque vs. translucent emission lists.
     */
    public generateMesh(): { opaque: UncompressedQuad[]; translucent: UncompressedQuad[] } {
        const opaqueQuads: UncompressedQuad[] = [];
        const translucentQuads: UncompressedQuad[] = [];

        for (let face = 0; face < 6; face++) {
            this.meshFaceDirection(face, opaqueQuads, translucentQuads);
        }

        return { opaque: opaqueQuads, translucent: translucentQuads };
    }

    /**
     * Sweep one face direction across all 16 perpendicular slices of the
     * section and emit one textured quad per visible block face.
     *
     * Face direction encoding (matches AOGenerator + MeshBuilder):
     *   0=Down 1=Up 2=North 3=South 4=West 5=East
     */
    private meshFaceDirection(
        face: number,
        opaqueList: UncompressedQuad[],
        translucentList: UncompressedQuad[]
    ): void {
        // Pick the sweep axis based on face. mainAxis is the slice direction;
        // d1/d2 are the in-plane axes scanned to build the 16x16 mask.
        let mainAxis = 0, d1Axis = 1, d2Axis = 2;
        if (face === 0 || face === 1) { mainAxis = 1; d1Axis = 0; d2Axis = 2; } // Y sweep
        if (face === 4 || face === 5) { mainAxis = 0; d1Axis = 2; d2Axis = 1; } // X sweep
        if (face === 2 || face === 3) { mainAxis = 2; d1Axis = 0; d2Axis = 1; } // Z sweep

        const normalOffset = (face % 2 === 0) ? -1 : 1;

        for (let mainVal = 0; mainVal < 16; mainVal++) {
            for (let d2 = 0; d2 < 16; d2++) {
                for (let d1 = 0; d1 < 16; d1++) {
                    const coords = [0, 0, 0];
                    coords[mainAxis] = mainVal;
                    coords[d1Axis] = d1;
                    coords[d2Axis] = d2;

                    const cx = coords[0]!, cy = coords[1]!, cz = coords[2]!;
                    const blockId = this.sampler.getLocalBlockStateId(cx, cy, cz);
                    if (blockId === 0) continue;

                    // Face is hidden iff the neighbour in the face-normal direction
                    // is opaque. Uses the padded sampler so cross-section faces
                    // consult neighbour sections correctly.
                    const nx = cx + (mainAxis === 0 ? normalOffset : 0);
                    const ny = cy + (mainAxis === 1 ? normalOffset : 0);
                    const nz = cz + (mainAxis === 2 ? normalOffset : 0);
                    if (this.sampler.isFaceOpaque(nx, ny, nz, this.isOpaqueLookup)) continue;

                    // Resolve face geometry for this blockstate. Returns null
                    // for non-greedy-friendly models — skip emission silently.
                    const sampleQuads = this.quadResolver(blockId);
                    if (!sampleQuads) continue;

                    const faceQuad = sampleQuads.find(q => q.faceDir === face);
                    if (!faceQuad) continue;

                    // Per-block emission: 1×1 quads keep atlas UVs inside the
                    // sprite rect and make cube textures tile correctly.
                    const width = 1;
                    const height = 1;

                    const aoPoints = [1, 1, 1, 1];
                    for (let v = 0; v < 4; v++) {
                        const cornerCoords = [0, 0, 0];
                        cornerCoords[mainAxis] = mainVal;
                        cornerCoords[d1Axis] = d1 + ((v === 1 || v === 2) ? width : 0);
                        cornerCoords[d2Axis] = d2 + ((v === 2 || v === 3) ? height : 0);

                        aoPoints[v] = AOGenerator.computeVertexAO(
                            this.sampler,
                            cornerCoords[0]!, cornerCoords[1]!, cornerCoords[2]!,
                            face, v, this.isOpaqueLookup
                        );
                    }

                    const constructedQuad: UncompressedQuad = {
                        x: d1, y: mainVal, z: d2,
                        w: width, h: height,
                        faceDir: face,
                        textureAtlasId: faceQuad.textureAtlasId,
                        u0: faceQuad.u0, v0: faceQuad.v0,
                        u1: faceQuad.u1, v1: faceQuad.v1,
                        ao: aoPoints,
                        tintIndex: faceQuad.tintIndex,
                        shade: faceQuad.shade,
                    };

                    const remapped = this.remapForBuilder(
                        constructedQuad, mainAxis, mainVal, d1, d2, width, height
                    );

                    if (faceQuad.isTranslucent) {
                        translucentList.push(remapped);
                    } else {
                        opaqueList.push(remapped);
                    }
                }
            }
        }
    }

    /**
     * Map sweep coordinates into the (x, y, z, w, h) frame MeshBuilder expects.
     *
     * MeshBuilder treats:
     *   - faceDir 0/1 (Down/Up):     (x,z) plane, y constant
     *   - faceDir 2/3 (North/South): (x,y) plane, z constant
     *   - faceDir 4/5 (West/East):   (z,y) plane, x constant
     */
    private remapForBuilder(
        q: UncompressedQuad,
        mainAxis: number,
        mainVal: number, d1: number, d2: number,
        width: number, height: number
    ): UncompressedQuad {
        const out: UncompressedQuad = { ...q };
        if (mainAxis === 1) {
            // Y sweep — d1=X, d2=Z, main=Y
            out.x = d1; out.y = mainVal; out.z = d2;
            out.w = width; out.h = height;
        } else if (mainAxis === 2) {
            // Z sweep — d1=X, d2=Y, main=Z
            out.x = d1; out.y = d2; out.z = mainVal;
            out.w = width; out.h = height;
        } else {
            // X sweep — d1=Z, d2=Y, main=X
            out.x = mainVal; out.y = d2; out.z = d1;
            out.w = width; out.h = height;
        }
        return out;
    }
}

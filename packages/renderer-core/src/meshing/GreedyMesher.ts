/**
 * packages/renderer-core/src/meshing/GreedyMesher.ts
 *
 * 3D greedy mesher: merges adjacent identical faces across each of the six
 * face directions into the largest axis-aligned rectangles possible.
 *
 * Inputs:
 *   - SectionSampler: padded read access to the centre section + 26 neighbours
 *   - isOpaqueLookup(stateId): "does this block fully occlude its neighbour?"
 *     Data-driven — supplied by the main thread via INIT_REGISTRIES.
 *   - quadResolver(stateId): returns the MeshSampleQuad[] for a block state
 *     (one entry per face direction). Returns null for blocks that have no
 *     greedy-friendly representation (stairs, fences, etc.) — those are
 *     skipped here and emitted via a future per-block-model pass.
 *
 * The mesher does NOT know about specific blocks, models, or textures.
 * It only knows "this stateId says here is its face quad". This is what
 * keeps the engine data-driven: importing a new mod adds new ids and new
 * baked face data; the mesher needs no changes.
 *
 * AO:
 *  For every merged rectangle we sample 4 corner AO values via AOGenerator.
 *  Two adjacent faces only merge into one rectangle if their AO patterns
 *  match (handled implicitly by the mask: we currently merge purely by
 *  stateId — a future tightening would key the mask by stateId+ao-bits to
 *  prevent visible AO discontinuities across merge seams).
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
     * section, merging adjacent identical-stateId faces into rectangles.
     *
     * Face direction encoding (matches AOGenerator + MeshBuilder):
     *   0=Down 1=Up 2=North 3=South 4=West 5=East
     * Even faces look towards -axis (cull check at -1), odd faces towards +axis.
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
        // face 2/3 keep mainAxis=0... that's wrong for Z. Fix: Z sweep uses mainAxis=2.
        if (face === 2 || face === 3) { mainAxis = 2; d1Axis = 0; d2Axis = 1; } // Z sweep

        const mask = new Uint32Array(16 * 16);
        const normalOffset = (face % 2 === 0) ? -1 : 1;

        for (let mainVal = 0; mainVal < 16; mainVal++) {
            // Step 1: Build the 16x16 visibility mask for this slice.
            // Each cell stores the stateId of a visible face, or 0 (no face).
            let maskIdx = 0;
            for (let d2 = 0; d2 < 16; d2++) {
                for (let d1 = 0; d1 < 16; d1++) {
                    const coords = [0, 0, 0];
                    coords[mainAxis] = mainVal;
                    coords[d1Axis] = d1;
                    coords[d2Axis] = d2;

                    const cx = coords[0]!, cy = coords[1]!, cz = coords[2]!;
                    const currentBlock = this.sampler.getLocalBlockStateId(cx, cy, cz);

                    if (currentBlock === 0) {
                        mask[maskIdx++] = 0;
                        continue;
                    }

                    // Face is hidden iff the neighbour in the face-normal direction
                    // is opaque. Uses the padded sampler so cross-section faces
                    // (e.g. mainVal=15 with face=Up) consult the +Y neighbour section.
                    const nx = cx + (mainAxis === 0 ? normalOffset : 0);
                    const ny = cy + (mainAxis === 1 ? normalOffset : 0);
                    const nz = cz + (mainAxis === 2 ? normalOffset : 0);

                    const isCulled = this.sampler.isFaceOpaque(nx, ny, nz, this.isOpaqueLookup);

                    // Store stateId in the mask — same id => mergeable, different id => seam.
                    mask[maskIdx++] = isCulled ? 0 : currentBlock;
                }
            }

            // Step 2: Walk the mask and extract maximal rectangles.
            maskIdx = 0;
            for (let d2 = 0; d2 < 16; d2++) {
                for (let d1 = 0; d1 < 16; d1++, maskIdx++) {
                    const blockId = mask[maskIdx];
                    if (blockId === 0) continue;

                    // Find max width: contiguous run along d1 with matching id.
                    let width = 1;
                    while (d1 + width < 16 && mask[maskIdx + width] === blockId) {
                        width++;
                    }

                    // Find max height: extend along d2 while EVERY cell in the
                    // row matches blockId across the full width.
                    let height = 1;
                    let canExtend = true;
                    while (d2 + height < 16 && canExtend) {
                        for (let w = 0; w < width; w++) {
                            if (mask[maskIdx + w + (height * 16)] !== blockId) {
                                canExtend = false;
                                break;
                            }
                        }
                        if (canExtend) height++;
                    }

                    // Resolve face geometry for this blockstate. Returns null
                    // for non-greedy-friendly models — skip emission silently.
                    const sampleQuads = this.quadResolver(blockId);
                    if (sampleQuads) {
                        const faceQuad = sampleQuads.find(q => q.faceDir === face);
                        if (faceQuad) {
                            // Per-corner AO. AOGenerator reads through the sampler
                            // so it correctly inspects cross-section neighbours.
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
                                x: d1, y: mainVal, z: d2, // local relative coords; MeshBuilder remaps via faceDir
                                w: width, h: height,
                                faceDir: face,
                                textureAtlasId: faceQuad.textureAtlasId,
                                u0: faceQuad.u0, v0: faceQuad.v0,
                                u1: faceQuad.u1, v1: faceQuad.v1,
                                ao: aoPoints,
                                tintIndex: faceQuad.tintIndex,
                                shade: faceQuad.shade,
                            };

                            // Note: MeshBuilder's getQuadVertices treats (x,y,z) as
                            // section-local block coords with the appropriate axis
                            // pinned by faceDir. We pass d1/mainVal/d2 in their
                            // greedy-sweep order; this maps correctly for the
                            // Y-sweep (mainAxis=1) cases. For X and Z sweeps the
                            // mapping is permuted — see remapForBuilder below.
                            const remapped = this.remapForBuilder(
                                constructedQuad, mainAxis, d1Axis, d2Axis, mainVal, d1, d2, width, height
                            );

                            if (faceQuad.isTranslucent) {
                                translucentList.push(remapped);
                            } else {
                                opaqueList.push(remapped);
                            }
                        }
                    }

                    // Clear the consumed region so we don't re-emit it.
                    for (let h = 0; h < height; h++) {
                        for (let w = 0; w < width; w++) {
                            mask[maskIdx + w + (h * 16)] = 0;
                        }
                    }
                }
            }
        }
    }

    /**
     * Map greedy-sweep coordinates (mainAxis, d1Axis, d2Axis) into the
     * (x, y, z, w, h) frame MeshBuilder expects for the given faceDir.
     *
     * MeshBuilder always treats:
     *   - faceDir 0/1 (Down/Up):    (x,z) is the plane, y is constant; w=du, h=dv on Z
     *   - faceDir 2/3 (North/South):(x,y) is the plane, z is constant; w=du on X, h=dv on Y
     *   - faceDir 4/5 (West/East):  (z,y) is the plane, x is constant; w=du on Z, h=dv on Y
     */
    private remapForBuilder(
        q: UncompressedQuad,
        mainAxis: number, _d1Axis: number, _d2Axis: number,
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

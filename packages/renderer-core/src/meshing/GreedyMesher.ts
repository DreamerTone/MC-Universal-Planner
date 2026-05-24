import { SectionSampler } from './SectionSampler';
import { BakedQuad } from '../baking/BakedQuad';
import { AOGenerator } from '../ao/AOGenerator';

export interface UncompressedQuad {
    x: number; y: number; z: number;
    w: number; h: number;
    faceDir: number;
    textureAtlasId: number;
    u0: number; v0: number; u1: number; v1: number;
    ao: number[]; // 4 floats
    tintIndex: number;
    shade: boolean;
}

export class GreedyMesher {
    private sampler: SectionSampler;
    private isOpaqueLookup: (id: number) => boolean;
    private quadResolver: (blockStateId: number) => BakedQuad[] | null;

    constructor(
        sampler: SectionSampler,
        isOpaqueLookup: (id: number) => boolean,
        quadResolver: (blockStateId: number) => BakedQuad[] | null
    ) {
        this.sampler = sampler;
        this.isOpaqueLookup = isOpaqueLookup;
        this.quadResolver = quadResolver;
    }

    /**
     * Executes a 3D greedy meshing sweep over the chunk section.
     */
    public generateMesh(): { opaque: UncompressedQuad[]; translucent: UncompressedQuad[] } {
        const opaqueQuads: UncompressedQuad[] = [];
        const translucentQuads: UncompressedQuad[] = [];

        // Sweep over all 6 face directions
        for (let face = 0; face < 6; face++) {
            this.meshFaceDirection(face, opaqueQuads, translucentQuads);
        }

        return { opaque: opaqueQuads, translucent: translucentQuads };
    }

    private meshFaceDirection(
        face: number,
        opaqueList: UncompressedQuad[],
        translucentList: UncompressedQuad[]
    ): void {
        // Define working sweep axes dynamically based on chosen normal direction
        // d1 and d2 represent the 2D plane coordinate axes for scanning
        let mainAxis = 0, d1Axis = 1, d2Axis = 2;
        if (face === 0 || face === 1) { mainAxis = 1; d1Axis = 0; d2Axis = 2; } // Y sweep
        if (face === 4 || face === 5) { mainAxis = 0; d1Axis = 2; d2Axis = 1; } // X sweep

        // Mask used to mark completed processing components across a 2D 16x16 plane slice
        const mask = new Uint32Array(16 * 16);
        const normalOffset = (face % 2 === 0) ? -1 : 1;

        // Iterate along the main axis of extrusion
        for (let mainVal = 0; mainVal < 16; mainVal++) {
            // Step 1: Construct the visibility mask for this 2D slice
            let maskIdx = 0;
            for (let d2 = 0; d2 < 16; d2++) {
                for (let d1 = 0; d1 < 16; d1++) {
                    const coords = [0, 0, 0];
                    coords[mainAxis] = mainVal;
                    coords[d1Axis] = d1;
                    coords[d2Axis] = d2;

                    const currentBlock = this.sampler.getBlockStateId(coords[0], coords[1], coords[2]);
                    
                    if (currentBlock === 0) {
                        mask[maskIdx++] = 0;
                        continue;
                    }

                    // Check culling face against neighbor block
                    const neighborCoords = [...coords];
                    neighborCoords[mainAxis] += normalOffset;
                    
                    const isCulled = this.sampler.isFaceOpaque(
                        neighborCoords[0], neighborCoords[1], neighborCoords[2], 
                        this.isOpaqueLookup
                    );

                    if (isCulled) {
                        mask[maskIdx++] = 0; // Occluded, do not render
                    } else {
                        // Store the blockstate ID inside the mask to guarantee we match adjacent structural data
                        mask[maskIdx++] = currentBlock;
                    }
                }
            }

            // Step 2: Mesh the generated mask plane layout using an iterative 2D bounding block crawler
            maskIdx = 0;
            for (let d2 = 0; d2 < 16; d2++) {
                for (let d1 = 0; d1 < 16; d1++, maskIdx++) {
                    const blockId = mask[maskIdx];
                    if (blockId === 0) continue;

                    // Compute structural widths and heights of matching contiguous blocks
                    let width = 1;
                    while (d1 + width < 16 && mask[maskIdx + width] === blockId) {
                        width++;
                    }

                    let height = 1;
                    let rowMatch = true;
                    while (d2 + height < 16) {
                        for (let w = 0; w < width; w++) {
                            if (mask[maskIdx + w + (height * 16)] !== blockId) {
                                rowMatch = false;
                                break;
                            }
                        }
                        if (!rowMatch) break;
                        height++;
                    }

                    // Resolve underlying Model Quads to map UV coordinate scales accurately
                    const bakedQuads = this.quadResolver(blockId);
                    if (bakedQuads) {
                        const preciseFaceQuad = bakedQuads.find(q => q.faceDir === face);
                        if (preciseFaceQuad) {
                            
                            // Calculate per-vertex AO properties for the final combined quad boundaries
                            const aoPoints = [1, 1, 1, 1];
                            for (let v = 0; v < 4; v++) {
                                const cornerCoords = [0, 0, 0];
                                // Interpolate checking bounds accurately to perimeter elements
                                cornerCoords[mainAxis] = mainVal;
                                cornerCoords[d1Axis] = d1 + (v === 1 || v === 2 ? width : 0);
                                cornerCoords[d2Axis] = d2 + (v === 2 || v === 3 ? height : 0);

                                aoPoints[v] = AOGenerator.computeVertexAO(
                                    this.sampler,
                                    cornerCoords[0], cornerCoords[1], cornerCoords[2],
                                    face, v, this.isOpaqueLookup
                                );
                            }

                            const constructedQuad: UncompressedQuad = {
                                x: d1, y: mainVal, z: d2, // local relative coordinate mapping
                                w: width, h: height,
                                faceDir: face,
                                textureAtlasId: preciseFaceQuad.textureAtlasId,
                                u0: preciseFaceQuad.u0, v0: preciseFaceQuad.v0,
                                u1: preciseFaceQuad.u1, v1: preciseFaceQuad.v1,
                                ao: aoPoints,
                                tintIndex: preciseFaceQuad.tintIndex,
                                shade: preciseFaceQuad.shade
                            };

                            // Sort immediately to appropriate render group bucket
                            // In a full engine, check transparency settings on material registry
                            if (preciseFaceQuad.isTranslucent) {
                                translucentList.push(constructedQuad);
                            } else {
                                opaqueList.push(constructedQuad);
                            }
                        }
                    }

                    // Clear the consumed area of the mask so we don't repeat work
                    for (let h = 0; h < height; h++) {
                        for (let w = 0; w < width; w++) {
                            mask[maskIdx + w + (h * 16)] = 0;
                        }
                    }
                }
            }
        }
    }
}
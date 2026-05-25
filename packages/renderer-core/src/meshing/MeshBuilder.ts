/**
 * packages/renderer-core/src/meshing/MeshBuilder.ts
 *
 * Final stage of the meshing pipeline: convert greedy-mesher quads into
 * flat typed arrays suitable for Three.js BufferGeometry.
 *
 * Vertex layout matches the BlockShader attribute contract:
 *   position  vec3   (3 floats)
 *   normal    vec3   (3 floats)
 *   uv        vec2   (2 floats)  — atlas space, bounded to the source sprite rect
 *   ao        float  (1 float)   — per-vertex ambient occlusion, [0.2, 1.0]
 *   tintColor vec3   (3 floats)  — biome tint multiplier; (1,1,1) when no tint
 *
 * Face shading (the darker-on-side-faces look) is NOT baked here — the
 * fragment shader derives it from the normal. Baking it in here would
 * double-darken the result.
 *
 * Atlas UV contract:
 *  The baker has already remapped model-space UVs [0..16] into atlas-space
 *  UVs [0..1] for the exact sprite rectangle. The greedy mesher may merge
 *  many identical block faces into one large quad, but we must NOT multiply
 *  atlas UV deltas by the merged width/height here. Doing so walks out of
 *  the sprite's sub-rect and samples unrelated atlas texels. True tiled
 *  greedy faces need a future shader path that carries sprite bounds plus
 *  local tile coordinates separately.
 */

import { UncompressedQuad, RenderBuffers } from '../types/meshing';

export class MeshBuilder {
    /**
     * Convert a list of merged quads into transferable typed arrays.
     * Returns null for empty inputs so the caller can skip uploading an
     * empty BufferGeometry to the GPU.
     */
    public static buildBuffers(quads: UncompressedQuad[]): RenderBuffers | null {
        if (quads.length === 0) return null;

        const vertexCount = quads.length * 4;
        const indexCount  = quads.length * 6;

        const position  = new Float32Array(vertexCount * 3);
        const normal    = new Float32Array(vertexCount * 3);
        const uv        = new Float32Array(vertexCount * 2);
        const ao        = new Float32Array(vertexCount);     // 1 per vertex
        const tintColor = new Float32Array(vertexCount * 3); // (1,1,1) default
        const index     = new Uint32Array(indexCount);

        let vIdx = 0;
        let iIdx = 0;

        for (let q = 0; q < quads.length; q++) {
            const quad = quads[q]!;

            // 4 corner positions in section-local space [0..16]
            const verts = this.getQuadVertices(quad);
            // Face normal — constant across the quad
            const n = this.getNormalVector(quad.faceDir);

            for (let v = 0; v < 4; v++) {
                const vp = verts[v]!;

                position[vIdx * 3]     = vp[0]!;
                position[vIdx * 3 + 1] = vp[1]!;
                position[vIdx * 3 + 2] = vp[2]!;

                normal[vIdx * 3]     = n[0];
                normal[vIdx * 3 + 1] = n[1];
                normal[vIdx * 3 + 2] = n[2];

                // Vertex order matches a CCW winding (see getQuadVertices).
                // Keep UVs inside the baked atlas sprite rect. The previous
                // du * quad.w / dv * quad.h expansion made merged quads sample
                // outside their sprite and hit unrelated atlas texels.
                const onMaxU = (v === 1 || v === 2);
                const onMaxV = (v === 2 || v === 3);
                uv[vIdx * 2]     = onMaxU ? quad.u1 : quad.u0;
                uv[vIdx * 2 + 1] = onMaxV ? quad.v1 : quad.v0;

                // Per-vertex AO — the shader applies face shading on top.
                ao[vIdx] = quad.shade ? (quad.ao[v] ?? 1.0) : 1.0;

                // No biome tint yet — tintIndex resolution is deferred until
                // we have biome data per-block. (1,1,1) preserves base colour.
                tintColor[vIdx * 3]     = 1.0;
                tintColor[vIdx * 3 + 1] = 1.0;
                tintColor[vIdx * 3 + 2] = 1.0;

                vIdx++;
            }

            // Two CCW triangles per quad. Index pattern: 0,3,1,1,3,2
            const base = q * 4;
            index[iIdx++] = base;
            index[iIdx++] = base + 3;
            index[iIdx++] = base + 1;
            index[iIdx++] = base + 1;
            index[iIdx++] = base + 3;
            index[iIdx++] = base + 2;
        }

        return { position, normal, uv, ao, tintColor, index };
    }

    /**
     * Generate the 4 corner positions of a merged quad in section-local
     * space [0..16]. Vertex order matches the UV mapping in build above.
     *
     * Winding is CCW from outside the face — required by the shader's
     * default front-face culling.
     */
    private static getQuadVertices(quad: UncompressedQuad): number[][] {
        const { x, y, z, w, h, faceDir } = quad;
        switch (faceDir) {
            case 0: // Down (Y constant, normal -Y)
                return [
                    [x,     y, z    ],
                    [x + w, y, z    ],
                    [x + w, y, z + h],
                    [x,     y, z + h],
                ];
            case 1: // Up (Y constant, normal +Y)
                return [
                    [x,     y, z + h],
                    [x + w, y, z + h],
                    [x + w, y, z    ],
                    [x,     y, z    ],
                ];
            case 2: // North (Z constant, normal -Z)
                return [
                    [x + w, y + h, z],
                    [x + w, y,     z],
                    [x,     y,     z],
                    [x,     y + h, z],
                ];
            case 3: // South (Z constant, normal +Z)
                return [
                    [x,     y + h, z],
                    [x,     y,     z],
                    [x + w, y,     z],
                    [x + w, y + h, z],
                ];
            case 4: // West (X constant, normal -X) — w along Z, h along Y
                return [
                    [x, y + h, z + w],
                    [x, y,     z + w],
                    [x, y,     z    ],
                    [x, y + h, z    ],
                ];
            case 5: // East (X constant, normal +X) — w along Z, h along Y
                return [
                    [x, y + h, z    ],
                    [x, y,     z    ],
                    [x, y,     z + w],
                    [x, y + h, z + w],
                ];
            default:
                return [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
        }
    }

    /** Canonical normal vector for each face direction (matches AOGenerator). */
    private static getNormalVector(faceDir: number): [number, number, number] {
        switch (faceDir) {
            case 0: return [ 0, -1,  0]; // Down
            case 1: return [ 0,  1,  0]; // Up
            case 2: return [ 0,  0, -1]; // North
            case 3: return [ 0,  0,  1]; // South
            case 4: return [-1,  0,  0]; // West
            case 5: return [ 1,  0,  0]; // East
            default: return [0, 1, 0];
        }
    }
}

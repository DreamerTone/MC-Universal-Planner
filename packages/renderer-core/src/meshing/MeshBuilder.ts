import { UncompressedQuad, RenderBuffers } from '../types/meshing';

export class MeshBuilder {
    /**
     * Converts raw quad metrics to linear flat typed binary storage arrays.
     */
    public static buildBuffers(quads: UncompressedQuad[]): RenderBuffers | null {
        if (quads.length === 0) return null;

        const vertexCount = quads.length * 4;
        const indexCount = quads.length * 6;

        const positions = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2);
        const colors = new Float32Array(vertexCount * 4); // RGBA
        const normals = new Float32Array(vertexCount * 3);
        const indices = new Uint32Array(indexCount);

        let vIdx = 0;
        let iIdx = 0;

        for (let q = 0; q < quads.length; q++) {
            const quad = quads[q];

            // Define face structural vertices based on direction mapping rules
            const localVertices = this.getQuadVertices(quad);

            // Compute structural shading baseline constant from face normals
            let faceShading = 1.0;
            if (quad.shade) {
                switch (quad.faceDir) {
                    case 0: faceShading = 0.5; break; // Down
                    case 2: case 3: faceShading = 0.8; break; // North/South
                    case 4: case 5: faceShading = 0.6; break; // West/East
                }
            }

            for (let v = 0; v < 4; v++) {
                const vert = localVertices[v];
                
                // Write position parameters
                positions[vIdx * 3]     = vert[0];
                positions[vIdx * 3 + 1] = vert[1];
                positions[vIdx * 3 + 2] = vert[2];

                // Map matching edge texture space targets
                uvs[vIdx * 2]     = (v === 1 || v === 2) ? quad.u1 : quad.u0;
                uvs[vIdx * 2 + 1] = (v === 2 || v === 3) ? quad.v1 : quad.v0;

                // Color combined with smooth illumination lighting parameters
                const finalShade = faceShading * quad.ao[v];
                colors[vIdx * 4]     = finalShade; // Red tint multiplier
                colors[vIdx * 4 + 1] = finalShade; // Green tint multiplier
                colors[vIdx * 4 + 2] = finalShade; // Blue tint multiplier
                colors[vIdx * 4 + 3] = 1.0;        // Custom alpha flag placeholder

                // Normal definitions
                const norm = this.getNormalVector(quad.faceDir);
                normals[vIdx * 3]     = norm[0];
                normals[vIdx * 3 + 1] = norm[1];
                normals[vIdx * 3 + 2] = norm[2];

                vIdx++;
            }

            // Map standard double-triangle winding order index registers
            const baseVert = q * 4;
            indices[iIdx++] = baseVert;
            indices[iIdx++] = baseVert + 3;
            indices[iIdx++] = baseVert + 1;
            indices[iIdx++] = baseVert + 1;
            indices[iIdx++] = baseVert + 3;
            indices[iIdx++] = baseVert + 2;
        }

        return {
            position: positions,
            uv: uvs,
            color: colors,
            normal: normals,
            index: indices
        };
    }

    private static getQuadVertices(quad: UncompressedQuad): number[][] {
        const { x, y, z, w, h, faceDir } = quad;
        // Winding: counter-clockwise order mapping
        switch (faceDir) {
            case 0: // Down (Y constant)
                return [[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]];
            case 1: // Up (Y constant)
                return [[x, y, z + h], [x + w, y, z + h], [x + w, y, z], [x, y, z]];
            case 2: // North (Z constant)
                return [[x + w, y + h, z], [x + w, y, z], [x, y, z], [x, y + h, z]];
            case 3: // South (Z constant)
                return [[x, y + h, z], [x, y, z], [x + w, y, z], [x + w, y + h, z]];
            case 4: // West (X constant)
                return [[x, y + h, z + h], [x, y, z + h], [x, y, z], [x, y + h, z]];
            case 5: // East (X constant)
                return [[x, y + h, z], [x, y, z], [x, y, z + h], [x, y + h, z + h]];
            default:
                return [];
        }
    }

    private static getNormalVector(faceDir: number): number[] {
        switch (faceDir) {
            case 0: return [0, -1, 0];
            case 1: return [0, 1, 0];
            case 2: return [0, 0, -1];
            case 3: return [0, 0, 1];
            case 4: return [-1, 0, 0];
            case 5: return [1, 0, 0];
            default: return [0, 1, 0];
        }
    }
}
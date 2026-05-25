import { UncompressedQuad, RenderBuffers, StaticMeshQuad } from '../types/meshing';

export class MeshBuilder {
    public static buildBuffers(quads: UncompressedQuad[]): RenderBuffers | null {
        if (quads.length === 0) return null;

        const vertexCount = quads.length * 4;
        const indexCount  = quads.length * 6;

        const position  = new Float32Array(vertexCount * 3);
        const normal    = new Float32Array(vertexCount * 3);
        const uv        = new Float32Array(vertexCount * 2);
        const ao        = new Float32Array(vertexCount);
        const tintColor = new Float32Array(vertexCount * 3);
        const index     = new Uint32Array(indexCount);

        let vIdx = 0;
        let iIdx = 0;

        for (let q = 0; q < quads.length; q++) {
            const quad = quads[q]!;
            const verts = this.getQuadVertices(quad);
            const n = this.getNormalVector(quad.faceDir);

            for (let v = 0; v < 4; v++) {
                const vp = verts[v]!;
                position[vIdx * 3]     = vp[0]!;
                position[vIdx * 3 + 1] = vp[1]!;
                position[vIdx * 3 + 2] = vp[2]!;

                normal[vIdx * 3]     = n[0];
                normal[vIdx * 3 + 1] = n[1];
                normal[vIdx * 3 + 2] = n[2];

                const onMaxU = (v === 1 || v === 2);
                const onMaxV = (v === 2 || v === 3);
                uv[vIdx * 2]     = onMaxU ? quad.u1 : quad.u0;
                uv[vIdx * 2 + 1] = onMaxV ? quad.v1 : quad.v0;

                ao[vIdx] = quad.shade ? (quad.ao[v] ?? 1.0) : 1.0;
                tintColor[vIdx * 3]     = 1.0;
                tintColor[vIdx * 3 + 1] = 1.0;
                tintColor[vIdx * 3 + 2] = 1.0;

                vIdx++;
            }

            this.writeQuadIndices(index, iIdx, q * 4);
            iIdx += 6;
        }

        return { position, normal, uv, ao, tintColor, index };
    }

    public static buildStaticBuffers(quads: StaticMeshQuad[]): RenderBuffers | null {
        if (quads.length === 0) return null;

        const vertexCount = quads.length * 4;
        const indexCount = quads.length * 6;

        const position  = new Float32Array(vertexCount * 3);
        const normal    = new Float32Array(vertexCount * 3);
        const uv        = new Float32Array(vertexCount * 2);
        const ao        = new Float32Array(vertexCount);
        const tintColor = new Float32Array(vertexCount * 3);
        const index     = new Uint32Array(indexCount);

        let vIdx = 0;
        let iIdx = 0;

        for (let q = 0; q < quads.length; q++) {
            const quad = quads[q]!;
            const n = this.getNormalVector(quad.faceDir);

            for (let v = 0; v < 4; v++) {
                position[vIdx * 3]     = quad.positions[v * 3] ?? 0;
                position[vIdx * 3 + 1] = quad.positions[v * 3 + 1] ?? 0;
                position[vIdx * 3 + 2] = quad.positions[v * 3 + 2] ?? 0;

                normal[vIdx * 3]     = n[0];
                normal[vIdx * 3 + 1] = n[1];
                normal[vIdx * 3 + 2] = n[2];

                uv[vIdx * 2]     = quad.uvs[v * 2] ?? 0;
                uv[vIdx * 2 + 1] = quad.uvs[v * 2 + 1] ?? 0;

                ao[vIdx] = quad.shade ? 1.0 : 1.0;
                tintColor[vIdx * 3]     = 1.0;
                tintColor[vIdx * 3 + 1] = 1.0;
                tintColor[vIdx * 3 + 2] = 1.0;
                vIdx++;
            }

            this.writeQuadIndices(index, iIdx, q * 4);
            iIdx += 6;
        }

        return { position, normal, uv, ao, tintColor, index };
    }

    private static writeQuadIndices(index: Uint32Array, iIdx: number, base: number): void {
        index[iIdx]     = base;
        index[iIdx + 1] = base + 1;
        index[iIdx + 2] = base + 3;
        index[iIdx + 3] = base + 1;
        index[iIdx + 4] = base + 2;
        index[iIdx + 5] = base + 3;
    }

    private static getQuadVertices(quad: UncompressedQuad): number[][] {
        const { x, y, z, w, h, faceDir } = quad;
        switch (faceDir) {
            case 0:
                return [[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]];
            case 1: {
                const yy = y + 1;
                return [[x, yy, z + h], [x + w, yy, z + h], [x + w, yy, z], [x, yy, z]];
            }
            case 2:
                return [[x + w, y + h, z], [x + w, y, z], [x, y, z], [x, y + h, z]];
            case 3: {
                const zz = z + 1;
                return [[x, y + h, zz], [x, y, zz], [x + w, y, zz], [x + w, y + h, zz]];
            }
            case 4:
                return [[x, y + h, z + w], [x, y, z + w], [x, y, z], [x, y + h, z]];
            case 5: {
                const xx = x + 1;
                return [[xx, y + h, z], [xx, y, z], [xx, y, z + w], [xx, y + h, z + w]];
            }
            default:
                return [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
        }
    }

    private static getNormalVector(faceDir: number): [number, number, number] {
        switch (faceDir) {
            case 0: return [ 0, -1,  0];
            case 1: return [ 0,  1,  0];
            case 2: return [ 0,  0, -1];
            case 3: return [ 0,  0,  1];
            case 4: return [-1,  0,  0];
            case 5: return [ 1,  0,  0];
            default: return [0, 1, 0];
        }
    }
}

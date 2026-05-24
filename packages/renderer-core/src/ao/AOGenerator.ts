import { SectionSampler } from '../meshing/SectionSampler';

export class AOGenerator {
    /**
     * Computes the smooth AO factor for a single vertex on a given face direction.
     * Returns a float multiplier between 0.2 (darkest corner) and 1.0 (fully lit).
     * * @param sampler The localized section view
     * @param x Local block position X
     * @param y Local block position Y
     * @param z Local block position Z
     * @param faceDir The normal direction index of the face (0=Down, 1=Up, 2=North, 3=South, 4=West, 5=East)
     * @param vertexIndex Quad corner index (0 to 3) relative to the face winding
     * @param isOpaqueLookup Callback function to query block transparency
     */
    public static computeVertexAO(
        sampler: SectionSampler,
        x: number, y: number, z: number,
        faceDir: number,
        vertexIndex: number,
        isOpaqueLookup: (id: number) => boolean
    ): number {
        // Offsets relative to target face
        let dx = 0, dy = 0, dz = 0;
        // Side offsets to check the corner environment
        let s1x = 0, s1y = 0, s1z = 0;
        let s2x = 0, s2y = 0, s2z = 0;
        let c1x = 0, c1y = 0, c1z = 0;

        // Step 1: Establish direction vector matching the face direction normal
        switch (faceDir) {
            case 0: dy = -1; break; // Down
            case 1: dy = 1;  break; // Up
            case 2: dz = -1; break; // North
            case 3: dz = 1;  break; // South
            case 4: dx = -1; break; // West
            case 5: dx = 1;  break; // East
        }

        // Step 2: Determine orthogonal secondary vectors matching the specific vertex corner
        // This simulates looking out from the face towards the neighboring blocks
        if (dy !== 0) { // Up/Down faces
            const vOffsetsX = [-1, -1,  1,  1];
            const vOffsetsZ = [-1,  1,  1, -1];
            
            s1x = vOffsetsX[vertexIndex]; s1y = dy; s1z = 0;
            s2x = 0;                      s2y = dy; s2z = vOffsetsZ[vertexIndex];
            c1x = vOffsetsX[vertexIndex]; c1y = dy; c1z = vOffsetsZ[vertexIndex];
        } else if (dz !== 0) { // North/South faces
            const vOffsetsX = [-1, -1,  1,  1];
            const vOffsetsY = [-1,  1,  1, -1];

            s1x = vOffsetsX[vertexIndex]; s1y = 0;                      s1z = dz;
            s2x = 0;                      s2y = vOffsetsY[vertexIndex]; s2z = dz;
            c1x = vOffsetsX[vertexIndex]; c1y = vOffsetsY[vertexIndex]; c1z = dz;
        } else if (dx !== 0) { // West/East faces
            const vOffsetsZ = [-1, -1,  1,  1];
            const vOffsetsY = [-1,  1,  1, -1];

            s1x = dx; s1y = 0;                      s1z = vOffsetsZ[vertexIndex];
            s2x = dx; s2y = vOffsetsY[vertexIndex]; s2z = 0;
            c1x = dx; c1y = vOffsetsY[vertexIndex]; c1z = vOffsetsZ[vertexIndex];
        }

        // Step 3: Sample the 3 ambient blocks
        const side1 = sampler.isFaceOpaque(x + s1x, y + s1y, z + s1z, isOpaqueLookup) ? 1 : 0;
        const side2 = sampler.isFaceOpaque(x + s2x, y + s2y, z + s2z, isOpaqueLookup) ? 1 : 0;
        const corner = sampler.isFaceOpaque(x + c1x, y + c1y, z + c1z, isOpaqueLookup) ? 1 : 0;

        // Step 4: Map the combination to Minecraft's standard 4-stage illumination levels
        let value = 0;
        if (side1 === 1 && side2 === 1) {
            value = 0; // Both sides occluded means corner is pitch black
        } else {
            value = 3 - (side1 + side2 + corner);
        }

        // Return float brightness modifier
        switch (value) {
            case 0: return 0.2;
            case 1: return 0.48;
            case 2: return 0.74;
            default: return 1.0;
        }
    }
}
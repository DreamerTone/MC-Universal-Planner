export class ChunkSection {
    static SIZE = 16

    blocks: Uint32Array

    constructor() {
        this.blocks = new Uint32Array(16 * 16 * 16)
    }

    private index(x: number, y: number, z: number): number {
        return x + z * 16 + y * 256
    }

    getBlock(x: number, y: number, z: number): number {
        return this.blocks[this.index(x, y, z)]
    }

    setBlock(x: number, y: number, z: number, id: number) {
        this.blocks[this.index(x, y, z)] = id
    }
}
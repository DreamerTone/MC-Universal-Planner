export interface BlockDefinition {
    id: number
    identifier: string
    blockstate?: string
    model?: string
    textures?: string[]
}

export class BlockRegistry {
    private blocksById = new Map<number, BlockDefinition>()
    private blocksByIdentifier = new Map<string, BlockDefinition>()

    register(block: BlockDefinition) {
        this.blocksById.set(block.id, block)
        this.blocksByIdentifier.set(block.identifier, block)
    }

    getById(id: number) {
        return this.blocksById.get(id)
    }

    getByIdentifier(identifier: string) {
        return this.blocksByIdentifier.get(identifier)
    }
}
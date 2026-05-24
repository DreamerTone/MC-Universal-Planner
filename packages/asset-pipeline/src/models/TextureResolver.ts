export class TextureResolver {

    resolveTexture(
        texture: string,
        textures: Record<string, string>
    ): string {

        const visited = new Set<string>()

        let current = texture

        while (current.startsWith("#")) {

            const key = current.substring(1)

            if (visited.has(key)) {
                throw new Error(
                    `Circular texture reference: ${key}`
                )
            }

            visited.add(key)

            const resolved = textures[key]

            if (!resolved) {
                throw new Error(
                    `Missing texture variable: ${key}`
                )
            }

            current = resolved
        }

        return current
    }
}
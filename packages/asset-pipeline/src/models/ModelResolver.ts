export interface ModelFace {
    texture: string
    uv?: number[]
    rotation?: number
    cullface?: string
    tintindex?: number
}

export interface ModelElement {
    from: number[]
    to: number[]

    rotation?: {
        origin: number[]
        axis: "x" | "y" | "z"
        angle: number
        rescale?: boolean
    }

    faces: Record<string, ModelFace>
}

export interface ModelDisplayTransform {
    rotation?: number[]
    translation?: number[]
    scale?: number[]
}

export interface ModelDefinition {
    parent?: string

    ambientocclusion?: boolean

    textures?: Record<string, string>

    elements?: ModelElement[]

    display?: Record<string, ModelDisplayTransform>
}

export class ModelResolver {
    resolve(
        modelName: string,
        modelMap: Record<string, ModelDefinition>
    ): ModelDefinition {

        const visited = new Set<string>()

        const resolveRecursive = (
            currentName: string
        ): ModelDefinition => {

            if (visited.has(currentName)) {
                throw new Error(
                    `Circular model inheritance detected: ${currentName}`
                )
            }

            visited.add(currentName)

            const current = modelMap[currentName]

            if (!current) {
                throw new Error(
                    `Missing model: ${currentName}`
                )
            }

            if (!current.parent) {
                return structuredClone(current)
            }

            const parent = resolveRecursive(current.parent)

            return this.mergeModels(parent, current)
        }

        return resolveRecursive(modelName)
    }

    private mergeModels(
        parent: ModelDefinition,
        child: ModelDefinition
    ): ModelDefinition {

        return {
            ...parent,
            ...child,

            textures: {
                ...parent.textures,
                ...child.textures
            },

            display: {
                ...parent.display,
                ...child.display
            },

            elements:
                child.elements ??
                parent.elements
        }
    }
}
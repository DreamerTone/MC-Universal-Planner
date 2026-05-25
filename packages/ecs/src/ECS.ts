export type EntityId = number

export class ECS {
    private nextEntityId = 0

    private componentStores = new Map<string, Map<EntityId, any>>()

    createEntity(): EntityId {
        return this.nextEntityId++
    }

    registerComponent(name: string) {
        if (!this.componentStores.has(name)) {
            this.componentStores.set(name, new Map())
        }
    }

    addComponent<T>(
        entity: EntityId,
        componentName: string,
        data: T
    ) {
        this.componentStores.get(componentName)?.set(entity, data)
    }

    getComponent<T>(entity: EntityId, componentName: string): T | undefined {
        return this.componentStores.get(componentName)?.get(entity)
    }

    query(componentNames: string[]) {
        const result: EntityId[] = []

        const head = componentNames[0]
        if (!head) return result

        const first = this.componentStores.get(head)

        if (!first) return result

        for (const entity of first.keys()) {
            let valid = true

            for (const component of componentNames) {
                if (!this.componentStores.get(component)?.has(entity)) {
                    valid = false
                    break
                }
            }

            if (valid) {
                result.push(entity)
            }
        }

        return result
    }
}
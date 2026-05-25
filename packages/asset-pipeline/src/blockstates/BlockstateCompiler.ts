import { ParsedBlockstate } from "./BlockstateParser"

interface CompiledVariantEntry {
    conditions: Record<string, string>
    [key: string]: unknown
}

interface CompiledBlockstate {
    variants: CompiledVariantEntry[]
    multipart: unknown[]
}

export class BlockstateCompiler {

    compile(
        parsed: ParsedBlockstate
    ): CompiledBlockstate {

        const compiled: CompiledBlockstate = {
            variants: [],
            multipart: []
        }

        if (parsed.variants) {

            for (const [key, value] of Object.entries(parsed.variants)) {

                const conditions: Record<string, string> = {}

                if (key !== "") {

                    for (const pair of key.split(",")) {

                        const [k, v] = pair.split("=")

                        if (k) conditions[k] = v ?? ""
                    }
                }

                compiled.variants.push({
                    conditions,
                    ...(value as Record<string, unknown>)
                })
            }
        }

        if (parsed.multipart) {

            compiled.multipart.push(
                ...parsed.multipart
            )
        }

        return compiled
    }
}
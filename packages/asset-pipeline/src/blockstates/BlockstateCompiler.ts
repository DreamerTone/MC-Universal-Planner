import { ParsedBlockstate } from "./BlockstateParser"

export class BlockstateCompiler {

    compile(
        parsed: ParsedBlockstate
    ) {

        const compiled = {
            variants: [],
            multipart: []
        }

        if (parsed.variants) {

            for (const [key, value] of Object.entries(parsed.variants)) {

                const conditions: Record<string, string> = {}

                if (key !== "") {

                    for (const pair of key.split(",")) {

                        const [k, v] = pair.split("=")

                        conditions[k] = v
                    }
                }

                compiled.variants.push({
                    conditions,
                    ...(value as any)
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
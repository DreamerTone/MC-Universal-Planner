export interface MultipartCondition {
    when: any
    apply: any
}

export interface ParsedBlockstate {
    variants?: Record<string, any>
    multipart?: MultipartCondition[]
}

export class BlockstateParser {
    parse(content: string): ParsedBlockstate {
        return JSON.parse(content)
    }
}
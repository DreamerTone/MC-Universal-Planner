export interface CompiledVariant {

    conditions: Record<string, string>

    model: string

    x?: number
    y?: number

    uvlock?: boolean
}

export interface CompiledMultipart {

    when?: any

    apply: any
}

export interface CompiledBlockstate {

    variants: CompiledVariant[]

    multipart: CompiledMultipart[]
}
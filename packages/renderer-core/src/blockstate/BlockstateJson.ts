/**
 * packages/renderer-core/src/blockstate/BlockstateJson.ts
 *
 * TypeScript types that exactly mirror Minecraft's blockstate JSON format.
 *
 * These are the RAW types — the on-disk JSON format as produced by vanilla
 * Minecraft and mods. The compiler (BlockstateCompiler.ts) consumes these
 * and produces the engine's internal representation.
 *
 * WHY mirror the exact format?
 * Minecraft's blockstate JSON has two top-level shapes: "variants" and
 * "multipart". They are mutually exclusive per file. Some mods produce files
 * with unusual orderings or optional fields, so we make everything optional
 * and handle nullish values defensively in the compiler.
 *
 * Source reference: https://minecraft.wiki/w/Tutorials/Models#Block_states
 *
 * VARIANTS format:
 * {
 *   "variants": {
 *     "facing=north,half=bottom": { "model": "minecraft:block/oak_stairs" },
 *     "facing=north,half=bottom,shape=inner_left": [
 *       { "model": "...", "weight": 1 },
 *       { "model": "...", "weight": 2 }
 *     ]
 *   }
 * }
 *
 * MULTIPART format:
 * {
 *   "multipart": [
 *     { "apply": { "model": "fence_post" } },
 *     { "when": { "north": "true" }, "apply": { "model": "fence_side", "y": 0 } },
 *     { "when": { "OR": [{"north":"true"},{"south":"true"}] }, "apply": ... }
 *   ]
 * }
 */

// ── Model Application ──────────────────────────────────────────────────────

/** A single model application with optional transform overrides */
export interface ModelApply {
  model: string          // resource location, e.g. "minecraft:block/oak_stairs"
  x?: number             // X rotation: 0, 90, 180, 270
  y?: number             // Y rotation: 0, 90, 180, 270
  uvlock?: boolean       // Lock UV coordinates when rotating
  weight?: number        // Weight for weighted random selection (default: 1)
}

/** A variant value is either a single apply or an array for weighted random */
export type VariantValue = ModelApply | ModelApply[]

// ── Variants Format ────────────────────────────────────────────────────────

/**
 * The variants map keys are comma-separated property=value pairs.
 * The empty string "" is the key for blocks with no properties.
 * Key ordering MUST match the block's declared property order.
 */
export interface VariantsBlockstate {
  variants: Record<string, VariantValue>
}

// ── Multipart Format ───────────────────────────────────────────────────────

/**
 * A simple condition: { propertyName: "value" | "value1|value2" }
 * Pipe-separated values mean OR within that property.
 * e.g. { "facing": "north|south" } matches facing=north OR facing=south
 */
export type SimpleCondition = Record<string, string>

/**
 * A compound condition using OR logic across multiple property sets.
 * { "OR": [{ "north": "true" }, { "south": "true" }] }
 * All conditions in the array are OR'd together.
 */
export interface OrCondition {
  OR: SimpleCondition[]
}

/**
 * A compound condition using AND logic.
 * { "AND": [...] } — less common but used by some mods
 */
export interface AndCondition {
  AND: SimpleCondition[]
}

export type MultipartCondition = SimpleCondition | OrCondition | AndCondition

export interface MultipartPart {
  /** Optional condition — if absent, always applied */
  when?: MultipartCondition
  /** Model(s) to apply when condition is met */
  apply: ModelApply | ModelApply[]
}

export interface MultipartBlockstate {
  multipart: MultipartPart[]
}

/** The top-level blockstate JSON — one of these two shapes */
export type BlockstateJson = VariantsBlockstate | MultipartBlockstate

// ── Type guards ────────────────────────────────────────────────────────────

export function isVariantsBlockstate(json: BlockstateJson): json is VariantsBlockstate {
  return 'variants' in json
}

export function isMultipartBlockstate(json: BlockstateJson): json is MultipartBlockstate {
  return 'multipart' in json
}

export function isOrCondition(c: MultipartCondition): c is OrCondition {
  return 'OR' in c
}

export function isAndCondition(c: MultipartCondition): c is AndCondition {
  return 'AND' in c
}

/**
 * Parse a variant key string into a property map.
 * "facing=north,half=bottom,shape=straight" → { facing: 'north', half: 'bottom', shape: 'straight' }
 * "" → {}
 */
export function parseVariantKey(key: string): Record<string, string> {
  if (!key || key === '') return {}
  return Object.fromEntries(
    key.split(',').map(pair => {
      const eqIdx = pair.indexOf('=')
      return [pair.slice(0, eqIdx), pair.slice(eqIdx + 1)]
    })
  )
}

/**
 * Serialize a property map back into a variant key.
 * Properties are sorted alphabetically to match Minecraft's canonical ordering.
 */
export function serializeVariantKey(properties: Record<string, string>): string {
  return Object.keys(properties)
    .sort()
    .map(k => `${k}=${properties[k]}`)
    .join(',')
}

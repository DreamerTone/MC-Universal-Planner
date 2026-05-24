/**
 * packages/renderer-core/src/blockstate/CompiledBlockstate.ts
 *
 * Internal (compiled) blockstate representation.
 *
 * The compiler transforms the raw JSON blockstate into this format,
 * which is optimized for runtime evaluation:
 *
 *  Raw JSON (on-disk):
 *   - Nested OR/AND conditions as plain objects
 *   - Property strings requiring parse at eval time
 *   - Weighted arrays requiring random at eval time
 *
 *  Compiled (in-memory):
 *   - Conditions as typed union with pre-parsed values
 *   - Variant lookup indexed by sorted property key
 *   - Weighted model arrays with pre-computed cumulative weights
 *   - Connectivity rules extracted from multipart conditions
 *
 * WHY compile instead of evaluating raw JSON directly?
 *  Blockstate evaluation happens PER BLOCK PER MESHING PASS.
 *  A 16³ section contains up to 4096 blocks. With connectivity blocks
 *  (fences, walls, etc.) needing 6 neighbor lookups each, even a modest
 *  scene evaluates tens of thousands of conditions per remesh.
 *  Compiled conditions eliminate string parsing and allocation hot paths.
 *
 * Future: the compiled form is also the serialization format for the
 * blockstate cache — serialized to disk after first compile so subsequent
 * loads skip the JSON parsing entirely.
 */

import type { ResourceLocation } from '@mc-planner/shared'

// ── Compiled Model Reference ───────────────────────────────────────────────

export interface CompiledModelRef {
  /** Resolved resource location of the model */
  modelId: ResourceLocation
  /** X rotation in degrees: 0 | 90 | 180 | 270 */
  rotationX: 0 | 90 | 180 | 270
  /** Y rotation in degrees: 0 | 90 | 180 | 270 */
  rotationY: 0 | 90 | 180 | 270
  /** Whether to lock UVs when rotating */
  uvLock: boolean
}

/** A weighted entry in a random model selection set */
export interface WeightedModelRef {
  model: CompiledModelRef
  /** Cumulative weight (used for O(1) random lookup) */
  cumulativeWeight: number
}

/** A weighted model selection: pick one based on a seed value */
export interface WeightedModelSet {
  entries: WeightedModelRef[]
  totalWeight: number
}

/** Select a model from a weighted set using a deterministic seed */
export function selectWeightedModel(set: WeightedModelSet, seed: number): CompiledModelRef {
  if (set.entries.length === 1) return set.entries[0]!.model
  const r = (seed % set.totalWeight + set.totalWeight) % set.totalWeight
  for (const entry of set.entries) {
    if (r < entry.cumulativeWeight) return entry.model
  }
  return set.entries[set.entries.length - 1]!.model
}

// ── Compiled Conditions ────────────────────────────────────────────────────

export type CompiledCondition =
  | { type: 'propertyEquals';  name: string; values: readonly string[] }
  | { type: 'or';  conditions: readonly CompiledCondition[] }
  | { type: 'and'; conditions: readonly CompiledCondition[] }
  | { type: 'always' }  // unconditional multipart part

/** Evaluate a compiled condition against a property map */
export function evaluateCondition(
  condition: CompiledCondition,
  properties: Readonly<Record<string, string>>
): boolean {
  switch (condition.type) {
    case 'always':
      return true
    case 'propertyEquals':
      return condition.values.includes(properties[condition.name] ?? '')
    case 'or':
      return condition.conditions.some(c => evaluateCondition(c, properties))
    case 'and':
      return condition.conditions.every(c => evaluateCondition(c, properties))
  }
}

// ── Compiled Blockstate ────────────────────────────────────────────────────

/**
 * Variants blockstate: maps a sorted property key → weighted model set.
 * Built as a Map for O(1) lookup by key.
 *
 * e.g. "facing=north,half=bottom,shape=straight" → WeightedModelSet
 */
export interface CompiledVariantsBlockstate {
  type: 'variants'
  /** Map from canonical variant key → model set */
  variants: Map<string, WeightedModelSet>
  /**
   * List of property names in their DECLARED order.
   * Used to construct the lookup key from a BlockState's property map.
   */
  propertyOrder: readonly string[]
}

/**
 * A compiled multipart part: condition + list of model refs to apply.
 * Multiple parts can fire for the same block (e.g. fence post + each side).
 */
export interface CompiledMultipartPart {
  condition: CompiledCondition
  models: WeightedModelSet
}

/**
 * Multipart blockstate: ordered list of conditional parts.
 * Evaluate ALL parts and collect models for each true condition.
 * (Unlike variants where exactly one fires.)
 */
export interface CompiledMultipartBlockstate {
  type: 'multipart'
  parts: readonly CompiledMultipartPart[]
}

export type CompiledBlockstate =
  | CompiledVariantsBlockstate
  | CompiledMultipartBlockstate

// ── Blockstate Evaluation Result ───────────────────────────────────────────

/** The result of evaluating a blockstate: a list of model refs to render */
export interface BlockstateEvalResult {
  /** All model refs that should be rendered for this block */
  models: CompiledModelRef[]
}

/**
 * Evaluate a compiled blockstate against a property map.
 * Returns the list of model references to render.
 *
 * For variants: exactly one model fires.
 * For multipart: zero or more parts fire (fences have 1-5 parts).
 *
 * @param seed - deterministic seed for weighted random (use packed block pos)
 */
export function evaluateBlockstate(
  compiled: CompiledBlockstate,
  properties: Readonly<Record<string, string>>,
  seed: number
): BlockstateEvalResult {
  if (compiled.type === 'variants') {
    return evaluateVariants(compiled, properties, seed)
  } else {
    return evaluateMultipart(compiled, properties, seed)
  }
}

function evaluateVariants(
  compiled: CompiledVariantsBlockstate,
  properties: Readonly<Record<string, string>>,
  seed: number
): BlockstateEvalResult {
  // Build the canonical key from declared property order
  const key = compiled.propertyOrder
    .filter(p => p in properties)
    .map(p => `${p}=${properties[p]}`)
    .join(',')

  const modelSet = compiled.variants.get(key)

  if (!modelSet) {
    // Fallback: try empty-key variant (no-property blocks like air, stone)
    const fallback = compiled.variants.get('')
    if (fallback) return { models: [selectWeightedModel(fallback, seed)] }

    console.warn(`[BlockstateEval] No variant found for key: "${key}"`)
    return { models: [] }
  }

  return { models: [selectWeightedModel(modelSet, seed)] }
}

function evaluateMultipart(
  compiled: CompiledMultipartBlockstate,
  properties: Readonly<Record<string, string>>,
  seed: number
): BlockstateEvalResult {
  const models: CompiledModelRef[] = []

  for (const part of compiled.parts) {
    if (evaluateCondition(part.condition, properties)) {
      models.push(selectWeightedModel(part.models, seed))
    }
  }

  return { models }
}

/**
 * packages/renderer-core/src/blockstate/BlockstateCompiler.ts
 *
 * The blockstate compiler — transforms raw JSON blockstates into
 * runtime-optimized compiled form and registers block definitions.
 *
 * This is the entry point called for every block after JAR loading:
 *   for each namespace in assetIndex:
 *     for each blockstate entry:
 *       BlockstateCompiler.compile(resourceLocation, jsonString)
 *
 * What it does for each blockstate:
 *  1. Parse JSON
 *  2. Detect variants vs multipart
 *  3. For variants:
 *     a. Parse property order from variant keys
 *     b. Build Map<variantKey, WeightedModelSet>
 *     c. Register BlockDefinition in globalBlockRegistry
 *  4. For multipart:
 *     a. Compile conditions into typed CompiledCondition tree
 *     b. Extract connectivity rules → globalConnectivityRegistry
 *     c. Register BlockDefinition with isMultipart=true
 *  5. Store compiled blockstate in BlockstateRegistry
 *  6. Register all possible BlockState instances with globalBlockStateRegistry
 *     (generates every combination of property values)
 *
 * Step 6 (enumerating all states) is critical: the chunk storage uses numeric
 * IDs, and those IDs must be registered before any chunk data references them.
 * A 20-property block with 3 values each = 3^20 ≈ 3.5 billion states (pathological).
 * In practice Minecraft blocks average 8-80 states each; we cap enumeration at
 * 4096 states per block and warn loudly if exceeded.
 *
 * Threading:
 *  Compilation runs in the renderer process on an idle requestIdleCallback loop.
 *  Large modpacks have 10,000+ blockstates; compiling synchronously would block
 *  the UI thread for seconds. The idle loop processes ~50 blockstates per slice.
 */

import type { ResourceLocation } from '@mc-planner/shared'
import {
  globalBlockStateRegistry,
  globalBlockRegistry,
  BlockDefinitionBuilder,
} from '@mc-planner/world-engine'
import type {
  BlockstateJson,
  VariantsBlockstate,
  MultipartBlockstate,
  ModelApply,
  VariantValue,
  MultipartCondition,
} from './BlockstateJson'
import {
  isVariantsBlockstate,
  isMultipartBlockstate,
  isOrCondition,
  isAndCondition,
  parseVariantKey,
} from './BlockstateJson'
import type {
  CompiledBlockstate,
  CompiledVariantsBlockstate,
  CompiledMultipartBlockstate,
  CompiledMultipartPart,
  CompiledCondition,
  CompiledModelRef,
  WeightedModelSet,
  WeightedModelRef,
} from './CompiledBlockstate'
import { extractConnectivityRules } from './ConnectivityExtractor'

const MAX_STATES_PER_BLOCK = 4096

// ── Blockstate Registry ────────────────────────────────────────────────────

/**
 * In-memory registry of compiled blockstates.
 * Keyed by block resource location (not full state — one per block TYPE).
 */
class BlockstateRegistry {
  private readonly compiled = new Map<ResourceLocation, CompiledBlockstate>()

  set(blockId: ResourceLocation, compiled: CompiledBlockstate): void {
    this.compiled.set(blockId, compiled)
  }

  get(blockId: ResourceLocation): CompiledBlockstate | undefined {
    return this.compiled.get(blockId)
  }

  has(blockId: ResourceLocation): boolean {
    return this.compiled.has(blockId)
  }

  get size(): number {
    return this.compiled.size
  }
}

export const globalBlockstateRegistry = new BlockstateRegistry()

// ── Compiler ───────────────────────────────────────────────────────────────

export class BlockstateCompiler {
  private compiled = 0
  private errors = 0

  /**
   * Compile a single blockstate JSON string.
   *
   * @param blockId - The resource location of the block (e.g. 'minecraft:oak_stairs')
   * @param jsonString - Raw JSON content from the JAR
   * @param blockTags - Tags this block belongs to (for connectivity inference)
   * @returns true on success, false on parse/compile error
   */
  compile(
    blockId: ResourceLocation,
    jsonString: string,
    blockTags: readonly string[] = []
  ): boolean {
    let json: BlockstateJson

    try {
      json = JSON.parse(jsonString) as BlockstateJson
    } catch (e) {
      console.error(`[BlockstateCompiler] Failed to parse JSON for ${blockId}:`, e)
      this.errors++
      return false
    }

    try {
      if (isVariantsBlockstate(json)) {
        this.compileVariants(blockId, json)
      } else if (isMultipartBlockstate(json)) {
        this.compileMultipart(blockId, json, blockTags)
      } else {
        console.error(`[BlockstateCompiler] Unknown blockstate format for ${blockId}`)
        this.errors++
        return false
      }

      this.compiled++
      return true
    } catch (e) {
      console.error(`[BlockstateCompiler] Compile error for ${blockId}:`, e)
      this.errors++
      return false
    }
  }

  // ── Variants Compilation ─────────────────────────────────────────────────

  private compileVariants(blockId: ResourceLocation, json: VariantsBlockstate): void {
    const variantMap = new Map<string, WeightedModelSet>()

    // Determine property order from the first non-empty variant key
    let propertyOrder: string[] = []
    for (const key of Object.keys(json.variants)) {
      if (key !== '') {
        const parsed = parseVariantKey(key)
        propertyOrder = Object.keys(parsed).sort()
        break
      }
    }

    for (const [rawKey, value] of Object.entries(json.variants)) {
      const modelSet = buildWeightedModelSet(value)
      variantMap.set(rawKey, modelSet)
    }

    const compiled: CompiledVariantsBlockstate = {
      type: 'variants',
      variants: variantMap,
      propertyOrder,
    }

    globalBlockstateRegistry.set(blockId, compiled)

    // Register BlockDefinition
    const builder = new BlockDefinitionBuilder(blockId)
    builder.isMultipart = false

    // Extract property definitions from variant keys
    const propertyValues = extractPropertyValues(json.variants)
    for (const [propName, values] of propertyValues) {
      builder.addProperty(propName, values, values[0]!)
    }

    globalBlockRegistry.register(builder.build())

    // Enumerate and register all possible blockstates
    this.registerAllStates(blockId, propertyValues)
  }

  // ── Multipart Compilation ─────────────────────────────────────────────────

  private compileMultipart(
    blockId: ResourceLocation,
    json: MultipartBlockstate,
    blockTags: readonly string[]
  ): void {
    const parts: CompiledMultipartPart[] = []

    for (const part of json.multipart) {
      const condition: CompiledCondition = part.when
        ? compileCondition(part.when)
        : { type: 'always' }

      const models = buildWeightedModelSet(part.apply)
      parts.push({ condition, models })
    }

    const compiled: CompiledMultipartBlockstate = {
      type: 'multipart',
      parts,
    }

    globalBlockstateRegistry.set(blockId, compiled)

    // Extract connectivity rules from multipart conditions
    extractConnectivityRules(blockId, json, blockTags)

    // Register BlockDefinition
    const builder = new BlockDefinitionBuilder(blockId)
    builder.isMultipart = true

    // For multipart blocks, properties come from the condition property names
    const propsFromConditions = extractMultipartProperties(json)
    for (const [propName, values] of propsFromConditions) {
      builder.addProperty(propName, values, values[0]!)
    }

    // Mark connectivity properties
    builder.connectivityProperties = Array.from(propsFromConditions.keys())
      .filter(p => ['north', 'south', 'east', 'west', 'up', 'down'].includes(p))

    globalBlockRegistry.register(builder.build())

    // Register all possible states
    this.registerAllStates(blockId, propsFromConditions)
  }

  // ── State Enumeration ─────────────────────────────────────────────────────

  /**
   * Register every combination of property values as a BlockState ID.
   * This populates globalBlockStateRegistry so chunk sections can store numeric IDs.
   */
  private registerAllStates(
    blockId: ResourceLocation,
    properties: Map<string, string[]>
  ): void {
    const propEntries = Array.from(properties.entries())

    if (propEntries.length === 0) {
      // Block with no properties — single state
      globalBlockStateRegistry.register({ id: blockId, properties: {} })
      return
    }

    // Count total states
    const totalStates = propEntries.reduce((acc, [, values]) => acc * values.length, 1)

    if (totalStates > MAX_STATES_PER_BLOCK) {
      console.warn(
        `[BlockstateCompiler] ${blockId} has ${totalStates} states (>${MAX_STATES_PER_BLOCK}), ` +
        `truncating enumeration. This mod may require extended state IDs.`
      )
    }

    // Generate all combinations via cartesian product
    let combinations: Record<string, string>[] = [{}]

    for (const [propName, values] of propEntries) {
      const next: Record<string, string>[] = []
      for (const existing of combinations) {
        for (const value of values) {
          next.push({ ...existing, [propName]: value })
        }
      }
      combinations = next
      if (combinations.length > MAX_STATES_PER_BLOCK) {
        combinations = combinations.slice(0, MAX_STATES_PER_BLOCK)
        break
      }
    }

    for (const props of combinations) {
      globalBlockStateRegistry.register({ id: blockId, properties: props })
    }
  }

  get compiledCount(): number { return this.compiled }
  get errorCount(): number { return this.errors }
}

// ── Idle-Loop Batch Compiler ───────────────────────────────────────────────

/**
 * Compile a large list of blockstates across multiple idle callbacks.
 * Prevents blocking the UI thread during initial mod load.
 *
 * @param jobs - Array of { blockId, jsonString, blockTags } to compile
 * @param onProgress - called after each batch with (compiled, total)
 * @returns Promise that resolves when all blockstates are compiled
 */
export function compileBlockstatesAsync(
  jobs: Array<{ blockId: ResourceLocation; jsonString: string; blockTags?: string[] }>,
  onProgress?: (compiled: number, total: number) => void
): Promise<{ compiled: number; errors: number }> {
  return new Promise(resolve => {
    const compiler = new BlockstateCompiler()
    const BATCH_SIZE = 50
    let index = 0

    function processBatch(deadline?: IdleDeadline) {
      const end = Math.min(index + BATCH_SIZE, jobs.length)
      while (index < end) {
        const job = jobs[index]!
        compiler.compile(job.blockId, job.jsonString, job.blockTags ?? [])
        index++
      }

      onProgress?.(index, jobs.length)

      if (index < jobs.length) {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(processBatch, { timeout: 100 })
        } else {
          setTimeout(processBatch, 0)
        }
      } else {
        resolve({ compiled: compiler.compiledCount, errors: compiler.errorCount })
      }
    }

    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(processBatch, { timeout: 100 })
    } else {
      setTimeout(processBatch, 0)
    }
  })
}

// ── Helper functions ───────────────────────────────────────────────────────

function buildWeightedModelSet(value: VariantValue): WeightedModelSet {
  const applies = Array.isArray(value) ? value : [value]
  let cumulativeWeight = 0
  const entries: WeightedModelRef[] = applies.map(apply => {
    cumulativeWeight += apply.weight ?? 1
    return {
      model: compileModelApply(apply),
      cumulativeWeight,
    }
  })
  return { entries, totalWeight: cumulativeWeight }
}

function compileModelApply(apply: ModelApply): CompiledModelRef {
  const rx = apply.x ?? 0
  const ry = apply.y ?? 0

  // Validate rotation values
  const validRotations = [0, 90, 180, 270] as const
  const rotationX = validRotations.includes(rx as 0 | 90 | 180 | 270)
    ? (rx as 0 | 90 | 180 | 270)
    : 0
  const rotationY = validRotations.includes(ry as 0 | 90 | 180 | 270)
    ? (ry as 0 | 90 | 180 | 270)
    : 0

  return {
    modelId: resolveModelId(apply.model),
    rotationX,
    rotationY,
    uvLock: apply.uvlock ?? false,
  }
}

/**
 * Ensure a model ID has the correct namespace prefix.
 * Minecraft model references can be:
 *   "minecraft:block/stone"     → already qualified
 *   "block/stone"               → needs "minecraft:" prefix
 *   "create:block/shaft"        → already qualified
 */
function resolveModelId(rawModel: string): ResourceLocation {
  if (rawModel.includes(':')) return rawModel as ResourceLocation
  return `minecraft:${rawModel}` as ResourceLocation
}

function compileCondition(condition: MultipartCondition): CompiledCondition {
  if (isOrCondition(condition)) {
    return {
      type: 'or',
      conditions: condition.OR.map(c => compileCondition(c)),
    }
  }

  if (isAndCondition(condition)) {
    return {
      type: 'and',
      conditions: condition.AND.map(c => compileCondition(c)),
    }
  }

  // Simple condition: { propName: "val1|val2" }
  const entries = Object.entries(condition)

  if (entries.length === 1) {
    const [name, rawValue] = entries[0]!
    return {
      type: 'propertyEquals',
      name,
      values: rawValue.split('|'),
    }
  }

  // Multiple properties in one simple condition → implicit AND
  return {
    type: 'and',
    conditions: entries.map(([name, rawValue]) => ({
      type: 'propertyEquals' as const,
      name,
      values: rawValue.split('|'),
    })),
  }
}

/**
 * Extract the set of distinct values for each property from variant keys.
 * Returns a Map<propertyName, sortedValues[]> preserving natural sort.
 */
function extractPropertyValues(
  variants: Record<string, VariantValue>
): Map<string, string[]> {
  const propValues = new Map<string, Set<string>>()

  for (const key of Object.keys(variants)) {
    if (!key) continue
    const parsed = parseVariantKey(key)
    for (const [prop, value] of Object.entries(parsed)) {
      if (!propValues.has(prop)) propValues.set(prop, new Set())
      propValues.get(prop)!.add(value)
    }
  }

  return new Map(
    Array.from(propValues.entries()).map(([k, v]) => [k, Array.from(v).sort()])
  )
}

/**
 * Extract property names and their seen values from multipart conditions.
 * Scans all when-conditions recursively.
 */
function extractMultipartProperties(json: MultipartBlockstate): Map<string, string[]> {
  const propValues = new Map<string, Set<string>>()

  function scanCondition(condition: MultipartCondition): void {
    if (isOrCondition(condition)) {
      condition.OR.forEach(scanCondition)
      return
    }
    if (isAndCondition(condition)) {
      condition.AND.forEach(scanCondition)
      return
    }
    for (const [key, rawValue] of Object.entries(condition)) {
      if (key === 'OR' || key === 'AND') continue
      if (!propValues.has(key)) propValues.set(key, new Set())
      for (const v of rawValue.split('|')) {
        propValues.get(key)!.add(v)
      }
    }
  }

  for (const part of json.multipart) {
    if (part.when) scanCondition(part.when)
  }

  return new Map(
    Array.from(propValues.entries()).map(([k, v]) => [k, Array.from(v).sort()])
  )
}

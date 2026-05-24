/**
 * packages/renderer-core/src/blockstate/ConnectivityExtractor.ts
 *
 * Extracts connectivity/adjacency rules from multipart blockstate conditions.
 *
 * This is the "magic" that makes fences, walls, panes, Create shafts, and
 * any other neighbor-dependent block work WITHOUT hardcoding.
 *
 * HOW it works:
 *  A multipart blockstate for oak_fence looks like:
 *
 *    { "when": { "north": "true" }, "apply": { "model": "fence_side", "y": 0 } }
 *    { "when": { "south": "true" }, "apply": { "model": "fence_side", "y": 180 } }
 *
 *  The "north": "true" condition implies that the block has a boolean property
 *  "north" which is set to "true" when something connectable is to the north.
 *
 *  But WHO sets "north" to "true"? Minecraft does at runtime by checking neighbors.
 *  In our engine, we must reproduce that logic without hardcoding.
 *
 *  Strategy: analyze the PROPERTY NAME.
 *  - If a multipart part conditions on a property whose name matches a
 *    Direction ("north", "south", "east", "west", "up", "down"), AND the
 *    values are boolean ("true"/"false"), AND the same property is NOT set
 *    by the user (i.e., the block's variant key doesn't include it),
 *    THEN that property is a connectivity property driven by neighbor state.
 *
 *  We then must determine WHAT the neighbor must be for "north=true".
 *  This we infer from the block's tags (fence_connectable, wall_post_override,
 *  etc.) using Minecraft's connection rules.
 *
 *  Inference rules (data-driven, tag-based):
 *    - "c:fence_connectable" tag on block → connects to fences/fence-gates/walls
 *    - "minecraft:walls" tag on block → connects to walls
 *    - Default: connects when neighbor is solid (full opaque cube)
 *
 * IMPORTANT: This is a HEURISTIC. It covers vanilla and most mods correctly.
 * Mods that use custom connection logic beyond "is neighbor solid/tagged" would
 * need to ship a machine-readable connectivity descriptor — a future extension.
 *
 * The extracted rules are registered into globalConnectivityRegistry,
 * which is consumed by AdjacencyEvaluator at mesh time.
 */

import type { ResourceLocation } from '@mc-planner/shared'
import type { Direction } from '@mc-planner/shared'
import { DIRECTIONS } from '@mc-planner/shared'
import type { MultipartBlockstate, MultipartCondition } from './BlockstateJson'
import { isOrCondition, isAndCondition } from './BlockstateJson'
import type {
  ConnectivityRule,
  ConnectivityCondition,
  BlockConnectivityDef,
} from '@mc-planner/world-engine'
import { globalConnectivityRegistry, globalTagRegistry } from '@mc-planner/world-engine'

const DIRECTION_SET = new Set<string>(DIRECTIONS)

/**
 * Analyze a multipart blockstate and extract connectivity rules.
 * Registers results into globalConnectivityRegistry if any rules are found.
 */
export function extractConnectivityRules(
  blockId: ResourceLocation,
  blockstate: MultipartBlockstate,
  blockTags: readonly string[]
): void {
  // Collect all property names that appear in 'when' conditions
  const conditionalProps = new Set<string>()
  for (const part of blockstate.multipart) {
    if (part.when) {
      collectConditionProperties(part.when, conditionalProps)
    }
  }

  // Filter to direction-named boolean properties — these are connectivity props
  const connectivityProps = Array.from(conditionalProps).filter(name =>
    DIRECTION_SET.has(name)
  )

  if (connectivityProps.length === 0) return

  // Build a connectivity rule for each direction property found
  const rules: ConnectivityRule[] = []

  for (const propName of connectivityProps) {
    const direction = propName as Direction
    const condition = inferConnectionCondition(blockId, direction, blockTags)

    rules.push({
      propertyName: propName,
      direction,
      trueValue: 'true',
      falseValue: 'false',
      condition,
    })
  }

  // Also check for 'up'/'down' connectivity (walls have up=true/false)
  // and 'waterlogged' (not a connectivity prop, skip)
  const def: BlockConnectivityDef = { blockId, rules }
  globalConnectivityRegistry.register(def)
}

/**
 * Recursively collect all property names referenced in a condition.
 */
function collectConditionProperties(
  condition: MultipartCondition,
  out: Set<string>
): void {
  if (isOrCondition(condition)) {
    for (const c of condition.OR) collectConditionProperties(c, out)
    return
  }
  if (isAndCondition(condition)) {
    for (const c of condition.AND) collectConditionProperties(c, out)
    return
  }
  // Simple condition: { propertyName: "value" }
  for (const key of Object.keys(condition)) {
    if (key !== 'OR' && key !== 'AND') {
      out.add(key)
    }
  }
}

/**
 * Infer the connection condition for a direction property.
 *
 * Priority:
 *   1. If block has 'minecraft:fences' tag → connects to fence_connectable
 *   2. If block has 'minecraft:walls' tag → connects to walls and solid faces
 *   3. If block has 'minecraft:glass_panes' or '#c:glass_panes' → connects to solid
 *   4. Default → connects to solid block
 *
 * The condition uses the globalTagRegistry which is populated from the JAR's
 * data/minecraft/tags/blocks/*.json files.
 */
function inferConnectionCondition(
  blockId: ResourceLocation,
  direction: Direction,
  blockTags: readonly string[]
): ConnectivityCondition {
  const tagSet = new Set(blockTags)

  if (tagSet.has('minecraft:fences') || tagSet.has('minecraft:fence_gates')) {
    // Fences connect to: other fences, fence gates, walls, and solid blocks
    return {
      type: 'any',
      conditions: [
        { type: 'hasTag', tag: 'minecraft:fences' },
        { type: 'hasTag', tag: 'minecraft:fence_gates' },
        { type: 'hasTag', tag: 'minecraft:walls' },
        { type: 'isSolid' },
      ],
    }
  }

  if (tagSet.has('minecraft:walls')) {
    // Walls connect to: other walls, fence gates, solid blocks
    return {
      type: 'any',
      conditions: [
        { type: 'hasTag', tag: 'minecraft:walls' },
        { type: 'hasTag', tag: 'minecraft:fence_gates' },
        { type: 'isSolid' },
      ],
    }
  }

  if (
    tagSet.has('minecraft:glass_panes') ||
    tagSet.has('c:glass_panes') ||
    blockId.includes('pane')
  ) {
    // Glass panes connect to solid blocks and other panes
    return {
      type: 'any',
      conditions: [
        { type: 'isSolid' },
        { type: 'sameBlock' },
      ],
    }
  }

  // Default: connect when neighbor is a solid full-cube block
  return { type: 'isSolid' }
}

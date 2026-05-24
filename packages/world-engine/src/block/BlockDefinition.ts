/**
 * packages/world-engine/src/block/BlockDefinition.ts
 *
 * Runtime block definition — the engine's understanding of a block type.
 *
 * A BlockDefinition is derived entirely from the JAR's blockstates/ and
 * block_type tags. Nothing is hardcoded here. The BlockRegistry builds
 * these definitions by parsing the blockstate JSON for each registered block.
 *
 * Properties:
 *  Each block type declares its valid properties and their allowed values.
 *  e.g. minecraft:oak_stairs:
 *    facing: [north, south, east, west]
 *    half:   [top, bottom]
 *    shape:  [straight, inner_left, inner_right, outer_left, outer_right]
 *    waterlogged: [true, false]
 *
 * The total number of states = product of all property value counts.
 * stairs: 4 × 2 × 5 × 2 = 80 distinct states.
 *
 * Default state:
 *  Each block has one designated default state (the one Minecraft places
 *  when no properties are specified). Used by the UI for new placements.
 *
 * Rendering hints (data-driven, NOT hardcoded):
 *  These are inferred from the model/blockstate definitions:
 *  - isOpaque:       derived from model geometry (full 16×16×16 cube with no transparency)
 *  - isSolid:        inferred from voxel shape (full bounding box)
 *  - isTransparent:  inferred from texture has-alpha
 *  - emitsLight:     from tags/blocks/minecraft:light_emitting (future)
 *  - connectsTo:     inferred from multipart predicates (fences → other_fence)
 *
 * WHY infer rather than hardcode?
 *  Create mod adds blocks with custom connectivity (shafts, belts). If we
 *  hardcoded "fences connect to fences", Create shafts would need special
 *  casing. By inferring from multipart conditions, any block with neighbor-
 *  based multipart rules gets adjacency support automatically.
 */

import type { ResourceLocation } from '@mc-planner/shared'

export interface BlockPropertyDef {
  name: string
  values: readonly string[]
  /** Index of the default value in the values array */
  defaultIndex: number
}

export interface BlockDefinition {
  /** The block's resource location, e.g. 'minecraft:oak_stairs' */
  id: ResourceLocation

  /** Declared properties for this block type */
  properties: readonly BlockPropertyDef[]

  /** Default state property map (for new placements) */
  defaultProperties: Readonly<Record<string, string>>

  /**
   * Rendering classification — inferred from model data, not hardcoded.
   * Updated by the model baker when models are first baked.
   */
  renderType: BlockRenderType

  /**
   * Whether this block's blockstate uses multipart rules.
   * Multipart blocks have neighbor-dependent model selection.
   * Detected by the blockstate compiler when parsing blockstate JSON.
   */
  isMultipart: boolean

  /**
   * Property names that affect adjacency/connectivity.
   * Derived from multipart predicates by the blockstate compiler.
   * e.g. for fences: ['north', 'south', 'east', 'west']
   */
  connectivityProperties: readonly string[]

  /**
   * Whether this block has a block entity.
   * Detected from data/minecraft/tags/blocks/needs_block_entity (future).
   * For now, inferred from model using special texture names (e.g. 'entity')
   */
  hasBlockEntity: boolean
}

export type BlockRenderType =
  | 'solid'       // Full opaque cube, contributes to AO, hides neighbors
  | 'cutout'      // Transparent cutout (glass panes, leaves with FAST graphics)
  | 'translucent' // Semi-transparent, requires depth sorting (water, stained glass)
  | 'entity'      // Rendered as a separate entity (chests, signs, heads)
  | 'invisible'   // Air, barriers, structure void

/** A mutable builder used during registry construction */
export class BlockDefinitionBuilder {
  id: ResourceLocation
  properties: BlockPropertyDef[] = []
  defaultProperties: Record<string, string> = {}
  renderType: BlockRenderType = 'solid'
  isMultipart = false
  connectivityProperties: string[] = []
  hasBlockEntity = false

  constructor(id: ResourceLocation) {
    this.id = id
  }

  addProperty(name: string, values: string[], defaultValue: string): this {
    const defaultIndex = values.indexOf(defaultValue)
    this.properties.push({
      name,
      values,
      defaultIndex: defaultIndex === -1 ? 0 : defaultIndex,
    })
    this.defaultProperties[name] = values[defaultIndex === -1 ? 0 : defaultIndex]!
    return this
  }

  build(): BlockDefinition {
    return {
      id: this.id,
      properties: this.properties,
      defaultProperties: { ...this.defaultProperties },
      renderType: this.renderType,
      isMultipart: this.isMultipart,
      connectivityProperties: this.connectivityProperties,
      hasBlockEntity: this.hasBlockEntity,
    }
  }
}

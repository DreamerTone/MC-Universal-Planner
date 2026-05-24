/**
 * packages/shared/src/types/minecraft.ts
 *
 * Core Minecraft data model types used across ALL packages.
 *
 * These types mirror the Minecraft data model as closely as possible
 * so that engine code maps 1:1 to the game's own data structures.
 * This makes debugging easier and reduces translation friction.
 *
 * All resource locations follow the 'namespace:path' format.
 * BlockPos uses integer XYZ. Floating-point positions use Vec3.
 */

// ── Resource Location ──────────────────────────────────────────────────────

/**
 * A Minecraft resource location string, e.g. 'minecraft:stone' or 'create:shaft'
 * Branded type to prevent mixing arbitrary strings with resource locations.
 */
export type ResourceLocation = string & { readonly __brand: 'ResourceLocation' }

export function makeResourceLocation(namespace: string, path: string): ResourceLocation {
  return `${namespace}:${path}` as ResourceLocation
}

export function parseResourceLocation(loc: string): { namespace: string; path: string } {
  const idx = loc.indexOf(':')
  if (idx === -1) return { namespace: 'minecraft', path: loc }
  return { namespace: loc.slice(0, idx), path: loc.slice(idx + 1) }
}

// ── Block Position ─────────────────────────────────────────────────────────

export interface BlockPos {
  x: number
  y: number
  z: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Vec2 {
  x: number
  y: number
}

// Packed integer representation of a block position.
// Allows using BlockPos as a Map key without JSON serialization overhead.
// Supports positions in range [-8192, 8191] per axis (14 bits each).
export type PackedBlockPos = number & { readonly __brand: 'PackedBlockPos' }

export function packBlockPos(x: number, y: number, z: number): PackedBlockPos {
  return (((x + 8192) & 0x3FFF) | (((y + 8192) & 0x3FFF) << 14) | (((z + 8192) & 0x3FFF) << 28)) as PackedBlockPos
}

export function unpackBlockPos(packed: PackedBlockPos): BlockPos {
  return {
    x: (packed & 0x3FFF) - 8192,
    y: ((packed >> 14) & 0x3FFF) - 8192,
    z: ((packed >> 28) & 0x3FFF) - 8192,
  }
}

// ── Direction ──────────────────────────────────────────────────────────────

export type Direction = 'north' | 'south' | 'east' | 'west' | 'up' | 'down'

export const DIRECTIONS: Direction[] = ['north', 'south', 'east', 'west', 'up', 'down']

export const DIRECTION_VECTORS: Record<Direction, BlockPos> = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
}

export const OPPOSITE_DIRECTION: Record<Direction, Direction> = {
  north: 'south', south: 'north',
  east: 'west', west: 'east',
  up: 'down', down: 'up',
}

// ── Block State ────────────────────────────────────────────────────────────

/**
 * A block state is an identifier + a map of property key/value pairs.
 * e.g. { id: 'minecraft:oak_stairs', properties: { facing: 'north', half: 'bottom', shape: 'straight' } }
 *
 * Property values are always strings in Minecraft's data model.
 * Numeric/boolean properties are stored as '0', '1', 'true', 'false'.
 */
export interface BlockState {
  id: ResourceLocation
  properties: Record<string, string>
}

export const AIR_BLOCK_STATE: BlockState = {
  id: 'minecraft:air' as ResourceLocation,
  properties: {},
}

// ── Chunk ──────────────────────────────────────────────────────────────────

/** Chunk coordinates (block coords / 16, floor) */
export interface ChunkPos {
  cx: number
  cz: number
}

export const CHUNK_SIZE = 16
export const CHUNK_HEIGHT = 384      // 1.18+ world height
export const CHUNK_MIN_Y = -64       // 1.18+ minimum build height
export const SECTION_HEIGHT = 16     // Chunk sections are 16 blocks tall
export const SECTIONS_PER_CHUNK = CHUNK_HEIGHT / SECTION_HEIGHT // = 24

export function blockToChunkPos(x: number, z: number): ChunkPos {
  return {
    cx: Math.floor(x / CHUNK_SIZE),
    cz: Math.floor(z / CHUNK_SIZE),
  }
}

// ── Rotation / Transform ───────────────────────────────────────────────────

export interface BlockRotation {
  x: number // 0, 90, 180, 270
  y: number // 0, 90, 180, 270
}

// ── Tint Index ─────────────────────────────────────────────────────────────

/**
 * Tint indices match Minecraft's tinting system:
 *  -1 = no tint
 *   0 = grass tint (biome-colored)
 *   1 = foliage tint (biome-colored)
 *   2 = water tint (biome-colored)
 */
export type TintIndex = -1 | 0 | 1 | 2

// ── NBT ────────────────────────────────────────────────────────────────────

/**
 * Minimal NBT representation sufficient for block entity data.
 * Full NBT parsing is handled by packages/serialization.
 */
export type NbtTag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'string'; value: string }
  | { type: 'list'; value: NbtTag[] }
  | { type: 'compound'; value: Record<string, NbtTag> }
  | { type: 'intArray'; value: Int32Array }
  | { type: 'longArray'; value: BigInt64Array }
  | { type: 'byteArray'; value: Uint8Array }

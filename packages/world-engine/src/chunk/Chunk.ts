/**
 * packages/world-engine/src/chunk/Chunk.ts
 *
 * A single 16×384×16 chunk column.
 *
 * A chunk consists of 24 sections stacked vertically:
 *   Section 0  → Y: -64 to -49   (bottom of world)
 *   Section 1  → Y: -48 to -33
 *   ...
 *   Section 23 → Y: 304 to 319   (top of build limit)
 *
 * Sections are lazily allocated: a section that is all-air is not allocated
 * at all (undefined in the sections array). Iterating sections skips undefined
 * entries, so the mesher only touches non-empty sections.
 *
 * Dirty tracking:
 * Each section maintains a dirty flag. When a block is set, the section and
 * its Y-neighbors are marked dirty (neighbor sections need re-meshing because
 * face culling depends on adjacent blocks across section boundaries).
 *
 * The ChunkStorage collects dirty chunk/section positions and feeds them to
 * the mesh worker queue.
 *
 * Block Entity data:
 * Block entities (chests, furnaces, Create machines) are stored in a
 * Map<sectionIndex, NbtCompound> separate from voxel data. The simulation
 * engine accesses this map when processing machine ticks.
 */

import {
  CHUNK_SIZE,
  CHUNK_HEIGHT,
  CHUNK_MIN_Y,
  SECTION_HEIGHT,
  SECTIONS_PER_CHUNK,
  type ChunkPos,
  type BlockPos,
  type NbtTag,
} from '@mc-planner/shared'
import { ChunkSection, sectionIndex, type SerializedSection } from './ChunkSection'
import { type BlockStateId, AIR_BLOCKSTATE_ID } from './BlockStateId'

export type SectionIndex = number  // 0..23
export type DirtyCallback = (chunkPos: ChunkPos, sectionY: SectionIndex) => void

/**
 * Convert a world Y coordinate to a (sectionIndex, localY) pair.
 * Returns null if Y is outside the valid world range.
 */
function worldYToSection(worldY: number): { section: SectionIndex; localY: number } | null {
  const adjusted = worldY - CHUNK_MIN_Y
  if (adjusted < 0 || adjusted >= CHUNK_HEIGHT) return null
  return {
    section: Math.floor(adjusted / SECTION_HEIGHT) as SectionIndex,
    localY: adjusted % SECTION_HEIGHT,
  }
}

export class Chunk {
  readonly pos: ChunkPos

  /**
   * 24 sections (0..23). undefined = all-air, not allocated.
   * Lazy allocation avoids wasting memory on empty sections.
   */
  private readonly sections: (ChunkSection | undefined)[]

  /** Block entity NBT data keyed by packed local position */
  private readonly blockEntities = new Map<number, Record<string, NbtTag>>()

  /**
   * Per-section dirty flags.
   * Bit N set → section N needs re-meshing.
   * Using a single u32 covers all 24 sections (bits 0-23).
   */
  private dirtyBits = 0xFFFFFF // all dirty on creation (new chunks need initial mesh)

  /** Callback invoked when a section becomes dirty */
  private onDirty?: DirtyCallback

  constructor(pos: ChunkPos, onDirty?: DirtyCallback) {
    this.pos = pos
    this.sections = new Array(SECTIONS_PER_CHUNK).fill(undefined)
    if (onDirty) this.onDirty = onDirty
  }

  // ── Block Access ───────────────────────────────────────────────────────────

  /**
   * Get the blockstate ID at a world position.
   * Positions outside this chunk return AIR.
   */
  getBlock(worldX: number, worldY: number, worldZ: number): BlockStateId {
    const loc = worldYToSection(worldY)
    if (!loc) return AIR_BLOCKSTATE_ID

    const section = this.sections[loc.section]
    if (!section) return AIR_BLOCKSTATE_ID // unallocated = all air

    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    return section.getBlockState(sectionIndex(lx, loc.localY, lz))
  }

  /** Get block using already-local coordinates [0..15] for each axis */
  getBlockLocal(lx: number, ly: number, lz: number, sectionY: SectionIndex): BlockStateId {
    const section = this.sections[sectionY]
    if (!section) return AIR_BLOCKSTATE_ID
    return section.getBlockState(sectionIndex(lx, ly, lz))
  }

  /**
   * Set the blockstate ID at a world position.
   * Creates the section if it doesn't exist.
   * Marks the section (and Y-neighbors) dirty for re-meshing.
   */
  setBlock(worldX: number, worldY: number, worldZ: number, stateId: BlockStateId): void {
    const loc = worldYToSection(worldY)
    if (!loc) return

    let section = this.sections[loc.section]
    if (!section) {
      if (stateId === AIR_BLOCKSTATE_ID) return // setting air in unallocated = no-op
      section = new ChunkSection()
      this.sections[loc.section] = section
    }

    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    section.setBlockState(sectionIndex(lx, loc.localY, lz), stateId)

    // Deallocate if section becomes empty (all air)
    if (section.isEmpty) {
      this.sections[loc.section] = undefined
    }

    // Mark this section dirty, plus adjacent sections (face culling needs neighbors)
    this.markSectionDirty(loc.section)
    if (loc.localY === 0 && loc.section > 0) {
      this.markSectionDirty((loc.section - 1) as SectionIndex)
    }
    if (loc.localY === SECTION_HEIGHT - 1 && loc.section < SECTIONS_PER_CHUNK - 1) {
      this.markSectionDirty((loc.section + 1) as SectionIndex)
    }
  }

  // ── Block Entities ─────────────────────────────────────────────────────────

  setBlockEntity(lx: number, ly: number, lz: number, sectionY: SectionIndex, data: Record<string, NbtTag>): void {
    const key = (sectionY << 12) | sectionIndex(lx, ly, lz)
    this.blockEntities.set(key, data)
  }

  getBlockEntity(lx: number, ly: number, lz: number, sectionY: SectionIndex): Record<string, NbtTag> | null {
    const key = (sectionY << 12) | sectionIndex(lx, ly, lz)
    return this.blockEntities.get(key) ?? null
  }

  removeBlockEntity(lx: number, ly: number, lz: number, sectionY: SectionIndex): void {
    const key = (sectionY << 12) | sectionIndex(lx, ly, lz)
    this.blockEntities.delete(key)
  }

  // ── Dirty Tracking ─────────────────────────────────────────────────────────

  private markSectionDirty(sectionY: SectionIndex): void {
    const bit = 1 << sectionY
    if (!(this.dirtyBits & bit)) {
      this.dirtyBits |= bit
      this.onDirty?.(this.pos, sectionY)
    }
  }

  clearSectionDirty(sectionY: SectionIndex): void {
    this.dirtyBits &= ~(1 << sectionY)
  }

  isSectionDirty(sectionY: SectionIndex): boolean {
    return (this.dirtyBits & (1 << sectionY)) !== 0
  }

  get hasDirtySections(): boolean {
    return this.dirtyBits !== 0
  }

  /** Returns section indices of all dirty sections */
  *dirtySections(): IterableIterator<SectionIndex> {
    let bits = this.dirtyBits
    let idx = 0
    while (bits !== 0) {
      if (bits & 1) yield idx as SectionIndex
      bits >>>= 1
      idx++
    }
  }

  // ── Section Iteration ──────────────────────────────────────────────────────

  /** Iterate non-empty sections as [sectionY, ChunkSection] pairs */
  *nonEmptySections(): IterableIterator<[SectionIndex, ChunkSection]> {
    for (let i = 0; i < SECTIONS_PER_CHUNK; i++) {
      const section = this.sections[i]
      if (section) yield [i as SectionIndex, section]
    }
  }

  getSection(sectionY: SectionIndex): ChunkSection | undefined {
    return this.sections[sectionY]
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  serialize(): SerializedChunk {
    const sections: (SerializedSection | null)[] = new Array(SECTIONS_PER_CHUNK).fill(null)
    for (let i = 0; i < SECTIONS_PER_CHUNK; i++) {
      sections[i] = this.sections[i]?.serialize() ?? null
    }
    return {
      cx: this.pos.cx,
      cz: this.pos.cz,
      sections,
      blockEntities: Array.from(this.blockEntities.entries()).map(([k, v]) => ({ key: k, data: v })),
    }
  }

  static deserialize(data: SerializedChunk, onDirty?: DirtyCallback): Chunk {
    const chunk = new Chunk({ cx: data.cx, cz: data.cz }, onDirty)
    for (let i = 0; i < SECTIONS_PER_CHUNK; i++) {
      const s = data.sections[i]
      if (s) chunk.sections[i] = ChunkSection.deserialize(s)
    }
    for (const { key, data: nbt } of data.blockEntities) {
      chunk.blockEntities.set(key, nbt)
    }
    chunk.dirtyBits = 0xFFFFFF // mark all dirty after deserialization
    return chunk
  }
}

export interface SerializedChunk {
  cx: number
  cz: number
  sections: (SerializedSection | null)[]
  blockEntities: { key: number; data: Record<string, NbtTag> }[]
}

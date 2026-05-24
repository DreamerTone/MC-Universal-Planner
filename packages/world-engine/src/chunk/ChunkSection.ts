/**
 * packages/world-engine/src/chunk/ChunkSection.ts
 *
 * A single 16×16×16 chunk section — the fundamental storage unit.
 *
 * WHY palette compression?
 * A naive section storing one u16 blockstate ID per voxel costs:
 *   16³ × 2 bytes = 8,192 bytes per section
 * For a 24-section chunk, that's 196 KB, times hundreds of loaded chunks.
 *
 * Minecraft uses indirect palette encoding: instead of storing a global
 * blockstate ID per voxel, it stores a small local "palette index" whose
 * bit-width depends on how many distinct block types the section contains.
 *
 * Storage layout:
 *   palette:   Array of global blockstate IDs (max 16 unique states per section
 *              before upgrading bit width)
 *   storage:   Packed Uint32Array, ceil(4096 * bitsPerEntry / 32) elements
 *
 * Bit widths:
 *   0 blocks  → uniform section (all air) — palette = [0], no storage
 *   1-4 dist  → 4 bits per entry = 512 bytes
 *   5-8 dist  → 4 bits (still, min 4)
 *   9-16 dist → 4 bits
 *   17-256    → ceil(log2(N)) bits per entry
 *   >4096     → direct (15 bits, global state IDs)
 *
 * This matches Minecraft's 1.16+ bit-packing scheme (no cross-long packing).
 * Entries do NOT span Uint32 word boundaries, matching vanilla behavior.
 * This wastes some bits but keeps per-voxel reads branchless.
 *
 * The section is read/write from any thread (Transferable via SharedArrayBuffer
 * in the future; currently copied across worker boundaries).
 */

import type { BlockStateId } from './BlockStateId'

export const SECTION_SIZE = 16
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE // 4096
const MIN_BITS = 4
const MAX_PALETTE_BITS = 8   // above this, use direct global IDs (15-bit)
const DIRECT_BITS = 15

/**
 * Compute a flat index into the section storage.
 * Ordering: Y major → Z minor → X inner (matches Minecraft chunk data protocol).
 */
export function sectionIndex(lx: number, ly: number, lz: number): number {
  // lx, ly, lz are in [0, 15]
  return (ly << 8) | (lz << 4) | lx
}

export class ChunkSection {
  /** Palette maps local palette index → global blockstate ID */
  private palette: BlockStateId[]
  /** packed storage: ceil(SECTION_VOLUME * bitsPerEntry / 32) Uint32s */
  private storage: Uint32Array
  /** Current bits per palette entry */
  private bitsPerEntry: number
  /** Mask for one entry in the packed storage */
  private entryMask: number
  /** How many entries fit in one Uint32 word */
  private entriesPerWord: number

  /** Count of non-air blocks — used to quickly check if section is empty */
  private nonAirCount = 0

  constructor() {
    // Start as a uniform air section: palette = [0 (air)], 0-bit storage
    this.palette = [0 as BlockStateId]
    this.bitsPerEntry = 0
    this.entryMask = 0
    this.entriesPerWord = 0
    this.storage = new Uint32Array(0)
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  getBlockState(index: number): BlockStateId {
    if (this.bitsPerEntry === 0) {
      // Uniform section: all blocks are palette[0]
      return this.palette[0]!
    }
    if (this.bitsPerEntry === DIRECT_BITS) {
      // Direct storage: index is global blockstate ID, no palette lookup
      const wordIdx = Math.floor(index * DIRECT_BITS / 32)
      const bitIdx = (index * DIRECT_BITS) % 32
      const word = this.storage[wordIdx]!
      const next = this.storage[wordIdx + 1] ?? 0
      // Handle cross-word reads (DIRECT_BITS=15 can straddle 32-bit boundary)
      const raw = ((word >>> bitIdx) | (next << (32 - bitIdx))) & 0x7FFF
      return raw as BlockStateId
    }

    // Indirect palette storage (no cross-word spans)
    const wordIdx = Math.floor(index / this.entriesPerWord)
    const bitIdx = (index % this.entriesPerWord) * this.bitsPerEntry
    const paletteIdx = (this.storage[wordIdx]! >>> bitIdx) & this.entryMask
    return this.palette[paletteIdx]!
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  setBlockState(index: number, stateId: BlockStateId): void {
    const old = this.getBlockState(index)
    if (old === stateId) return

    // Track non-air count for fast empty-check
    if (old === 0 && stateId !== 0) this.nonAirCount++
    else if (old !== 0 && stateId === 0) this.nonAirCount--

    if (this.bitsPerEntry === 0) {
      // Uniform section — need to upgrade to packed storage
      if (stateId === this.palette[0]) return // still uniform
      this.upgradeToPacked(MIN_BITS)
    }

    if (this.bitsPerEntry === DIRECT_BITS) {
      // Direct storage write
      const wordIdx = Math.floor(index * DIRECT_BITS / 32)
      const bitIdx = (index * DIRECT_BITS) % 32
      const mask = 0x7FFF
      this.storage[wordIdx] = (this.storage[wordIdx]! & ~(mask << bitIdx)) |
        ((stateId & mask) << bitIdx)
      // Handle straddle
      const overflow = bitIdx + DIRECT_BITS - 32
      if (overflow > 0) {
        const overflowMask = (1 << overflow) - 1
        this.storage[wordIdx + 1] =
          (this.storage[wordIdx + 1]! & ~overflowMask) |
          ((stateId >>> (DIRECT_BITS - overflow)) & overflowMask)
      }
      return
    }

    // Indirect palette
    let paletteIdx = this.palette.indexOf(stateId)
    if (paletteIdx === -1) {
      // Add to palette, upgrading bit width if needed
      const maxPaletteSize = 1 << this.bitsPerEntry
      if (this.palette.length >= maxPaletteSize) {
        const newBits = this.bitsPerEntry + 1
        if (newBits > MAX_PALETTE_BITS) {
          this.upgradeToDirect()
          this.setBlockState(index, stateId) // recurse with direct storage
          return
        }
        this.repack(newBits)
      }
      paletteIdx = this.palette.length
      this.palette.push(stateId)
    }

    const wordIdx = Math.floor(index / this.entriesPerWord)
    const bitIdx = (index % this.entriesPerWord) * this.bitsPerEntry
    this.storage[wordIdx] =
      (this.storage[wordIdx]! & ~(this.entryMask << bitIdx)) |
      ((paletteIdx & this.entryMask) << bitIdx)
  }

  // ── Fast accessors ────────────────────────────────────────────────────────

  /** True if the section contains only air (avoids meshing empty sections) */
  get isEmpty(): boolean {
    return this.nonAirCount === 0
  }

  /** Count of non-air blocks (used for mesh LOD decisions) */
  get solidCount(): number {
    return this.nonAirCount
  }

  // ── Upgrade helpers ───────────────────────────────────────────────────────

  private upgradeToPacked(bits: number): void {
    this.bitsPerEntry = bits
    this.entryMask = (1 << bits) - 1
    this.entriesPerWord = Math.floor(32 / bits)
    const wordCount = Math.ceil(SECTION_VOLUME / this.entriesPerWord)
    this.storage = new Uint32Array(wordCount)
    // All voxels still point to palette[0] (index 0 → all zeros in storage)
  }

  private repack(newBits: number): void {
    const oldBits = this.bitsPerEntry
    const oldEntriesPerWord = Math.floor(32 / oldBits)
    const oldStorage = this.storage

    this.bitsPerEntry = newBits
    this.entryMask = (1 << newBits) - 1
    this.entriesPerWord = Math.floor(32 / newBits)
    const wordCount = Math.ceil(SECTION_VOLUME / this.entriesPerWord)
    this.storage = new Uint32Array(wordCount)

    // Re-write all existing palette indices with new bit width
    for (let i = 0; i < SECTION_VOLUME; i++) {
      const oldWordIdx = Math.floor(i / oldEntriesPerWord)
      const oldBitIdx = (i % oldEntriesPerWord) * oldBits
      const oldMask = (1 << oldBits) - 1
      const paletteIdx = (oldStorage[oldWordIdx]! >>> oldBitIdx) & oldMask

      const wordIdx = Math.floor(i / this.entriesPerWord)
      const bitIdx = (i % this.entriesPerWord) * newBits
      this.storage[wordIdx] =
        (this.storage[wordIdx]! & ~(this.entryMask << bitIdx)) |
        ((paletteIdx & this.entryMask) << bitIdx)
    }
  }

  private upgradeToDirect(): void {
    // Read all current states (via palette lookup)
    const states = new Uint16Array(SECTION_VOLUME)
    for (let i = 0; i < SECTION_VOLUME; i++) {
      states[i] = this.getBlockState(i)
    }

    this.bitsPerEntry = DIRECT_BITS
    this.palette = [] // not used in direct mode
    const wordCount = Math.ceil(SECTION_VOLUME * DIRECT_BITS / 32)
    this.storage = new Uint32Array(wordCount)

    // Write all states back
    for (let i = 0; i < SECTION_VOLUME; i++) {
      this.setBlockState(i, states[i]! as BlockStateId)
    }
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /** Serialize to a compact format for worker transfer or project save */
  serialize(): SerializedSection {
    return {
      bitsPerEntry: this.bitsPerEntry,
      palette: this.bitsPerEntry === DIRECT_BITS ? [] : [...this.palette],
      storage: this.storage.slice(),
      nonAirCount: this.nonAirCount,
    }
  }

  static deserialize(data: SerializedSection): ChunkSection {
    const section = new ChunkSection()
    section.bitsPerEntry = data.bitsPerEntry
    section.palette = [...data.palette] as BlockStateId[]
    section.entryMask = data.bitsPerEntry > 0 ? (1 << data.bitsPerEntry) - 1 : 0
    section.entriesPerWord = data.bitsPerEntry > 0 ? Math.floor(32 / data.bitsPerEntry) : 0
    section.storage = data.storage.slice()
    section.nonAirCount = data.nonAirCount
    return section
  }
}

export interface SerializedSection {
  bitsPerEntry: number
  palette: number[]
  storage: Uint32Array
  nonAirCount: number
}

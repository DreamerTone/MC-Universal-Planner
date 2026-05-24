/**
 * packages/shared/src/index.ts
 *
 * Public API surface of @mc-planner/shared.
 * Every other package imports shared types from here.
 *
 * Keep exports organized by domain so tree-shaking works correctly
 * and imports in consuming packages are self-documenting.
 */

// IPC types (Electron main ↔ renderer bridge)
export type {
  AppInfoResult,
  OpenDialogResult,
  AppDirResult,
  LoadJarRequest,
  LoadJarResult,
  AssetIndex,
  AssetIndexEntry,
  AssetLoadProgress,
  ProjectMetadata,
  ModReference,
  SaveProjectRequest,
  LoadProjectResult,
} from './types/ipc'

// Typed window.electronAPI shape
export type { ElectronAPI } from './types/ElectronAPI'

// Minecraft data model types
export type {
  ResourceLocation,
  BlockPos,
  Vec3,
  Vec2,
  PackedBlockPos,
  Direction,
  BlockState,
  ChunkPos,
  BlockRotation,
  TintIndex,
  NbtTag,
} from './types/minecraft'

// Minecraft type utilities and constants
export {
  makeResourceLocation,
  parseResourceLocation,
  packBlockPos,
  unpackBlockPos,
  DIRECTIONS,
  DIRECTION_VECTORS,
  OPPOSITE_DIRECTION,
  AIR_BLOCK_STATE,
  CHUNK_SIZE,
  CHUNK_HEIGHT,
  CHUNK_MIN_Y,
  SECTION_HEIGHT,
  SECTIONS_PER_CHUNK,
  blockToChunkPos,
} from './types/minecraft'

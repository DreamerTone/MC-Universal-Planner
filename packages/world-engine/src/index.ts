/**
 * packages/world-engine/src/index.ts
 *
 * Public API for @mc-planner/world-engine.
 *
 * External consumers (renderer-core, simulation-engine, apps/desktop)
 * import from this file. Internal cross-module imports use relative paths.
 */

// ── Top-level World ────────────────────────────────────────────────────────
export { World } from './world/World'
export { MeshDirtyQueue } from './world/MeshDirtyQueue'
export type { BlockChange, ChangeSet } from './world/World'
export type { MeshJob } from './world/MeshDirtyQueue'

// ── Chunk System ───────────────────────────────────────────────────────────
export { ChunkStorage } from './chunk/ChunkStorage'
export type { DirtyEntry } from './chunk/ChunkStorage'
export { Chunk } from './chunk/Chunk'
export type { SectionIndex, SerializedChunk } from './chunk/Chunk'
export { ChunkSection, sectionIndex, SECTION_SIZE, SECTION_VOLUME } from './chunk/ChunkSection'
export type { SerializedSection } from './chunk/ChunkSection'
export {
  globalBlockStateRegistry,
  BlockStateIdRegistry,
  AIR_BLOCKSTATE_ID,
} from './chunk/BlockStateId'
export type { BlockStateId, BlockStateRegistrySnapshot } from './chunk/BlockStateId'

// ── Block System ───────────────────────────────────────────────────────────
export { globalBlockRegistry, BlockRegistry } from './block/BlockRegistry'
export { BlockDefinitionBuilder } from './block/BlockDefinition'
export type {
  BlockDefinition,
  BlockPropertyDef,
  BlockRenderType,
} from './block/BlockDefinition'

// ── Voxel Shapes ───────────────────────────────────────────────────────────
export {
  VoxelShape,
  VoxelShapeRegistry,
  globalVoxelShapeRegistry,
  fromModelSpace,
  FULL_CUBE,
  FULL_CUBE_SHAPE,
} from './voxel/VoxelShape'
export type { AABB } from './voxel/VoxelShape'

// ── Adjacency System ───────────────────────────────────────────────────────
export {
  AdjacencyEvaluator,
  ConnectivityRegistry,
  globalConnectivityRegistry,
  globalTagRegistry,
} from './adjacency/AdjacencyEvaluator'
export type {
  ConnectivityRule,
  ConnectivityCondition,
  BlockConnectivityDef,
} from './adjacency/AdjacencyEvaluator'

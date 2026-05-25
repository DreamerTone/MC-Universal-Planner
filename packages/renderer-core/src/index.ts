/**
 * packages/renderer-core/src/index.ts — public API
 */

// Core
export { RendererCore } from './RendererCore'
export type { RendererOptions } from './RendererCore'
export { WorldRenderer } from './WorldRenderer'
export type { ChunkMeshData } from './WorldRenderer'

// Meshing pipeline types (worker protocol surface)
export type {
  MeshingRequest, MeshingResult,
  RenderBuffers, ChunkSectionData, NeighborChunkData,
  UncompressedQuad, MeshSampleQuad,
} from './types/meshing'

// Pipeline
export { PipelineOrchestrator } from './PipelineOrchestrator'
export type { PipelineProgress } from './PipelineOrchestrator'

// Blockstate
export {
  BlockstateCompiler, compileBlockstatesAsync, globalBlockstateRegistry,
  BlockstateLoader, globalBlockstateLoader,
  evaluateBlockstate, isVariantsBlockstate, isMultipartBlockstate,
  parseVariantKey, serializeVariantKey,
} from './blockstate/index'
export type {
  CompiledBlockstate, CompiledModelRef, BlockstateEvalResult, CompiledCondition,
} from './blockstate/index'

// Model resolution
export { ModelResolver } from './model/index'
export type { ResolvedModel, ResolvedElement, ResolvedFace } from './model/index'

// Atlas
export { AtlasBuilder, AtlasSpriteRegistry, globalAtlasBuilder } from './atlas/index'
export { AtlasAnimator, globalAtlasAnimator, parseAnimationMeta } from './atlas/index'
export { packRects } from './atlas/index'
export { modelUVToAtlas } from './atlas/index'
export type { AtlasResult, AtlasBuildProgress, AtlasSprite, AnimationMeta } from './atlas/index'

// Baking
export { ModelBaker, BakedModelRegistry } from './baking/index'
export { applyBlockstateRotation } from './baking/index'
export {
  makeBakedQuad, faceNameToDir,
  FACE_DIR_NORTH, FACE_DIR_SOUTH, FACE_DIR_EAST,
  FACE_DIR_WEST, FACE_DIR_UP, FACE_DIR_DOWN,
  FACE_NORMALS,
} from './baking/index'
export type { BakedModel, BakedQuad, FaceDir } from './baking/index'

// Shaders
export { createBlockShaderMaterial, createTranslucentBlockShaderMaterial } from './shaders/index'
export type { BlockShaderUniforms } from './shaders/index'

// Camera
export { OrbitCameraController } from './camera/OrbitCameraController'
export type { OrbitCameraOptions } from './camera/OrbitCameraController'

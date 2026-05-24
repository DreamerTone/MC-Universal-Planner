/**
 * packages/renderer-core/src/blockstate/index.ts
 * Public API for the blockstate subsystem.
 */

export { BlockstateCompiler, compileBlockstatesAsync, globalBlockstateRegistry } from './BlockstateCompiler'
export { BlockstateLoader, globalBlockstateLoader } from './BlockstateLoader'
export { evaluateBlockstate, evaluateCondition, selectWeightedModel } from './CompiledBlockstate'
export type {
  CompiledBlockstate,
  CompiledVariantsBlockstate,
  CompiledMultipartBlockstate,
  CompiledMultipartPart,
  CompiledCondition,
  CompiledModelRef,
  WeightedModelSet,
  BlockstateEvalResult,
} from './CompiledBlockstate'
export type { BlockstateJson, ModelApply, VariantValue, MultipartPart } from './BlockstateJson'
export { isVariantsBlockstate, isMultipartBlockstate, parseVariantKey, serializeVariantKey } from './BlockstateJson'
export { extractConnectivityRules } from './ConnectivityExtractor'

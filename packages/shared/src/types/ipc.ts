/**
 * packages/shared/src/types/ipc.ts
 *
 * All request/response types for IPC channels.
 * Kept flat and serialization-friendly (no class instances, no functions).
 * All data crossing IPC must survive JSON.stringify/parse round-trips.
 */

// ── System ─────────────────────────────────────────────────────────────────

export interface AppInfoResult {
  version: string
  platform: NodeJS.Platform
  arch: string
  electronVersion: string
  nodeVersion: string
  isDev: boolean
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface AppDirResult {
  path: string
}

// ── Asset Pipeline ─────────────────────────────────────────────────────────

export interface LoadJarRequest {
  /** Absolute paths to one or more JAR files */
  jarPaths: string[]
  /** Whether to force cache invalidation and re-extract */
  forceRefresh?: boolean
}

export interface LoadJarResult {
  success: boolean
  error?: string | null
  assetIndex: AssetIndex | null
}

export interface AssetIndex {
  /** Namespaces found across all loaded JARs (e.g. ['minecraft', 'create']) */
  namespaces: string[]
  /** Total counts for progress display */
  blockstateCount: number
  modelCount: number
  textureCount: number
  /** Flat list of all known resource locations */
  entries: AssetIndexEntry[]
  /** Map from JAR path → content hash (SHA-256) for cache keying */
  jarHashes: Record<string, string>
}

export interface AssetIndexEntry {
  /** Fully qualified resource location, e.g. 'minecraft:block/stone' */
  resourceLocation: string
  type: 'blockstate' | 'model' | 'texture' | 'sound' | 'lang' | 'tag' | 'recipe' | 'other'
  /** Source JAR file path */
  jarPath: string
  /** Byte size of the raw asset */
  size: number
}

export interface AssetLoadProgress {
  phase: 'hashing' | 'extracting' | 'indexing' | 'complete'
  current: number
  total: number
  currentFile?: string
}

// ── Project ────────────────────────────────────────────────────────────────

export interface ProjectMetadata {
  name: string
  /** Semver of the project file format */
  version: string
  /** Minecraft version string, e.g. '1.20.1' */
  mcVersion: string
  /** List of mod IDs/versions required for this project */
  mods: ModReference[]
  createdAt: number
  lastModified?: number
  filePath?: string
}

export interface ModReference {
  modId: string
  version: string
  jarPath?: string
}

export interface SaveProjectRequest {
  filePath: string
  /** Serialized project data as ArrayBuffer */
  data: ArrayBuffer
}

export interface LoadProjectResult {
  success: boolean
  error: string | null
  data: ArrayBuffer | null
}

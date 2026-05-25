import type { FaceDir } from '../baking/BakedQuad'

export type RenderProfileKind =
  | 'empty'
  | 'simple_cube'
  | 'axis_cube'
  | 'static_model'
  | 'multipart_model'
  | 'unsupported'

export interface CubeFaceProfile {
  face: FaceDir
  u0: number
  v0: number
  u1: number
  v1: number
  tintIndex: number
  shade: boolean
}

export interface SimpleCubeProfile {
  kind: 'simple_cube'
  opaque: boolean
  faces: Record<FaceDir, CubeFaceProfile>
}

export interface StaticModelProfile {
  kind: 'static_model'
  opaque: boolean
  reason: string
}

export interface MultipartModelProfile {
  kind: 'multipart_model'
  opaque: boolean
  reason: string
}

export interface EmptyProfile {
  kind: 'empty'
  opaque: false
}

export interface UnsupportedProfile {
  kind: 'unsupported'
  opaque: false
  reason: string
}

export type RenderProfile =
  | EmptyProfile
  | SimpleCubeProfile
  | StaticModelProfile
  | MultipartModelProfile
  | UnsupportedProfile

export const EMPTY_RENDER_PROFILE: EmptyProfile = { kind: 'empty', opaque: false }

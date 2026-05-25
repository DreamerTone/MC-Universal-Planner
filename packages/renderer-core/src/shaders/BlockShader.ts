/**
 * packages/renderer-core/src/shaders/BlockShader.ts
 *
 * Custom Three.js ShaderMaterial for rendering block geometry.
 *
 * WHY a custom shader instead of Three.js built-in materials?
 *  MeshStandardMaterial and MeshLambertMaterial are general-purpose PBR shaders
 *  designed for arbitrary 3D models. Block rendering needs:
 *   - Single texture atlas (one sampler2D for ALL blocks)
 *   - Per-vertex AO (ambient occlusion baked into vertex buffer)
 *   - Per-quad tint (biome grass/foliage/water color) via vertex attribute
 *   - Animated texture UV offset (lava, water, fire) via uniform buffer
 *   - Emissive support (beacons, glowstone, sea lanterns) without PBR cost
 *   - No metalness/roughness maps (Minecraft is flat-shaded)
 *
 * Vertex attributes:
 *  position  (vec3)  — section-local vertex position
 *  normal    (vec3)  — block face normal in section/world axes
 *  uv        (vec2)  — atlas UV coordinates
 *  ao        (float) — ambient occlusion factor [0..1], 1=fully lit
 *  tintColor (vec3)  — biome tint color, (1,1,1) for no tint
 *  flags     (float) — packed flags: emissive bit, animated bit
 *
 * Uniforms:
 *  uAtlas           (sampler2D) — the block texture atlas
 *  uFogColor        (vec3)      — sky/fog color for fog blending
 *  uFogNear         (float)     — fog start distance
 *  uFogFar          (float)     — fog end distance
 *  uSkyLight        (float)     — sky light level [0..1]
 *  uBlockLight      (float)     — block light contribution [0..1]
 *  uAnimatedOffsets (vec4[])    — per-sprite UV offsets for animations (future)
 *
 * Lighting model:
 *  Minecraft uses a simplified light model: no dynamic shadows, no PBR.
 *  Light comes from:
 *   1. Sky light: uniform directional component (no actual shadow rays)
 *   2. AO: per-vertex, baked at chunk mesh time (Stage 12)
 *   3. Block light: emitted by nearby light sources (future — per-vertex light level)
 *   4. Face shading: darker for down-facing faces (classic Minecraft look)
 *
 * Face shading factors (matching vanilla):
 *  up:    1.0
 *  down:  0.5
 *  north/south: 0.8
 *  east/west:   0.6
 */

import * as THREE from 'three'

// NOTE: Three.js's ShaderMaterial automatically prepends declarations for
//       position, normal, uv, modelViewMatrix, projectionMatrix, and
//       normalMatrix. Declaring them again here triggers a GLSL duplicate-
//       symbol error and the vertex shader fails to compile silently
//       (THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false).
//       We only declare our CUSTOM attributes (ao, tintColor) here.
const VERTEX_SHADER = /* glsl */`
attribute float ao;
attribute vec3  tintColor;

varying vec2  vUv;
varying float vAo;
varying vec3  vTint;
varying float vFogDepth;
varying float vFaceShade;

// Compute Minecraft-style face shading factor from block/world face direction.
// Do NOT use normalMatrix here: that transforms normals into camera/view space,
// causing brightness to change as the camera orbits. Chunk meshes only translate,
// so the authored mesh normal is already the stable block-axis direction.
float faceShading(vec3 n) {
  if (n.y > 0.5)  return 1.00;     // up face
  if (n.y < -0.5) return 0.50;     // down face
  if (abs(n.z) > 0.5) return 0.80; // north/south
  return 0.60;                     // east/west
}

void main() {
  vUv        = uv;
  vAo        = ao;
  vTint      = tintColor;
  vFaceShade = faceShading(normalize(normal));

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vFogDepth  = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`

// Same caveat as VERTEX_SHADER — Three.js's ShaderMaterial provides default
// precision declarations. We don't need our own `precision highp float;` line.
const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D uAtlas;
uniform vec3      uFogColor;
uniform float     uFogNear;
uniform float     uFogFar;
uniform float     uSkyLight;

varying vec2  vUv;
varying float vAo;
varying vec3  vTint;
varying float vFogDepth;
varying float vFaceShade;

void main() {
  vec4 texColor = texture2D(uAtlas, vUv);

  // Alpha discard for cutout geometry (glass panes, leaves in FAST mode)
  // Full alpha cutout at 0.1 threshold — matches Minecraft's alphatest
  if (texColor.a < 0.1) discard;

  // Apply biome tint. Mesher writes (1,1,1) for untinted blocks; for tinted
  // ones (grass, foliage, water) it writes the biome color. Safe to
  // unconditionally multiply because untinted is the identity.
  texColor.rgb *= vTint;

  // Apply directional face shading (darker on down/side faces)
  texColor.rgb *= vFaceShade;

  // Apply ambient occlusion (multiply, not additive — matches vanilla).
  // Vertex AO is in [0,1] with 1 = fully lit; mesher writes 1.0 when AO
  // generation hasn't run yet so this is safe before stage 12.
  texColor.rgb *= vAo;

  // Apply sky light scaling
  texColor.rgb *= uSkyLight;

  // Linear fog
  float fogFactor = clamp((vFogDepth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  texColor.rgb = mix(texColor.rgb, uFogColor, fogFactor);

  gl_FragColor = vec4(texColor.rgb, 1.0);
}
`

export interface BlockShaderUniforms {
  uAtlas:    { value: THREE.Texture | null }
  uFogColor: { value: THREE.Color }
  uFogNear:  { value: number }
  uFogFar:   { value: number }
  uSkyLight: { value: number }
}

/**
 * Create the Three.js ShaderMaterial for block geometry rendering.
 *
 * Returns a ShaderMaterial with the uniforms struct typed for easy updates.
 * The atlas texture can be swapped at runtime by updating uAtlas.value.
 */
export function createBlockShaderMaterial(
  atlasTexture: THREE.Texture | null = null
): { material: THREE.ShaderMaterial; uniforms: BlockShaderUniforms } {
  const uniforms: BlockShaderUniforms = {
    uAtlas:    { value: atlasTexture },
    uFogColor: { value: new THREE.Color(0x87CEEB) },
    uFogNear:  { value: 128 },
    uFogFar:   { value: 512 },
    uSkyLight: { value: 1.0 },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms:       uniforms as unknown as { [key: string]: THREE.IUniform },

    // Render state
    transparent:  false,    // Solid pass (cutout uses separate material)
    side:         THREE.FrontSide,
    depthWrite:   true,
    depthTest:    true,
    alphaTest:    0.1,      // Discard pixels below 10% alpha (cutout)
    vertexColors: false,    // We use custom tintColor attribute, not Three.js vertexColors
  })

  return { material, uniforms }
}

/**
 * Variant of the block shader for translucent geometry (water, stained glass).
 * Renders in a second pass with depth write disabled and alpha blending on.
 */
export function createTranslucentBlockShaderMaterial(
  atlasTexture: THREE.Texture | null = null
): { material: THREE.ShaderMaterial; uniforms: BlockShaderUniforms } {
  const { material, uniforms } = createBlockShaderMaterial(atlasTexture)
  material.transparent = true
  material.depthWrite  = false
  material.alphaTest   = 0
  material.blending    = THREE.NormalBlending
  return { material, uniforms }
}

/**
 * packages/renderer-core/src/camera/OrbitCameraController.ts
 *
 * Spherical-coordinate orbit camera, modelled after Blockbench / Litematica.
 *
 *  - Left-drag      → orbit around target (yaw + pitch)
 *  - Right/Middle-drag → pan target in the camera's screen plane
 *  - Wheel          → dolly in/out (distance)
 *  - Pitch is clamped to (−π/2 + ε, π/2 − ε) so the view never flips.
 *
 * The controller stores its own (target, yaw, pitch, distance) and applies
 * them to the Three.js PerspectiveCamera every frame via update(). This keeps
 * camera state independent of any external mutation of camera.position.
 */

import * as THREE from 'three'

export interface OrbitCameraOptions {
  target?: THREE.Vector3
  distance?: number
  yaw?: number   // radians, around world-Y
  pitch?: number // radians, 0 = horizon, +π/2 = straight down
  minDistance?: number
  maxDistance?: number
  rotateSpeed?: number
  panSpeed?: number
  zoomSpeed?: number
}

export class OrbitCameraController {
  private readonly camera: THREE.PerspectiveCamera
  private readonly dom: HTMLElement

  // Spherical state around `target`
  private readonly target = new THREE.Vector3()
  private yaw = 0
  private pitch = 0
  private distance = 32

  // Limits / tuning
  private readonly minDistance: number
  private readonly maxDistance: number
  private readonly rotateSpeed: number
  private readonly panSpeed: number
  private readonly zoomSpeed: number
  private readonly minPitch = -Math.PI / 2 + 0.01
  private readonly maxPitch = Math.PI / 2 - 0.01

  // Drag state
  private activeButton: -1 | 0 | 1 | 2 = -1
  private lastX = 0
  private lastY = 0

  // Scratch math objects to avoid per-frame allocations
  private readonly tmpOffset = new THREE.Vector3()
  private readonly tmpRight = new THREE.Vector3()
  private readonly tmpUp = new THREE.Vector3()

  // Bound handler refs (so we can remove them on dispose)
  private readonly onMouseDown: (e: MouseEvent) => void
  private readonly onMouseMove: (e: MouseEvent) => void
  private readonly onMouseUp: (e: MouseEvent) => void
  private readonly onWheel: (e: WheelEvent) => void
  private readonly onContextMenu: (e: MouseEvent) => void

  constructor(
    camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    options: OrbitCameraOptions = {}
  ) {
    this.camera = camera
    this.dom = dom

    if (options.target) this.target.copy(options.target)
    this.distance = options.distance ?? 48
    this.yaw = options.yaw ?? Math.PI / 4
    this.pitch = options.pitch ?? Math.PI / 6
    this.minDistance = options.minDistance ?? 2
    this.maxDistance = options.maxDistance ?? 1024
    this.rotateSpeed = options.rotateSpeed ?? 0.005
    this.panSpeed = options.panSpeed ?? 0.0025
    this.zoomSpeed = options.zoomSpeed ?? 0.0015

    this.onMouseDown = e => this.handleMouseDown(e)
    this.onMouseMove = e => this.handleMouseMove(e)
    this.onMouseUp = e => this.handleMouseUp(e)
    this.onWheel = e => this.handleWheel(e)
    this.onContextMenu = e => e.preventDefault()

    this.dom.addEventListener('mousedown', this.onMouseDown)
    // mouse{move,up} on window so dragging continues when leaving the canvas
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    this.dom.addEventListener('contextmenu', this.onContextMenu)

    this.apply()

    // TEMP: diagnostic so we can confirm at runtime that the controller
    // was instantiated AND bound to the actual on-screen canvas. If the
    // dimensions are 0×0 the canvas isn't receiving pointer events and
    // the layout is the bug, not the camera math.
    const r = (dom as HTMLElement).getBoundingClientRect()
    console.log('[OrbitCamera] attached', {
      tag: (dom as HTMLElement).tagName,
      rect: `${Math.round(r.width)}x${Math.round(r.height)} @ (${Math.round(r.left)},${Math.round(r.top)})`,
      initialPos: this.camera.position.toArray().map(n => Math.round(n)),
    })
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z)
    this.apply()
  }

  setView(yaw: number, pitch: number, distance: number): void {
    this.yaw = yaw
    this.pitch = THREE.MathUtils.clamp(pitch, this.minPitch, this.maxPitch)
    this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance)
    this.apply()
  }

  dispose(): void {
    this.dom.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    this.dom.removeEventListener('wheel', this.onWheel)
    this.dom.removeEventListener('contextmenu', this.onContextMenu)
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    console.log('[OrbitCamera] mousedown', {
      button: e.button,
      target: (e.target as HTMLElement)?.tagName,
      matches: e.target === this.dom,
    })
    // Only react to clicks on the canvas itself
    if (e.target !== this.dom && !(this.dom as HTMLElement).contains(e.target as Node)) return
    this.activeButton = e.button as 0 | 1 | 2
    this.lastX = e.clientX
    this.lastY = e.clientY
    e.preventDefault()
  }

  private moveLogCount = 0
  private handleMouseMove(e: MouseEvent): void {
    if (this.activeButton === -1) return

    if (this.moveLogCount++ < 3) {
      console.log('[OrbitCamera] drag move', { btn: this.activeButton, dx: e.movementX, dy: e.movementY })
    }

    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY

    if (this.activeButton === 0) {
      // Left button: orbit
      this.yaw -= dx * this.rotateSpeed
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + dy * this.rotateSpeed,
        this.minPitch,
        this.maxPitch
      )
      this.apply()
    } else {
      // Middle/right button: pan in the camera's screen-plane.
      // Pan distance scales with current zoom so it feels consistent.
      const panScale = this.distance * this.panSpeed
      // Camera basis vectors in world space.
      this.camera.matrixWorld.extractBasis(this.tmpRight, this.tmpUp, new THREE.Vector3())
      this.target.addScaledVector(this.tmpRight, -dx * panScale)
      this.target.addScaledVector(this.tmpUp, dy * panScale)
      this.apply()
    }
  }

  private handleMouseUp(_e: MouseEvent): void {
    this.activeButton = -1
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault()
    // Multiplicative zoom feels right; deltaY is positive when scrolling down (zoom out).
    const factor = Math.exp(e.deltaY * this.zoomSpeed)
    this.distance = THREE.MathUtils.clamp(
      this.distance * factor,
      this.minDistance,
      this.maxDistance
    )
    this.apply()
  }

  // ── Math ──────────────────────────────────────────────────────────────────

  private apply(): void {
    // Spherical → cartesian. yaw rotates around world-Y; pitch tilts up/down.
    const cosPitch = Math.cos(this.pitch)
    this.tmpOffset.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch
    ).multiplyScalar(this.distance)

    this.camera.position.copy(this.target).add(this.tmpOffset)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.target)
    this.camera.updateMatrixWorld()
  }
}

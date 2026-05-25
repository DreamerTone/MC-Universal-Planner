/**
 * packages/renderer-core/src/camera/OrbitCameraController.ts
 *
 * Spherical-coordinate orbit camera, modelled after Blockbench / Litematica.
 */

import * as THREE from 'three'

export interface OrbitCameraOptions {
  target?: THREE.Vector3
  distance?: number
  yaw?: number
  pitch?: number
  minPitch?: number
  maxPitch?: number
  minDistance?: number
  maxDistance?: number
  rotateSpeed?: number
  panSpeed?: number
  zoomSpeed?: number
}

export class OrbitCameraController {
  private readonly camera: THREE.PerspectiveCamera
  private readonly dom: HTMLElement

  private readonly target = new THREE.Vector3()
  private yaw = 0
  private pitch = 0
  private distance = 32

  private readonly minDistance: number
  private readonly maxDistance: number
  private readonly rotateSpeed: number
  private readonly panSpeed: number
  private readonly zoomSpeed: number
  private readonly minPitch: number
  private readonly maxPitch: number

  private activeButton: -1 | 0 | 1 | 2 = -1
  private lastX = 0
  private lastY = 0

  private readonly tmpOffset = new THREE.Vector3()
  private readonly tmpRight = new THREE.Vector3()
  private readonly tmpUp = new THREE.Vector3()

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
    this.minPitch = options.minPitch ?? (-Math.PI / 2 + 0.01)
    this.maxPitch = options.maxPitch ?? (Math.PI / 2 - 0.01)
    this.pitch = THREE.MathUtils.clamp(options.pitch ?? Math.PI / 6, this.minPitch, this.maxPitch)
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
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    this.dom.addEventListener('contextmenu', this.onContextMenu)

    this.apply()
  }

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

  private handleMouseDown(e: MouseEvent): void {
    if (e.target !== this.dom && !(this.dom as HTMLElement).contains(e.target as Node)) return
    this.activeButton = e.button as 0 | 1 | 2
    this.lastX = e.clientX
    this.lastY = e.clientY
    e.preventDefault()
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.activeButton === -1) return

    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY

    if (this.activeButton === 0) {
      this.yaw -= dx * this.rotateSpeed
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + dy * this.rotateSpeed,
        this.minPitch,
        this.maxPitch
      )
      this.apply()
    } else {
      const panScale = this.distance * this.panSpeed
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
    const factor = Math.exp(e.deltaY * this.zoomSpeed)
    this.distance = THREE.MathUtils.clamp(
      this.distance * factor,
      this.minDistance,
      this.maxDistance
    )
    this.apply()
  }

  private apply(): void {
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

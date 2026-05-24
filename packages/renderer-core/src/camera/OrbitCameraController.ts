import * as THREE from "three"

export class OrbitCameraController {
    private camera: THREE.Camera
    private dom: HTMLElement

    private rotationX = 0
    private rotationY = 0
    private distance = 20

    constructor(camera: THREE.Camera, dom: HTMLElement) {
        this.camera = camera
        this.dom = dom

        this.bindEvents()
    }

    private bindEvents() {
        let dragging = false

        this.dom.addEventListener("mousedown", () => {
            dragging = true
        })

        this.dom.addEventListener("mouseup", () => {
            dragging = false
        })

        this.dom.addEventListener("mousemove", (e) => {
            if (!dragging) return

            this.rotationX += e.movementX * 0.005
            this.rotationY += e.movementY * 0.005

            this.update()
        })

        this.dom.addEventListener("wheel", (e) => {
            this.distance += e.deltaY * 0.01
            this.distance = Math.max(2, this.distance)
            this.update()
        })
    }

    update() {
        const x = Math.cos(this.rotationX) * this.distance
        const z = Math.sin(this.rotationX) * this.distance
        const y = this.rotationY * this.distance

        this.camera.position.set(x, y, z)
        this.camera.lookAt(0, 0, 0)
    }
}
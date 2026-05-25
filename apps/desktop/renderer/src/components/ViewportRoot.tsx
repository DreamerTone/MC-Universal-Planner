/**
 * apps/desktop/renderer/src/components/ViewportRoot.tsx
 *
 * Three.js viewport host component.
 */

import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { RendererCore } from '@mc-planner/renderer-core'
import type { AssetIndex } from '@mc-planner/shared'

interface ViewportRootProps {
  assetIndex: AssetIndex | null
  selectedBlockId: string
}

const PLATFORM_Y = 63
const PLATFORM_SIZE = 32
const MAX_BUILD_Y = 319
const MIN_BUILD_Y = -64

export function ViewportRoot({ assetIndex, selectedBlockId }: ViewportRootProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<RendererCore | null>(null)
  const selectedBlockRef = useRef(selectedBlockId)
  const [rendererReadyTick, setRendererReadyTick] = React.useState(0)

  useEffect(() => {
    selectedBlockRef.current = selectedBlockId
  }, [selectedBlockId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false

    async function init() {
      const [{ RendererCore }, { World }, { globalBlockStateRegistry }] = await Promise.all([
        import('@mc-planner/renderer-core'),
        import('@mc-planner/world-engine'),
        import('@mc-planner/world-engine'),
      ])

      if (cancelled) return

      const renderer = new RendererCore(canvas!, { antialias: true, maxPixelRatio: 2 })
      const world = new World()

      const stoneId = globalBlockStateRegistry.register({
        id: 'minecraft:stone' as any,
        properties: {},
      })

      for (let x = 0; x < PLATFORM_SIZE; x++) {
        for (let z = 0; z < PLATFORM_SIZE; z++) {
          world.chunks.setBlock(x, PLATFORM_Y, z, stoneId)
        }
      }

      renderer.attachWorld(world)
      rendererRef.current = renderer
      setRendererReadyTick(t => t + 1)

      console.log('[ViewportRoot] Renderer + World initialized. Test scene: 32×32 stone platform.')
    }

    init().catch(console.error)

    return () => {
      cancelled = true
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let downX = 0
    let downY = 0
    let downButton = -1

    const handlePointerDown = (e: PointerEvent) => {
      downX = e.clientX
      downY = e.clientY
      downButton = e.button
    }

    const handlePointerUp = async (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY)
      if (moved > 4) return
      if (downButton !== 0 && downButton !== 2) return

      const renderer = rendererRef.current
      if (!renderer) return

      const hit = raycastBlockFace(canvas, renderer, e.clientX, e.clientY)
      if (!hit) return

      const { globalBlockStateRegistry, AIR_BLOCKSTATE_ID } = await import('@mc-planner/world-engine')

      if (downButton === 2) {
        const remove = hit.remove
        renderer.setBlock(remove.x, remove.y, remove.z, AIR_BLOCKSTATE_ID as unknown as number)
        renderer.markAllDirty()
        console.log(`[ViewportRoot] Removed block at ${remove.x},${remove.y},${remove.z}`)
        return
      }

      const place = hit.place
      const stateId = globalBlockStateRegistry.register({
        id: selectedBlockRef.current as any,
        properties: {},
      })
      renderer.setBlock(place.x, place.y, place.z, stateId as unknown as number)
      renderer.markAllDirty()
      console.log(`[ViewportRoot] Placed ${selectedBlockRef.current} at ${place.x},${place.y},${place.z}`)
    }

    const preventContextMenu = (e: MouseEvent) => e.preventDefault()

    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('contextmenu', preventContextMenu)

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('contextmenu', preventContextMenu)
    }
  }, [])

  useEffect(() => {
    if (!assetIndex) return
    const renderer = rendererRef.current
    if (!renderer) return

    let cancelled = false

    async function runPipeline() {
      const { PipelineOrchestrator } = await import('@mc-planner/renderer-core')
      if (cancelled) return

      const orchestrator = new PipelineOrchestrator(renderer!)
      try {
        await orchestrator.run(assetIndex!, progress => {
          if (cancelled) return
          window.dispatchEvent(new CustomEvent('pipeline:progress', { detail: progress }))
        })
        if (!cancelled) {
          console.log('[ViewportRoot] Pipeline complete — chunks re-meshed with real geometry.')
        }
      } catch (err) {
        if (!cancelled) console.error('[ViewportRoot] Pipeline failed:', err)
      }
    }

    runPipeline()

    return () => {
      cancelled = true
    }
  }, [assetIndex, rendererReadyTick])

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
      />
      <div style={{
        position: 'absolute',
        left: 12,
        top: 12,
        padding: '6px 8px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.45)',
        color: '#fff',
        fontSize: 12,
        pointerEvents: 'none',
      }}>
        Left click face: place {selectedBlockId.replace(/^minecraft:/, '')} · Right click: remove clicked block
      </div>
    </div>
  )
}

function raycastBlockFace(
  canvas: HTMLCanvasElement,
  renderer: RendererCore,
  clientX: number,
  clientY: number
): { place: BlockPos; remove: BlockPos } | null {
  const rect = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -(((clientY - rect.top) / rect.height) * 2 - 1)
  )

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, renderer.threeCamera)

  const hits = raycaster.intersectObjects(renderer.worldChunkGroup.children, true)
  const hit = hits.find(h => h.face && h.object instanceof THREE.Mesh)
  if (!hit || !hit.face) return null

  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
  normal.set(Math.round(normal.x), Math.round(normal.y), Math.round(normal.z))

  const removePoint = hit.point.clone().addScaledVector(normal, -0.01)
  const placePoint = hit.point.clone().addScaledVector(normal, 0.01)

  const remove = vectorToBlockPos(removePoint)
  const place = vectorToBlockPos(placePoint)
  if (!isBuildable(place) || !isBuildable(remove)) return null

  return { place, remove }
}

function vectorToBlockPos(v: THREE.Vector3): BlockPos {
  return {
    x: Math.floor(v.x),
    y: Math.floor(v.y),
    z: Math.floor(v.z),
  }
}

function isBuildable(pos: BlockPos): boolean {
  return (
    pos.y >= MIN_BUILD_Y &&
    pos.y <= MAX_BUILD_Y &&
    Number.isFinite(pos.x) &&
    Number.isFinite(pos.y) &&
    Number.isFinite(pos.z)
  )
}

interface BlockPos {
  x: number
  y: number
  z: number
}

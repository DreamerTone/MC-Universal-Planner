/**
 * apps/desktop/renderer/src/components/ViewportRoot.tsx
 *
 * Three.js viewport host component.
 *
 * CRITICAL ARCHITECTURE NOTE:
 * This component owns the <canvas> element and delegates ALL rendering
 * to packages/renderer-core. React NEVER touches the canvas context.
 *
 * Responsibilities:
 *  - Lifecycle of the RendererCore + initial test World
 *  - Watching the loaded AssetIndex and kicking the PipelineOrchestrator
 *    (atlas → resolver → baked registry → shader → re-mesh) whenever a
 *    new set of JARs has finished indexing.
 */

import React, { useEffect, useRef } from 'react'
import type { RendererCore } from '@mc-planner/renderer-core'
import type { AssetIndex } from '@mc-planner/shared'

interface ViewportRootProps {
  assetIndex: AssetIndex | null
}

export function ViewportRoot({ assetIndex }: ViewportRootProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The live RendererCore — set by the init effect, read by the pipeline
  // effect. Stored in a ref because it's not React state (we never want a
  // re-render when the renderer changes; the canvas owns its own lifecycle).
  const rendererRef = useRef<RendererCore | null>(null)
  // Bumped each time the renderer is (re)created so the pipeline effect
  // re-runs and re-binds against the new RendererCore instance even when
  // assetIndex is unchanged.
  const [rendererReadyTick, setRendererReadyTick] = React.useState(0)

  // ── Renderer + test world lifecycle ────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Guard against React 18 StrictMode double-invoke: the effect mounts,
    // unmounts immediately, then mounts again. The async init() can resolve
    // AFTER the first cleanup has run, leaving a stale renderer bound to
    // the canvas and a second one created on remount. Two renderers + two
    // OrbitCameraControllers fighting over the same canvas means input
    // events fire twice and the camera never visibly moves.
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

      // ── Test scene: flat 32×32 stone platform at Y=63 ──────────────────
      // This validates the entire pipeline from world → dirty queue → mesh worker.
      // Will be replaced by real schematic/project loading in later stages.
      const stoneId = globalBlockStateRegistry.register({
        id: 'minecraft:stone' as any,
        properties: {},
      })

      for (let x = 0; x < 32; x++) {
        for (let z = 0; z < 32; z++) {
          world.chunks.setBlock(x, 63, z, stoneId)
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

  // ── Pipeline kick on AssetIndex change ─────────────────────────────────
  // When AssetLoader finishes indexing a set of JARs and BlockstateLoader has
  // compiled them, the parent passes the AssetIndex down. We then run the
  // full atlas → baker → shader pipeline against the new index and trigger
  // a full chunk re-mesh so the test platform (and any future placed blocks)
  // render with real textures instead of the placeholder material.
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
          // Forward to the status bar via a custom event — keeps this
          // component decoupled from the StatusBar implementation.
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
    </div>
  )
}

/**
 * apps/desktop/renderer/src/components/ViewportRoot.tsx
 *
 * Three.js viewport host component.
 *
 * CRITICAL ARCHITECTURE NOTE:
 * This component owns the <canvas> element and delegates ALL rendering
 * to packages/renderer-core. React NEVER touches the canvas context.
 *
 * Stage 4 update:
 * ViewportRoot now creates a World and attaches it to the RendererCore.
 * A test grid of stone blocks is placed to verify the pipeline end-to-end.
 * Once the block shader (Stage 11) is complete this will show real geometry.
 *
 * The World instance lives here and is passed down to children via context
 * (or a Zustand store — finalized in the UI build stage).
 */

import React, { useEffect, useRef } from 'react'
import type { RendererCore } from '@mc-planner/renderer-core'

export function ViewportRoot(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer: RendererCore | null = null

    async function init() {
      const [{ RendererCore }, { World }, { globalBlockStateRegistry }] = await Promise.all([
        import('@mc-planner/renderer-core'),
        import('@mc-planner/world-engine'),
        import('@mc-planner/world-engine'),
      ])

      renderer = new RendererCore(canvas!, { antialias: true, maxPixelRatio: 2 })

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

      console.log('[ViewportRoot] Renderer + World initialized. Test scene: 32×32 stone platform.')
    }

    init().catch(console.error)

    return () => {
      renderer?.destroy()
    }
  }, [])

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
      />
    </div>
  )
}

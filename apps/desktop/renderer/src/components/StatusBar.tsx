import React, { useState, useEffect } from 'react'
import type { PipelineProgress } from '@mc-planner/renderer-core'

type PipelineState =
  | { status: 'idle' }
  | { status: 'running'; stage: 'atlas' | 'shader'; phase?: string; current: number; total: number }
  | { status: 'complete' }

export function StatusBar(): React.JSX.Element {
  const [fps, setFps] = useState(0)
  const [pipeline, setPipeline] = useState<PipelineState>({ status: 'idle' })

  // FPS stream from the renderer core
  useEffect(() => {
    const handler = (e: CustomEvent<{ fps: number }>) => setFps(e.detail.fps)
    window.addEventListener('renderer:fps' as any, handler)
    return () => window.removeEventListener('renderer:fps' as any, handler)
  }, [])

  // Pipeline progress stream from ViewportRoot's orchestrator run
  useEffect(() => {
    const handler = (e: CustomEvent<PipelineProgress>) => {
      const p = e.detail
      if (p.stage === 'complete') {
        setPipeline({ status: 'complete' })
      } else if (p.phase !== undefined) {
        setPipeline({ status: 'running', stage: p.stage, phase: p.phase, current: p.current, total: p.total })
      } else {
        setPipeline({ status: 'running', stage: p.stage, current: p.current, total: p.total })
      }
    }
    window.addEventListener('pipeline:progress' as any, handler)
    return () => window.removeEventListener('pipeline:progress' as any, handler)
  }, [])

  const pipelineLabel = (() => {
    if (pipeline.status === 'idle') return 'Ready'
    if (pipeline.status === 'complete') return 'Assets baked'
    const pct = pipeline.total > 0 ? Math.round((pipeline.current / pipeline.total) * 100) : 0
    const what = pipeline.phase ?? pipeline.stage
    return `Pipeline: ${what} ${pct}%`
  })()

  return (
    <div style={{
      height: 'var(--statusbar-height)',
      background: 'var(--color-bg-secondary)',
      borderTop: '1px solid var(--color-border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      gap: 16,
      fontSize: 'var(--font-size-sm)',
      color: 'var(--color-text-secondary)',
      flexShrink: 0,
    }}>
      <span>FPS: {fps}</span>
      <span>{pipelineLabel}</span>
    </div>
  )
}

/**
 * apps/desktop/renderer/src/components/AssetLoader.tsx
 *
 * Asset loading UI — the panel the user interacts with to import JAR files.
 *
 * Flow:
 *  1. User clicks "Import JAR(s)"
 *  2. system:openJarDialog → native file picker
 *  3. asset:loadJar (IPC) → main process extracts + indexes the JARs
 *  4. asset:loadProgress events stream back (hashing → extracting → indexing)
 *  5. BlockstateLoader.loadFromIndex() runs in the renderer process
 *     (compiles blockstates via idle-loop callbacks)
 *  6. ModelResolver is instantiated and attached to the viewport
 *  7. World dirty queue begins generating mesh jobs
 *
 * This component is self-contained and communicates completion via the
 * onAssetsLoaded callback.
 */

import React, { useState, useCallback, useEffect } from 'react'
import type { AssetIndex } from '@mc-planner/shared'

interface AssetLoaderProps {
  onAssetsLoaded: (index: AssetIndex) => void
}

type Phase = 'idle' | 'hashing' | 'extracting' | 'indexing' | 'compiling' | 'done' | 'error'

interface Progress {
  phase: Phase
  current: number
  total: number
  message: string
}

const PHASE_LABELS: Record<Phase, string> = {
  idle:      'Ready',
  hashing:   'Hashing JAR files…',
  extracting:'Extracting assets…',
  indexing:  'Indexing registry…',
  compiling: 'Compiling blockstates…',
  done:      'Assets loaded',
  error:     'Error',
}

export function AssetLoader({ onAssetsLoaded }: AssetLoaderProps): React.JSX.Element {
  const [progress, setProgress] = useState<Progress>({ phase: 'idle', current: 0, total: 0, message: '' })
  const [loadedIndex, setLoadedIndex] = useState<AssetIndex | null>(null)

  const setPhase = (phase: Phase, current = 0, total = 0, extra = '') =>
    setProgress({ phase, current, total, message: extra })

  const handleImport = useCallback(async () => {
    const dialog = await window.electronAPI.system.openJarDialog()
    if (dialog.canceled || dialog.filePaths.length === 0) return

    // Subscribe to streaming progress events from the main process
    const unsubscribe = window.electronAPI.asset.onLoadProgress(event => {
      const phase = event.phase as Phase
      setPhase(phase, event.current, event.total, event.currentFile ?? '')
    })

    setPhase('hashing', 0, dialog.filePaths.length)

    const result = await window.electronAPI.asset.loadJar({
      jarPaths: dialog.filePaths,
    })

    unsubscribe()

    if (!result.success || !result.assetIndex) {
      setPhase('error', 0, 0, result.error ?? 'Unknown error')
      return
    }

    const index = result.assetIndex

    // Now compile blockstates in the renderer process (idle loop)
    setPhase('compiling', 0, index.blockstateCount)

    // Dynamically import the blockstate loader to keep initial bundle small
    const { globalBlockstateLoader } = await import('@mc-planner/renderer-core')

    await globalBlockstateLoader.loadFromIndex(index, event => {
      if (event.phase === 'blockstates') {
        setPhase('compiling', event.current, event.total)
      }
    })

    setLoadedIndex(index)
    setPhase('done', index.blockstateCount, index.blockstateCount,
      `${index.namespaces.join(', ')} — ${index.blockstateCount} blocks, ${index.textureCount} textures`)

    onAssetsLoaded(index)
  }, [onAssetsLoaded])

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <div style={{
      padding: 12,
      borderBottom: '1px solid var(--color-border)',
      background: 'var(--color-bg-panel)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Assets
        </strong>
        <button
          onClick={handleImport}
          disabled={progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error'}
          style={{
            marginLeft: 'auto',
            background: 'var(--color-accent)',
            color: '#fff',
            border: 'none',
            padding: '3px 10px',
            borderRadius: 3,
            fontSize: 'var(--font-size-sm)',
            cursor: 'pointer',
            opacity: (progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error') ? 0.5 : 1,
          }}
        >
          Import JAR…
        </button>
      </div>

      {progress.phase !== 'idle' && (
        <div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
            {PHASE_LABELS[progress.phase]}
            {progress.total > 0 && ` (${progress.current} / ${progress.total})`}
          </div>

          {progress.phase !== 'done' && progress.phase !== 'error' && (
            <div style={{ height: 3, background: 'var(--color-border)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${pct}%`,
                background: 'var(--color-accent)',
                transition: 'width 100ms linear',
              }} />
            </div>
          )}

          {progress.message && (
            <div style={{
              marginTop: 4,
              fontSize: 11,
              color: progress.phase === 'error' ? 'var(--color-accent-danger)' : 'var(--color-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {progress.message}
            </div>
          )}
        </div>
      )}

      {loadedIndex && (
        <div style={{ marginTop: 8, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          {loadedIndex.namespaces.map(ns => (
            <span key={ns} style={{
              display: 'inline-block',
              background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border)',
              borderRadius: 3,
              padding: '1px 6px',
              marginRight: 4,
              fontSize: 11,
            }}>
              {ns}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * apps/desktop/renderer/src/components/App.tsx
 *
 * Root application component.
 *
 * Layout architecture:
 *  ┌─────────────────────────────────────────────────────┐
 *  │ Toolbar (file operations, tools, view modes)         │
 *  ├──────────┬──────────────────────────────┬────────────┤
 *  │ Left     │                              │ Right      │
 *  │ Panel    │   3D Viewport (Three.js)     │ Panel      │
 *  │ (block   │                              │ (props,    │
 *  │  picker) │                              │  recipes)  │
 *  ├──────────┴──────────────────────────────┴────────────┤
 *  │ Status Bar (position, FPS, asset status)             │
 *  └─────────────────────────────────────────────────────┘
 *
 * The 3D viewport is managed outside React via the ViewportRoot component.
 * React does NOT own the canvas; it owns the surrounding UI chrome.
 * This prevents React re-renders from interfering with the render loop.
 */

import React, { useState } from 'react'
import type { AssetIndex } from '@mc-planner/shared'
import { Toolbar } from './Toolbar'
import { ViewportRoot } from './ViewportRoot'
import { StatusBar } from './StatusBar'
import { WelcomeScreen } from './WelcomeScreen'
import { AssetLoader } from './AssetLoader'

type AppState = 'welcome' | 'project'

export function App(): React.JSX.Element {
  const [appState, setAppState] = useState<AppState>('welcome')
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [assetIndex, setAssetIndex] = useState<AssetIndex | null>(null)

  const handleProjectOpen = (path: string) => {
    setProjectPath(path)
    setAppState('project')
  }

  const handleAssetsLoaded = (index: AssetIndex) => {
    setAssetIndex(index)
    // Diagnostic: counts on the index header should match the actual entries
    // array. If header says 1168 blockstates but the array filter returns 0,
    // the entries weren't serialised across IPC properly.
    const blockstateRows = index.entries.filter(e => e.type === 'blockstate').length
    const textureRows = index.entries.filter(e => e.type === 'texture').length
    console.log('[App] Assets loaded:', {
      namespaces: index.namespaces,
      header: { blocks: index.blockstateCount, textures: index.textureCount },
      entriesArray: { total: index.entries.length, blockstate: blockstateRows, texture: textureRows },
      sample: index.entries.slice(0, 3),
    })
  }

  const handleNewProject = async (name: string) => {
    const path = await window.electronAPI.project.create(name)
    handleProjectOpen(path)
  }

  if (appState === 'welcome') {
    return (
      <WelcomeScreen
        onNewProject={handleNewProject}
        onOpenProject={handleProjectOpen}
      />
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      background: 'var(--color-bg-primary)',
    }}>
      <Toolbar projectPath={projectPath} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <aside style={{
          width: 280,
          flexShrink: 0,
          background: 'var(--color-bg-secondary)',
          borderRight: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}>
          <AssetLoader onAssetsLoaded={handleAssetsLoaded} />
        </aside>
        <ViewportRoot assetIndex={assetIndex} />
      </div>
      <StatusBar />
    </div>
  )
}

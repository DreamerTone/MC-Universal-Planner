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

import React, { useEffect, useState } from 'react'
import { Toolbar } from './Toolbar'
import { ViewportRoot } from './ViewportRoot'
import { StatusBar } from './StatusBar'
import { WelcomeScreen } from './WelcomeScreen'

type AppState = 'welcome' | 'project'

export function App(): React.JSX.Element {
  const [appState, setAppState] = useState<AppState>('welcome')
  const [projectPath, setProjectPath] = useState<string | null>(null)

  const handleProjectOpen = (path: string) => {
    setProjectPath(path)
    setAppState('project')
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
        <ViewportRoot />
      </div>
      <StatusBar />
    </div>
  )
}

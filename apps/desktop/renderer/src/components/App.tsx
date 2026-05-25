/**
 * apps/desktop/renderer/src/components/App.tsx
 *
 * Root application component.
 */

import React, { useMemo, useState } from 'react'
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
  const [selectedBlockId, setSelectedBlockId] = useState('minecraft:stone')
  const [blockSearch, setBlockSearch] = useState('')

  const blockIds = useMemo(() => {
    if (!assetIndex) return []
    const ids = assetIndex.entries
      .filter(e => e.type === 'blockstate')
      .map(e => e.resourceLocation)
      .sort((a, b) => a.localeCompare(b))
    return Array.from(new Set(ids))
  }, [assetIndex])

  const filteredBlockIds = useMemo(() => {
    const q = blockSearch.trim().toLowerCase()
    if (!q) return blockIds.slice(0, 200)
    return blockIds.filter(id => id.toLowerCase().includes(q)).slice(0, 200)
  }, [blockIds, blockSearch])

  const handleProjectOpen = (path: string) => {
    setProjectPath(path)
    setAppState('project')
  }

  const handleAssetsLoaded = (index: AssetIndex) => {
    setAssetIndex(index)
    const firstBlock = index.entries.find(e => e.type === 'blockstate')?.resourceLocation
    if (firstBlock && selectedBlockId === 'minecraft:stone') {
      const hasStone = index.entries.some(e => e.type === 'blockstate' && e.resourceLocation === 'minecraft:stone')
      setSelectedBlockId(hasStone ? 'minecraft:stone' : firstBlock)
    }

    const blockstateRows = index.entries.filter(e => e.type === 'blockstate').length
    const textureRows = index.entries.filter(e => e.type === 'texture').length
    const typeHistogram: Record<string, number> = {}
    for (const e of index.entries) {
      typeHistogram[e.type ?? '<undefined>'] = (typeHistogram[e.type ?? '<undefined>'] ?? 0) + 1
    }
    console.log('[App] Assets loaded:', {
      namespaces: index.namespaces,
      header: { blocks: index.blockstateCount, textures: index.textureCount },
      entriesArray: { total: index.entries.length, blockstate: blockstateRows, texture: textureRows },
    })
    console.log('[App] entries type histogram:', JSON.stringify(typeHistogram))
    console.log('[App] first entry as JSON:', JSON.stringify(index.entries[0]))
    console.log('[App] entries 100/500/1000 as JSON:',
      JSON.stringify(index.entries[100]),
      JSON.stringify(index.entries[500]),
      JSON.stringify(index.entries[1000]),
    )
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
          overflow: 'hidden',
        }}>
          <AssetLoader onAssetsLoaded={handleAssetsLoaded} />

          <div style={{
            borderTop: '1px solid var(--color-border)',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minHeight: 0,
            flex: 1,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              BLOCK PICKER
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
              Selected: {selectedBlockId}
            </div>
            <input
              value={blockSearch}
              onChange={e => setBlockSearch(e.target.value)}
              placeholder="Search blocks..."
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 8px',
                borderRadius: 4,
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-primary)',
                color: 'var(--color-text-primary)',
              }}
            />
            <div style={{
              overflow: 'auto',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
              minHeight: 0,
              flex: 1,
            }}>
              {filteredBlockIds.map(id => (
                <button
                  key={id}
                  onClick={() => setSelectedBlockId(id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '5px 8px',
                    border: 0,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    background: id === selectedBlockId ? 'rgba(90, 160, 100, 0.35)' : 'transparent',
                    color: id === selectedBlockId ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    fontSize: 11,
                  }}
                >
                  {id.replace(/^minecraft:/, '')}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              Left-click a block face to place the selected block. Right-click a block to remove it.
            </div>
          </div>
        </aside>
        <ViewportRoot assetIndex={assetIndex} selectedBlockId={selectedBlockId} />
      </div>
      <StatusBar />
    </div>
  )
}

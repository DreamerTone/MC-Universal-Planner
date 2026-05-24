import React, { useState, useEffect } from 'react'
import type { ProjectMetadata } from '@mc-planner/shared'

interface WelcomeScreenProps {
  onNewProject(name: string): void
  onOpenProject(path: string): void
}

export function WelcomeScreen({ onNewProject, onOpenProject }: WelcomeScreenProps): React.JSX.Element {
  const [recentProjects, setRecentProjects] = useState<ProjectMetadata[]>([])
  const [newName, setNewName] = useState('')

  useEffect(() => {
    window.electronAPI.project.listRecent().then(setRecentProjects).catch(console.error)
  }, [])

  const handleNew = () => {
    if (newName.trim()) onNewProject(newName.trim())
  }

  const handleOpen = async () => {
    const path = await window.electronAPI.project.openDialog()
    if (path) onOpenProject(path)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh',
      background: 'var(--color-bg-primary)', gap: 24,
    }}>
      <h1 style={{ color: 'var(--color-accent)', fontSize: 28, margin: 0 }}>
        MC Universal Planner
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
        Minecraft-compatible planning & automation engine
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleNew()}
          placeholder="Project name..."
          style={{
            background: 'var(--color-bg-tertiary)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            padding: '6px 10px', borderRadius: 4, fontSize: 14, width: 220,
          }}
        />
        <button onClick={handleNew} disabled={!newName.trim()} style={{
          background: 'var(--color-accent)', color: '#fff',
          border: 'none', padding: '6px 16px', borderRadius: 4,
          cursor: 'pointer', fontSize: 14,
        }}>
          New Project
        </button>
        <button onClick={handleOpen} style={{
          background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border)', padding: '6px 16px', borderRadius: 4,
          cursor: 'pointer', fontSize: 14,
        }}>
          Open…
        </button>
      </div>
      {recentProjects.length > 0 && (
        <div style={{ width: 400 }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 12, margin: '0 0 6px' }}>RECENT</p>
          {recentProjects.map(p => (
            <div key={p.filePath} onClick={() => p.filePath && onOpenProject(p.filePath)}
              style={{
                padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
                background: 'var(--color-bg-secondary)', marginBottom: 4,
              }}>
              <strong>{p.name}</strong>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 12, marginLeft: 8 }}>
                {p.mcVersion}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

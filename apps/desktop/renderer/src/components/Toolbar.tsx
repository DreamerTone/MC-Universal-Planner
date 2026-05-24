import React from 'react'

interface ToolbarProps {
  projectPath: string | null
}

export function Toolbar({ projectPath }: ToolbarProps): React.JSX.Element {
  return (
    <div style={{
      height: 'var(--toolbar-height)',
      background: 'var(--color-bg-secondary)',
      borderBottom: '1px solid var(--color-border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{ fontWeight: 600, color: 'var(--color-accent)' }}>
        MC Universal Planner
      </span>
      {projectPath && (
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
          — {projectPath.split('/').pop()}
        </span>
      )}
    </div>
  )
}

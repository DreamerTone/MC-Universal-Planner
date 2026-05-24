import React, { useState, useEffect } from 'react'

export function StatusBar(): React.JSX.Element {
  const [fps, setFps] = useState(0)

  // The renderer core emits FPS via a CustomEvent on the window
  useEffect(() => {
    const handler = (e: CustomEvent<{ fps: number }>) => setFps(e.detail.fps)
    window.addEventListener('renderer:fps' as any, handler)
    return () => window.removeEventListener('renderer:fps' as any, handler)
  }, [])

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
      <span>Ready</span>
    </div>
  )
}

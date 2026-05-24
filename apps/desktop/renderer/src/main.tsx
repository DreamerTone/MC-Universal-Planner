/**
 * apps/desktop/renderer/src/main.tsx
 *
 * React renderer entry point.
 *
 * WHY StrictMode?
 * Strict mode in development helps catch side effects in render functions
 * early. It's especially important for ECS system registration — any system
 * that registers itself at render time (wrong pattern) will be caught here.
 *
 * The rendering engine (Three.js + WebGL) is initialized OUTSIDE of React,
 * in a dedicated EngineRoot component that manages the canvas lifecycle.
 * React owns the 2D UI layer; Three.js owns the 3D viewport.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './components/App'
import './styles/global.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('#root element not found')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

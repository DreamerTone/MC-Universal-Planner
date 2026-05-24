import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Vite config for the renderer process (React/Three.js UI)
// The electron main process is compiled separately via tsc.
// We intentionally keep electron and renderer build pipelines separate
// to avoid bundling Node.js APIs into the WebGL renderer context.
export default defineConfig({
  plugins: [react()],
  root: 'renderer',
  base: './',
  resolve: {
    alias: {
      '@mc-planner/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@mc-planner/ecs': path.resolve(__dirname, '../../packages/ecs/src/index.ts'),
      '@mc-planner/world-engine': path.resolve(__dirname, '../../packages/world-engine/src/index.ts'),
      '@mc-planner/renderer-core': path.resolve(__dirname, '../../packages/renderer-core/src/index.ts'),
      '@mc-planner/asset-pipeline': path.resolve(__dirname, '../../packages/asset-pipeline/src/index.ts'),
      '@mc-planner/simulation-engine': path.resolve(__dirname, '../../packages/simulation-engine/src/index.ts'),
    }
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'renderer/index.html')
      }
    },
    // Three.js and large WASM modules must be code-split to prevent
    // a single gigantic bundle that destroys initial load time.
    chunkSizeWarningLimit: 2000,
    target: 'esnext'
  },
  worker: {
    format: 'es',
    // All simulation/meshing workers are built as separate ES modules
    // so Electron can load them from the filesystem with Worker() API.
    plugins: () => []
  },
  optimizeDeps: {
    exclude: ['@mc-planner/renderer-core']
  }
})

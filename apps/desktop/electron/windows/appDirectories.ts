/**
 * apps/desktop/electron/windows/appDirectories.ts
 *
 * Initializes the application's persistent directory structure on first launch.
 *
 * In production: directories live under Electron's userData path
 *   (e.g. ~/Library/Application Support/mc-universal-planner on macOS)
 *
 * In development: directories are created relative to the repo root,
 *   matching the documented project structure exactly.
 *
 * This is intentionally separate from main.ts so it can be unit-tested
 * without spinning up an Electron environment.
 */

import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

/** Directories the engine needs at startup */
const APP_DIRS = [
  'projects',   // User's saved planner projects (.mcplan files)
  'cache',      // Baked model/texture/mesh cache (invalidated by jar hash)
  'assets',     // Extracted and indexed mod assets
  'logs',       // Application logs (renderer errors, simulation logs)
] as const

export type AppDir = (typeof APP_DIRS)[number]

let resolvedAppRoot: string | null = null

/**
 * Returns the resolved app root path for the current environment.
 * Call initAppDirectories() before using this.
 */
export function getAppRoot(): string {
  if (!resolvedAppRoot) {
    throw new Error('getAppRoot() called before initAppDirectories()')
  }
  return resolvedAppRoot
}

/**
 * Returns the full path to a named application directory.
 * Used by IPC handlers and the asset pipeline to locate files.
 */
export function getAppDirPath(dir: AppDir): string {
  return path.join(getAppRoot(), dir)
}

/**
 * Initializes all required application directories.
 * Safe to call multiple times (uses mkdir with recursive: true).
 */
export async function initAppDirectories(isDev: boolean): Promise<void> {
  const root = isDev
    ? path.resolve(process.cwd(), '../../') // repo root in dev
    : app.getPath('userData')

  resolvedAppRoot = root

  for (const dir of APP_DIRS) {
    const dirPath = path.join(root, dir)
    await fs.mkdir(dirPath, { recursive: true })
  }

  console.log(`[AppDirs] Initialized under: ${root}`)
}

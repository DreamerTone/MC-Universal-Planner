/**
 * apps/desktop/electron/ipc/projectHandlers.ts
 *
 * IPC handlers for project file management:
 *  - Creating / opening / saving planner projects (.mcplan)
 *  - Listing recent projects
 *  - Exporting schematics (Litematica .litematic, NBT)
 *
 * .mcplan files are JSON (or CBOR for large worlds) containing:
 *  - World state (block positions + states as sparse 3D grid)
 *  - Simulation state (automation layout, belt networks)
 *  - Metadata (mod list, Minecraft version, creation date)
 *
 * Project serialization/deserialization lives in packages/serialization.
 * These handlers are thin file I/O adapters.
 */

import { ipcMain, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { getAppDirPath } from '../windows/appDirectories'
import type {
  ProjectMetadata,
  SaveProjectRequest,
  LoadProjectResult,
} from '@mc-planner/shared'

const PROJECT_EXTENSION = '.mcplan'

export function registerProjectIpcHandlers(): void {

  // ── project:listRecent ───────────────────────────────────────────────────
  // Scans the projects directory and returns metadata for all .mcplan files.
  ipcMain.handle('project:listRecent', async (): Promise<ProjectMetadata[]> => {
    const projectsDir = getAppDirPath('projects')
    let entries: string[]

    try {
      entries = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    const projects: ProjectMetadata[] = []

    for (const entry of entries) {
      if (!entry.endsWith(PROJECT_EXTENSION)) continue
      const fullPath = path.join(projectsDir, entry)
      try {
        const stat = await fs.stat(fullPath)
        // Read only the metadata header (first 4KB) instead of the full file
        const fd = await fs.open(fullPath, 'r')
        const buf = Buffer.alloc(4096)
        await fd.read(buf, 0, 4096, 0)
        await fd.close()

        // Metadata is at the start of the file as a null-terminated JSON header
        const nullIdx = buf.indexOf(0)
        const headerJson = buf.subarray(0, nullIdx === -1 ? buf.length : nullIdx).toString('utf8')
        const header = JSON.parse(headerJson) as ProjectMetadata

        projects.push({
          ...header,
          filePath: fullPath,
          lastModified: stat.mtimeMs,
        })
      } catch {
        // Skip corrupted files silently
      }
    }

    return projects.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
  })

  // ── project:new ──────────────────────────────────────────────────────────
  // Creates a new empty project file and returns its path.
  ipcMain.handle(
    'project:new',
    async (_event, name: string): Promise<string> => {
      const projectsDir = getAppDirPath('projects')
      const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_')
      const fileName = `${safeName}${PROJECT_EXTENSION}`
      const filePath = path.join(projectsDir, fileName)

      const metadata: ProjectMetadata = {
        name,
        version: '0.1.0',
        mcVersion: '1.20.1',
        mods: [],
        createdAt: Date.now(),
        lastModified: Date.now(),
        filePath,
      }

      // Write metadata header followed by empty world payload
      const headerJson = JSON.stringify(metadata)
      const headerBuf = Buffer.from(headerJson + '\0', 'utf8')
      const emptyPayload = Buffer.from('{}')

      await fs.writeFile(filePath, Buffer.concat([headerBuf, emptyPayload]))
      return filePath
    }
  )

  // ── project:save ─────────────────────────────────────────────────────────
  // Serializes the current project state to disk.
  // The renderer sends a pre-serialized Buffer (handled by packages/serialization).
  ipcMain.handle(
    'project:save',
    async (_event, request: SaveProjectRequest): Promise<void> => {
      const { filePath, data } = request

      // Security: only allow writing within the projects directory
      const projectsDir = getAppDirPath('projects')
      const resolved = path.resolve(filePath)
      if (!resolved.startsWith(projectsDir)) {
        throw new Error('Invalid project path: must be within projects directory')
      }

      // Atomic write: write to temp file then rename to prevent corruption
      const tmpPath = `${resolved}.tmp`
      await fs.writeFile(tmpPath, Buffer.from(data))
      await fs.rename(tmpPath, resolved)
    }
  )

  // ── project:load ─────────────────────────────────────────────────────────
  // Reads a project file and returns raw bytes to the renderer.
  // Deserialization happens in packages/serialization (renderer side).
  ipcMain.handle(
    'project:load',
    async (_event, filePath: string): Promise<LoadProjectResult> => {
      const projectsDir = getAppDirPath('projects')
      const resolved = path.resolve(filePath)

      // Security: only allow reading within the projects directory
      if (!resolved.startsWith(projectsDir)) {
        return { success: false, error: 'Invalid project path', data: null }
      }

      try {
        const data = await fs.readFile(resolved)
        return { success: true, data: data.buffer as ArrayBuffer, error: null }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message, data: null }
      }
    }
  )

  // ── project:openDialog ───────────────────────────────────────────────────
  // Shows a file open dialog filtered to .mcplan files.
  ipcMain.handle('project:openDialog', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Open Project',
      defaultPath: getAppDirPath('projects'),
      filters: [{ name: 'MC Planner Projects', extensions: ['mcplan'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ── project:saveAsDialog ─────────────────────────────────────────────────
  // Shows a save dialog for exporting a project to a chosen location.
  ipcMain.handle(
    'project:saveAsDialog',
    async (_event, defaultName: string): Promise<string | null> => {
      const result = await dialog.showSaveDialog({
        title: 'Save Project As',
        defaultPath: path.join(getAppDirPath('projects'), defaultName),
        filters: [{ name: 'MC Planner Projects', extensions: ['mcplan'] }],
      })
      return result.canceled ? null : result.filePath ?? null
    }
  )
}

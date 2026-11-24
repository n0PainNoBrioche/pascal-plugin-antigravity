import { useScene } from '@pascal-app/core'
import { applySceneGraphToEditor, type SceneGraph } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { extractSceneIdFromPathname } from './scene-prompt'
import type { PascalSceneContext, PascalZoneSummary } from './types'

type RawNodeRecord = {
  id?: string
  type?: string
  name?: string
}

/**
 * Reads a compact, serializable snapshot of the active Pascal scene directly
 * from `@pascal-app/core` and `@pascal-app/viewer` stores.
 */
export function readPascalSceneContext(): PascalSceneContext {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : ''
  const sceneId = extractSceneIdFromPathname(pathname)

  let nodeCount = 0
  let wallCount = 0
  const zones: PascalZoneSummary[] = []

  try {
    const state = useScene.getState() as { nodes?: Record<string, RawNodeRecord> }
    const nodes = state?.nodes ?? {}
    const entries = Object.values(nodes)
    nodeCount = entries.length

    for (const node of entries) {
      if (!node || typeof node !== 'object') continue
      if (node.type === 'wall') {
        wallCount += 1
      } else if (node.type === 'zone' && typeof node.id === 'string') {
        zones.push({
          id: node.id,
          name: typeof node.name === 'string' && node.name.trim() ? node.name.trim() : node.id,
        })
      }
    }
  } catch {
    // Store may not be initialized in headless tests.
  }

  let selectedNodeIds: string[] = []
  let activeLevelId: string | null = null

  try {
    const viewerState = useViewer.getState() as {
      selection?: {
        selectedIds?: string[]
        levelId?: string | null
      }
    }
    selectedNodeIds = Array.isArray(viewerState?.selection?.selectedIds)
      ? viewerState.selection.selectedIds.filter((id): id is string => typeof id === 'string')
      : []
    activeLevelId =
      typeof viewerState?.selection?.levelId === 'string' ? viewerState.selection.levelId : null
  } catch {
    // Viewer store optional in headless tests.
  }

  return {
    sceneId,
    pathname,
    nodeCount,
    wallCount,
    zones,
    selectedNodeIds,
    activeLevelId,
  }
}

/**
 * Reloads the active scene graph from the Pascal host `/api/scenes/<id>` endpoint
 * and applies it to the live editor store.
 */
export async function reloadActivePascalScene(
  sceneId: string | null,
): Promise<{ ok: boolean; nodeCount?: number; error?: string }> {
  if (!sceneId) {
    return { ok: false, error: 'No active scene ID in URL.' }
  }
  try {
    const response = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) {
      return { ok: false, error: `Failed to fetch scene (${response.status}).` }
    }
    const payload = (await response.json()) as {
      graph?: SceneGraph
      nodes?: SceneGraph['nodes']
      rootNodeIds?: SceneGraph['rootNodeIds']
    }
    const graph: SceneGraph | null = payload.graph
      ? payload.graph
      : payload.nodes && payload.rootNodeIds
        ? ({
            nodes: payload.nodes,
            rootNodeIds: payload.rootNodeIds,
          } as SceneGraph)
        : null

    if (!graph) {
      return { ok: false, error: 'Scene response did not include a scene graph.' }
    }

    applySceneGraphToEditor(graph)
    const count = graph.nodes ? Object.keys(graph.nodes).length : 0
    return { ok: true, nodeCount: count }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to reload scene.',
    }
  }
}

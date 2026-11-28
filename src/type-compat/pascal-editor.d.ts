import type { ComponentType } from 'react'

export type EditorHostPanelIcon =
  | { kind: 'iconify'; name: string }
  | { kind: 'url'; src: string }
  | { kind: 'svg'; viewBox: string; path: string }
  | { kind: 'component'; module: () => Promise<{ default: ComponentType }> }

export interface EditorHostPanel {
  id: string
  label: string
  icon: EditorHostPanelIcon
  component: () => Promise<{ default: ComponentType }>
  pluginId?: string
  description?: string
  creator?: { name: string; url?: string }
  pluginUrl?: string
  defaultInstalled?: boolean
  workspaces?: string[]
  section?: string
}

export interface SceneGraph {
  nodes: Record<string, unknown>
  rootNodeIds: string[]
}

export function applySceneGraphToEditor(graph: SceneGraph): void
export function registerEditorHostPanel(panel: EditorHostPanel): void

export interface EditorStoreState {
  setSelectedItem: (asset: unknown) => void
  setTool: (tool: string) => void
  setMode: (mode: string) => void
}

export interface UseEditorHook {
  <T>(selector: (state: EditorStoreState) => T): T
  getState(): EditorStoreState
}

export const useEditor: UseEditorHook

import type { Plugin } from '@pascal-app/core'
import type { EditorHostPanel } from '@pascal-app/editor'

export const SKETCHFAB_PLUGIN_ID = 'sketchfab:assets'
export const SKETCHFAB_PANEL_ID = 'sketchfab:assets:panel'

const SKETCHFAB_ICON = {
  kind: 'svg' as const,
  viewBox: '0 0 24 24',
  path: 'M12 2 3.5 6.8v10.4L12 22l8.5-4.8V6.8L12 2Zm0 2.2 6.3 3.6L12 11.4 5.7 7.8 12 4.2Zm-6.5 5.3 5.5 3.1v6.6l-5.5-3.1V9.5Zm13 0v6.6l-5.5 3.1v-6.6l5.5-3.1Z',
}

export const sketchfabPlugin = {
  id: SKETCHFAB_PLUGIN_ID,
  apiVersion: 1,
  nodes: [],
} satisfies Plugin

export const sketchfabHostPanel = {
  id: SKETCHFAB_PANEL_ID,
  pluginId: sketchfabPlugin.id,
  label: 'Sketchfab',
  description: 'Search and place free downloadable 3D models from Sketchfab directly in Pascal.',
  creator: {
    name: 'Sketchfab',
    url: 'https://sketchfab.com',
  },
  pluginUrl: 'https://github.com/n0PainNoBrioche/pascal-plugin-antigravity',
  icon: SKETCHFAB_ICON,
  component: () => import('./panel'),
  defaultInstalled: true,
} satisfies EditorHostPanel

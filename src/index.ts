import type { Plugin } from '@pascal-app/core'
import type { EditorHostPanel } from '@pascal-app/editor'

export const ANTIGRAVITY_PLUGIN_ID = 'antigravity:chat'
export const ANTIGRAVITY_PANEL_ID = 'antigravity:chat:panel'
export const ANTIGRAVITY_PLUGIN_VERSION = '0.1.0'

/**
 * Custom geometric sparkle / orbit icon rendered in Pascal's left icon rail.
 */
const ANTIGRAVITY_PLUGIN_ICON = {
  kind: 'svg' as const,
  viewBox: '0 0 24 24',
  path: 'M12 2.5 14.4 9.1 21 11.5 14.4 13.9 12 20.5 9.6 13.9 3 11.5 9.6 9.1 12 2.5Zm6.25 13.5 1.05 2.7 2.7 1.05-2.7 1.05-1.05 2.7-1.05-2.7-2.7-1.05 2.7-1.05 1.05-2.7Z',
}

/**
 * Core Pascal Plugin API v1 manifest.
 * Antigravity edits native Pascal nodes through the Pascal MCP server, so no
 * custom scene node types are required.
 */
export const antigravityPlugin = {
  id: ANTIGRAVITY_PLUGIN_ID,
  apiVersion: 1,
  nodes: [],
} satisfies Plugin

/**
 * Editor sidebar panel registration. The panel component is lazy-loaded so
 * importing plugin metadata stays lightweight and side-effect free.
 */
export const antigravityHostPanel = {
  id: ANTIGRAVITY_PANEL_ID,
  pluginId: antigravityPlugin.id,
  label: 'Antigravity',
  description:
    'Chat with Antigravity directly inside Pascal to inspect, design, furnish, and validate 3D scenes via Pascal MCP.',
  creator: {
    name: 'Antigravity Pascal Plugin',
    url: 'https://antigravity.google',
  },
  pluginUrl: 'https://github.com/n0PainNoBrioche/pascal-plugin-antigravity',
  icon: ANTIGRAVITY_PLUGIN_ICON,
  component: () => import('./panel'),
  defaultInstalled: true,
} satisfies EditorHostPanel

export * from './types'
export {
  buildSceneContextPromptPrefix,
  extractSceneIdFromPathname,
} from './scene-prompt'
export {
  POLYHAVEN_PANEL_ID,
  POLYHAVEN_PLUGIN_ID,
  polyhavenHostPanel,
  polyhavenPlugin,
} from './polyhaven/plugin'

import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_PANEL_ID,
  ANTIGRAVITY_PLUGIN_ID,
  antigravityHostPanel,
  antigravityPlugin,
} from './index'

describe('antigravityPlugin manifest', () => {
  it('conforms to Pascal Plugin API v1 contract', () => {
    expect(antigravityPlugin.id).toBe(ANTIGRAVITY_PLUGIN_ID)
    expect(antigravityPlugin.apiVersion).toBe(1)
    expect(Array.isArray(antigravityPlugin.nodes)).toBe(true)
    expect(antigravityPlugin.nodes).toHaveLength(0)
  })

  it('registers a lazy-loaded EditorHostPanel bound to the plugin ID', () => {
    expect(antigravityHostPanel.id).toBe(ANTIGRAVITY_PANEL_ID)
    expect(antigravityHostPanel.pluginId).toBe(antigravityPlugin.id)
    expect(antigravityHostPanel.label).toBe('Antigravity')
    expect(typeof antigravityHostPanel.component).toBe('function')
    expect(antigravityHostPanel.icon.kind).toBe('svg')
    expect(antigravityHostPanel.defaultInstalled).toBe(true)
  })
})

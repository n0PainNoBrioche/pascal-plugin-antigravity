import { describe, expect, it } from 'vitest'
import {
  canonicalToolBaseName,
  isAuthenticationError,
  isPascalMcpTool,
  isPascalMutatingTool,
  parseAntigravityStreamLine,
} from './stream-parser'

describe('stream-parser', () => {
  it('identifies Pascal MCP tools regardless of prefixing convention', () => {
    expect(canonicalToolBaseName('mcp_pascal_add_wall')).toBe('add_wall')
    expect(canonicalToolBaseName('pascal:save_scene')).toBe('save_scene')
    expect(isPascalMcpTool('mcp_pascal_verify_scene')).toBe(true)
    expect(isPascalMcpTool('place_design')).toBe(true)
    expect(isPascalMcpTool('run_command')).toBe(false)
    expect(isPascalMutatingTool('mcp_pascal_save_scene')).toBe(true)
    expect(isPascalMutatingTool('verify_scene')).toBe(false)
  })

  it('parses init, text_delta, tool steps, scene_changed, and result events', () => {
    const initEvents = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'init',
        conversation_id: 'conv-1',
        init: { cwd: '/tmp', tools: ['mcp_pascal_add_wall'], permission_mode: 'always-proceed' },
      }),
    )
    expect(initEvents).toEqual([
      {
        type: 'init',
        conversationId: 'conv-1',
        cwd: '/tmp',
        model: undefined,
        permissionMode: 'always-proceed',
        tools: ['mcp_pascal_add_wall'],
      },
    ])

    const toolEvents = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-1',
          step_index: 3,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'mcp_pascal_save_scene',
          duration_seconds: 0.42,
          tool_info: {
            name: 'mcp_pascal_save_scene',
            parameters: { id: 'scene-7' },
            output: { saved: true },
          },
        },
      }),
      'scene-7',
    )

    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0]).toMatchObject({
      type: 'tool_update',
      tool: {
        name: 'mcp_pascal_save_scene',
        state: 'done',
        isPascalMcp: true,
        durationSeconds: 0.42,
      },
    })
    expect(toolEvents[1]).toEqual({
      type: 'scene_changed',
      toolName: 'save_scene',
      sceneId: 'scene-7',
    })

    const resultEvents = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-1',
          status: 'SUCCESS',
          response: 'Terminé.',
          duration_seconds: 2.1,
          num_turns: 1,
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      }),
    )
    expect(resultEvents[0]).toMatchObject({
      type: 'result',
      status: 'SUCCESS',
      conversationId: 'conv-1',
      usage: { totalTokens: 120 },
    })
  })

  it('detects authentication errors', () => {
    expect(isAuthenticationError('Error: Please sign in to view available models.')).toBe(true)
    expect(isAuthenticationError('authentication required')).toBe(true)
    expect(isAuthenticationError('Wall coordinates invalid')).toBe(false)
  })
})

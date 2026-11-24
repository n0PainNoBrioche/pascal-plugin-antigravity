import { describe, expect, it } from 'vitest'
import { buildSceneContextPromptPrefix, extractSceneIdFromPathname } from './scene-prompt'

describe('scene-context helpers', () => {
  it('extracts scene ID from Pascal editor routes', () => {
    expect(extractSceneIdFromPathname('/project/abc-123')).toBe('abc-123')
    expect(extractSceneIdFromPathname('/scene/my_scene_42/edit')).toBe('my_scene_42')
    expect(extractSceneIdFromPathname('/editor/scene%20one')).toBe('scene one')
    expect(extractSceneIdFromPathname('/embed/pub-9')).toBe('pub-9')
    expect(extractSceneIdFromPathname('/')).toBeNull()
    expect(extractSceneIdFromPathname('/settings')).toBeNull()
  })

  it('formats a structured context prefix with MCP instructions on first turn', () => {
    const prefix = buildSceneContextPromptPrefix(
      {
        sceneId: 'scene-42',
        pathname: '/project/scene-42',
        nodeCount: 28,
        wallCount: 10,
        zones: [{ id: 'z1', name: 'Séjour' }],
        selectedNodeIds: ['wall-1'],
        activeLevelId: 'lvl-0',
      },
      true,
    )

    expect(prefix).toContain('Active scene ID: scene-42')
    expect(prefix).toContain('Séjour (z1)')
    expect(prefix).toContain('Selected node IDs: wall-1')
    expect(prefix).toContain('load_scene')
    expect(prefix).toContain('save_scene')
  })

  it('omits first-turn instructions on follow-up turns', () => {
    const prefix = buildSceneContextPromptPrefix(
      {
        sceneId: 'scene-42',
        pathname: '/project/scene-42',
        nodeCount: 10,
        wallCount: 4,
        zones: [],
        selectedNodeIds: [],
        activeLevelId: null,
      },
      false,
    )

    expect(prefix).toContain('Active scene ID: scene-42')
    expect(prefix).not.toContain('Instructions:')
  })

  it('includes default architecte skill and attached image file paths', () => {
    const prefix = buildSceneContextPromptPrefix(null, {
      isFirstTurn: true,
      useArchitecteSkill: true,
      architecteSkillPath: '/home/user/.gemini/config/skills/architecte/SKILL.md',
      savedAttachments: [
        {
          name: 'plan-2d.png',
          mimeType: 'image/png',
          absolutePath: '/tmp/uploads/123-plan-2d.png',
        },
      ],
    })

    expect(prefix).toContain('[Default Skill: architecte]')
    expect(prefix).toContain('/home/user/.gemini/config/skills/architecte/SKILL.md')
    expect(prefix).toContain('[Attached Files]')
    expect(prefix).toContain('/tmp/uploads/123-plan-2d.png')
    expect(prefix).toContain('read_file')
  })
})

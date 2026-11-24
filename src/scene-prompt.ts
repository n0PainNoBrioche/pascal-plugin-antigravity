import type { PascalSceneContext } from './types.ts'

const SCENE_PATH_PATTERN = /^\/(?:project|scene|editor|embed)\/([^/?#]+)/i

export interface SavedAttachmentRef {
  name: string
  mimeType: string
  absolutePath: string
}

export interface PromptPrefixOptions {
  isFirstTurn: boolean
  useArchitecteSkill?: boolean
  architecteSkillPath?: string | null
  savedAttachments?: SavedAttachmentRef[]
}

/**
 * Extracts the active Pascal scene/project ID from a browser pathname such as
 * `/project/<id>`, `/scene/<id>`, or `/editor/<id>`.
 */
export function extractSceneIdFromPathname(pathname: string): string | null {
  const match = SCENE_PATH_PATTERN.exec(pathname.trim())
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * Builds a concise context preamble prepended to the prompt sent to Antigravity
 * so it immediately knows which Pascal scene is open, applies the `architecte`
 * skill by default, and inspects any uploaded images/floorplans via `read_file`.
 */
export function buildSceneContextPromptPrefix(
  context: PascalSceneContext | null | undefined,
  optionsOrFirstTurn: boolean | PromptPrefixOptions,
): string {
  const opts: PromptPrefixOptions =
    typeof optionsOrFirstTurn === 'boolean'
      ? { isFirstTurn: optionsOrFirstTurn }
      : optionsOrFirstTurn

  const blocks: string[] = []

  if (opts.isFirstTurn && opts.useArchitecteSkill !== false) {
    const skillLines = ['[Default Skill: architecte]']
    if (opts.architecteSkillPath) {
      skillLines.push(
        `Before performing architectural modeling, furnishing, finishing, or floorplan analysis, read and follow the \`architecte\` skill at: ${opts.architecteSkillPath}`,
      )
    } else {
      skillLines.push(
        'Apply the `architecte` skill workflow by default: calibrate 2D floorplans accurately, build walls/openings/zones via the `pascal` MCP, apply finishes/skirting/wet-room tiling, call `design_brief` before furnishing with collision-free procedural designs (`place_design`), verify with `verify_scene` and `check_collisions`, and save with `save_scene`.',
      )
    }
    skillLines.push('[/Default Skill]')
    blocks.push(skillLines.join('\n'))
  }

  if (context) {
    const lines: string[] = ['[Pascal Editor Context]']
    if (context.sceneId) {
      lines.push(`- Active scene ID: ${context.sceneId}`)
    } else {
      lines.push('- Active scene ID: unsaved/local canvas (call list_scenes if needed)')
    }
    lines.push(
      `- Nodes: ${context.nodeCount} (${context.wallCount} walls, ${context.zones.length} zones)`,
    )
    if (context.zones.length > 0) {
      const zoneList = context.zones
        .slice(0, 16)
        .map((z) => `${z.name} (${z.id})`)
        .join(', ')
      lines.push(`- Zones: ${zoneList}`)
    }
    if (context.activeLevelId) {
      lines.push(`- Active level ID: ${context.activeLevelId}`)
    }
    if (context.selectedNodeIds.length > 0) {
      lines.push(`- Selected node IDs: ${context.selectedNodeIds.slice(0, 12).join(', ')}`)
    }
    if (opts.isFirstTurn) {
      lines.push(
        '- Instructions: Use the connected `pascal` MCP tools directly to inspect and modify this scene. If editing an existing scene, call `load_scene` with the active scene ID first, and call `save_scene` after edits so the Pascal 3D viewport updates immediately.',
      )
    }
    lines.push('[/Pascal Editor Context]')
    blocks.push(lines.join('\n'))
  }

  if (opts.savedAttachments && opts.savedAttachments.length > 0) {
    const attachLines = ['[Attached Files]']
    for (const file of opts.savedAttachments) {
      attachLines.push(`- ${file.name} (${file.mimeType}): ${file.absolutePath}`)
    }
    attachLines.push(
      'Use `read_file` on the attached image/document path(s) above to inspect them before answering or modifying the Pascal scene.',
    )
    attachLines.push('[/Attached Files]')
    blocks.push(attachLines.join('\n'))
  }

  if (blocks.length === 0) return ''
  return `${blocks.join('\n\n')}\n\n`
}

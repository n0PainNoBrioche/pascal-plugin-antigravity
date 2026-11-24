import type { AntigravitySseEvent, ChatToolCall, ChatUsage } from '../types.ts'

const PASCAL_MUTATING_TOOLS = new Set([
  'save_scene',
  'create_project',
  'clear_scene',
  'add_wall',
  'add_door',
  'add_window',
  'set_zone',
  'divide_zone',
  'create_room',
  'apply_patch',
  'delete_node',
  'move_node',
  'set_zone_intent',
  'paint',
  'place_items',
  'place_design',
  'add_object',
  'load_scene',
])

const PASCAL_READONLY_TOOLS = new Set([
  'verify_scene',
  'check_collisions',
  'get_walls',
  'get_zones',
  'get_scene',
  'list_scenes',
  'get_project_status',
  'search_materials',
  'search_assets',
  'design_brief',
  'validate_design',
  'view_scene',
  'analyze_floorplan_image',
])

export function canonicalToolBaseName(toolName: string): string {
  // Handle prefixed names like `mcp_pascal_add_wall`, `pascal:add_wall`, `pascal/add_wall`
  const lowered = toolName.trim()
  const mcpMatch = /^mcp_pascal_(.+)$/i.exec(lowered)
  if (mcpMatch?.[1]) return mcpMatch[1]
  const nsMatch = /^pascal[:/.](.+)$/i.exec(lowered)
  if (nsMatch?.[1]) return nsMatch[1]
  return lowered
}

export function isPascalMcpTool(toolName: string): boolean {
  const trimmed = toolName.trim()
  if (/^(?:mcp_)?pascal[:_/.]/i.test(trimmed)) return true
  const base = canonicalToolBaseName(trimmed)
  return PASCAL_MUTATING_TOOLS.has(base) || PASCAL_READONLY_TOOLS.has(base)
}

export function isPascalMutatingTool(toolName: string): boolean {
  const base = canonicalToolBaseName(toolName)
  return PASCAL_MUTATING_TOOLS.has(base)
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

function mapUsage(raw: RawUsage | undefined): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    thinkingTokens: raw.thinking_tokens,
    cacheReadTokens: raw.cache_read_tokens,
    totalTokens: raw.total_tokens,
  }
}

interface RawStreamJsonLine {
  event?: string
  conversation_id?: string
  init?: {
    cwd?: string
    tools?: string[]
    permission_mode?: string
    model?: string
    agent?: string
  }
  step_update?: {
    conversation_id?: string
    step_index?: number
    state?: string
    step_type?: string
    tool_name?: string
    text_delta?: string
    duration_seconds?: number
    usage?: RawUsage
    tool_info?: {
      name?: string
      parameters?: unknown
      output?: unknown
      error?: { type?: string; message?: string }
    }
  }
  result?: {
    conversation_id?: string
    status?: string
    response?: string
    error?: string
    duration_seconds?: number
    num_turns?: number
    usage?: RawUsage
  }
  error?: string
}

function stringifyToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

/**
 * Parses a single NDJSON line emitted by `antigravity --output-format stream-json`
 * into zero or more frontend SSE events.
 */
export function parseAntigravityStreamLine(
  line: string,
  activeSceneId?: string | null,
): AntigravitySseEvent[] {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('{')) return []

  let parsed: RawStreamJsonLine
  try {
    parsed = JSON.parse(trimmed) as RawStreamJsonLine
  } catch {
    return []
  }

  const events: AntigravitySseEvent[] = []

  if (parsed.event === 'init') {
    events.push({
      type: 'init',
      conversationId: parsed.conversation_id ?? '',
      cwd: parsed.init?.cwd,
      model: parsed.init?.model,
      permissionMode: parsed.init?.permission_mode,
      tools: parsed.init?.tools,
    })
    return events
  }

  if (parsed.event === 'step_update' && parsed.step_update) {
    const step = parsed.step_update
    if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
      events.push({
        type: 'text_delta',
        text: step.text_delta,
        stepIndex: step.step_index,
      })
    }

    if (step.step_type === 'tool' || step.tool_name || step.tool_info) {
      const rawName = step.tool_info?.name ?? step.tool_name ?? 'tool'
      const params = step.tool_info?.parameters as
        | { ServerName?: string; ToolName?: string }
        | undefined
      const effectiveName =
        rawName === 'call_mcp_tool' &&
        typeof params?.ServerName === 'string' &&
        typeof params?.ToolName === 'string'
          ? `${params.ServerName}:${params.ToolName}`
          : rawName
      const stepIndex = typeof step.step_index === 'number' ? step.step_index : 0
      const hasError = Boolean(step.tool_info?.error)
      const state: ChatToolCall['state'] = hasError
        ? 'error'
        : step.state === 'DONE'
          ? 'done'
          : 'active'

      const tool: ChatToolCall = {
        id: `step-${stepIndex}-${rawName}`,
        stepIndex,
        name: effectiveName,
        state,
        parameters: step.tool_info?.parameters,
        output: stringifyToolOutput(step.tool_info?.output),
        error: step.tool_info?.error
          ? {
              type: step.tool_info.error.type,
              message: step.tool_info.error.message ?? 'Tool execution failed',
            }
          : undefined,
        durationSeconds: step.duration_seconds,
        isPascalMcp: isPascalMcpTool(effectiveName),
      }

      events.push({ type: 'tool_update', tool })

      if (state === 'done' && isPascalMutatingTool(effectiveName)) {
        events.push({
          type: 'scene_changed',
          toolName: canonicalToolBaseName(effectiveName),
          sceneId: activeSceneId ?? null,
        })
      }
    }

    return events
  }

  if (parsed.event === 'result' && parsed.result) {
    const res = parsed.result
    events.push({
      type: 'result',
      conversationId: res.conversation_id ?? parsed.conversation_id ?? null,
      status: res.status ?? 'SUCCESS',
      response: res.response,
      error: res.error,
      durationSeconds: res.duration_seconds,
      numTurns: res.num_turns,
      usage: mapUsage(res.usage),
    })
    return events
  }

  if (parsed.error) {
    events.push({
      type: 'error',
      message: parsed.error,
      authRequired: isAuthenticationError(parsed.error),
    })
  }

  return events
}

export function isAuthenticationError(message: string): boolean {
  return /sign in|authentication required|not authenticated|please log in|unauthorized/i.test(
    message,
  )
}

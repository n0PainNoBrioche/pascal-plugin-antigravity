export type AntigravityConnectionMode = 'host' | 'bridge'

export type AntigravityEffort = 'low' | 'medium' | 'high' | 'max'

export interface AntigravityPluginSettings {
  mode: AntigravityConnectionMode
  bridgeUrl: string
  bridgeToken: string
  model: string
  effort: AntigravityEffort
  skipPermissions: boolean
  includeSceneContext: boolean
  autoReloadScene: boolean
  useArchitecteSkill: boolean
}

export interface ChatAttachmentInput {
  name: string
  mimeType: string
  dataBase64: string
}

export interface ChatAttachmentPreview {
  id: string
  name: string
  mimeType: string
  previewUrl: string
  sizeBytes: number
}

export interface PascalZoneSummary {
  id: string
  name: string
}

export interface PascalSceneContext {
  sceneId: string | null
  pathname: string
  nodeCount: number
  wallCount: number
  zones: PascalZoneSummary[]
  selectedNodeIds: string[]
  activeLevelId: string | null
}

export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
}

export interface ChatToolCall {
  id: string
  stepIndex: number
  name: string
  state: 'active' | 'done' | 'error'
  parameters?: unknown
  output?: string
  error?: { type?: string; message: string }
  durationSeconds?: number
  isPascalMcp: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  attachments?: ChatAttachmentPreview[]
  toolCalls?: ChatToolCall[]
  status?: 'streaming' | 'done' | 'error' | 'aborted'
  error?: string
  durationSeconds?: number
  usage?: ChatUsage
  sceneMutated?: boolean
}

export interface AntigravityHealthResponse {
  ok: boolean
  binaryFound: boolean
  binaryPath: string | null
  mcp: {
    pascalConfigured: boolean
    pascalRunning: boolean | null
    pascalPort: number | null
    servers: Array<{ name: string; type: string; status: string }>
  }
  cwd: string
  authRequired?: boolean
  error?: string
}

export interface AntigravityModelsResponse {
  ok: boolean
  models: string[]
  authRequired?: boolean
  error?: string
}

export interface AntigravityAuthStartResponse {
  ok: boolean
  authId?: string
  authUrl?: string
  error?: string
}

export interface AntigravityAuthCompleteResponse {
  ok: boolean
  models?: string[]
  error?: string
}

export interface ChatRequestPayload {
  sessionId: string
  prompt: string
  conversationId?: string | null
  model?: string
  effort?: AntigravityEffort
  skipPermissions?: boolean
  useArchitecteSkill?: boolean
  attachments?: ChatAttachmentInput[]
  sceneContext?: PascalSceneContext | null
}

export type AntigravitySseEvent =
  | {
      type: 'session'
      sessionId: string
      conversationId?: string | null
    }
  | {
      type: 'init'
      conversationId: string
      cwd?: string
      model?: string
      permissionMode?: string
      tools?: string[]
    }
  | {
      type: 'text_delta'
      text: string
      stepIndex?: number
    }
  | {
      type: 'tool_update'
      tool: ChatToolCall
    }
  | {
      type: 'scene_changed'
      toolName: string
      sceneId?: string | null
    }
  | {
      type: 'result'
      conversationId?: string | null
      status: string
      response?: string
      error?: string
      durationSeconds?: number
      numTurns?: number
      usage?: ChatUsage
    }
  | {
      type: 'error'
      message: string
      authRequired?: boolean
    }
  | {
      type: 'done'
    }

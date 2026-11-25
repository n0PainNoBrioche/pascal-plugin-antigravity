'use client'

import { useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  abortAntigravityTurn,
  cancelAntigravityAuth,
  completeAntigravityAuth,
  DEFAULT_BRIDGE_URL,
  fetchAntigravityHealth,
  fetchAntigravityModels,
  HOST_API_BASE,
  reconnectAntigravitySession,
  resetAntigravitySession,
  resolveEndpointBase,
  startAntigravityAuth,
  streamAntigravityChat,
} from './api'
import {
  readPascalSceneContext,
  reloadActivePascalScene,
} from './scene-context'
import type {
  AntigravityEffort,
  AntigravityHealthResponse,
  AntigravityPluginSettings,
  AntigravitySseEvent,
  ChatAttachmentInput,
  ChatAttachmentPreview,
  ChatMessage,
  ChatToolCall,
} from './types'

const SETTINGS_STORAGE_KEY = 'pascal-plugin-antigravity:settings:v1'
const SESSION_STORAGE_KEY = 'pascal-plugin-antigravity:session-id:v1'
const MAX_UPLOAD_FILES = 6
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const ACCEPTED_FILE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,application/pdf'

const DEFAULT_SETTINGS: AntigravityPluginSettings = {
  mode: 'host',
  bridgeUrl: DEFAULT_BRIDGE_URL,
  bridgeToken: '',
  model: '',
  effort: 'high',
  skipPermissions: true,
  includeSceneContext: true,
  autoReloadScene: true,
  useArchitecteSkill: true,
}

type PendingUpload = ChatAttachmentPreview & {
  dataBase64: string
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Impossible de lire le fichier.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Erreur de lecture du fichier.'))
    reader.readAsDataURL(file)
  })
}

const QUICK_PROMPTS = [
  {
    label: 'Vérifier la scène',
    prompt:
      'Charge la scène active avec le MCP pascal, exécute verify_scene et check_collisions, puis donne-moi un diagnostic clair des problèmes éventuels.',
  },
  {
    label: 'Résumé des pièces',
    prompt:
      'Inspecte la scène active via le MCP pascal (get_zones, get_walls) et résume les pièces, dimensions principales et éléments présents.',
  },
  {
    label: 'Ajouter une cloison / porte',
    prompt:
      'Charge la scène active et explique-moi quelles cloisons ou ouvertures tu peux ajouter pour optimiser la circulation.',
  },
  {
    label: 'Meubler & finir',
    prompt:
      'Charge la scène active, prépare le design_brief si nécessaire, puis propose un plan de finitions et d’ameublement pièce par pièce sans collision.',
  },
] as const

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function loadSettings(): AntigravityPluginSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<AntigravityPluginSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode: parsed.mode === 'bridge' ? 'bridge' : 'host',
      effort:
        parsed.effort === 'low' ||
        parsed.effort === 'medium' ||
        parsed.effort === 'high' ||
        parsed.effort === 'max'
          ? parsed.effort
          : 'high',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(settings: AntigravityPluginSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

function loadStoredSessionId(): string {
  if (typeof window === 'undefined') return createId('ag-session')
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY)?.trim()
    if (existing) return existing
    const fresh = createId('ag-session')
    window.localStorage.setItem(SESSION_STORAGE_KEY, fresh)
    return fresh
  } catch {
    return createId('ag-session')
  }
}

function saveStoredSessionId(sessionId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

function SparkleIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2.5 14.4 9.1 21 11.5 14.4 13.9 12 20.5 9.6 13.9 3 11.5 9.6 9.1 12 2.5Zm6.25 13.5 1.05 2.7 2.7 1.05-2.7 1.05-1.05 2.7-1.05-2.7-2.7-1.05 2.7-1.05 1.05-2.7Z" />
    </svg>
  )
}

function SettingsIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

function RefreshIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 0 1-15.4 6.36L3 16" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12a9 9 0 0 1 15.4-6.36L21 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 21v-5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}

function SendIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
      <rect height="12" rx="2" width="12" x="6" y="6" />
    </svg>
  )
}

function ImageUploadIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <rect height="16" rx="2" width="18" x="3" y="4" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-4.5-4.5a1.5 1.5 0 0 0-2.1 0L7 18" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ToolCallCard({ tool }: { tool: ChatToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails =
    tool.parameters !== undefined ||
    (tool.output !== undefined && tool.output.length > 0) ||
    Boolean(tool.error)

  const badgeClass =
    tool.state === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-400'
      : tool.state === 'done'
        ? tool.isPascalMcp
          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-400'
          : 'border-sidebar-border bg-sidebar-accent/60 text-sidebar-foreground/75'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-400'

  return (
    <div className="rounded-lg border border-sidebar-border/80 bg-sidebar-accent/35 text-[11px]">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60"
        disabled={!hasDetails}
        onClick={() => hasDetails && setExpanded((prev) => !prev)}
        type="button"
      >
        <span
          className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-medium border ${badgeClass}`}
        >
          {tool.state === 'active'
            ? '●'
            : tool.state === 'done'
              ? '✓'
              : '✕'}
          {tool.isPascalMcp ? ' MCP' : ''}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono font-medium text-sidebar-foreground/90">
          {tool.name}
        </span>
        {typeof tool.durationSeconds === 'number' && (
          <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/45">
            {tool.durationSeconds.toFixed(2)}s
          </span>
        )}
        {hasDetails && (
          <span className="shrink-0 text-[10px] text-sidebar-foreground/45">
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>

      {expanded && hasDetails && (
        <div className="space-y-2 border-t border-sidebar-border/60 px-2.5 py-2 font-mono text-[10px]">
          {tool.parameters !== undefined && (
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-sidebar-foreground/45">
                Paramètres
              </div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-black/25 p-2 text-sidebar-foreground/80">
                {JSON.stringify(tool.parameters, null, 2)}
              </pre>
            </div>
          )}
          {tool.error && (
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-red-400">Erreur</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-red-950/40 p-2 text-red-300">
                {tool.error.message}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-sidebar-foreground/45">
                Résultat
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-black/25 p-2 text-sidebar-foreground/80">
                {tool.output.length > 2500 ? `${tool.output.slice(0, 2500)}…` : tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FormattedMessageText({ text }: { text: string }) {
  const segments = useMemo(() => {
    const parts: Array<{ kind: 'text' | 'code'; content: string; lang?: string }> = []
    const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g
    let lastIndex = 0
    let match = regex.exec(text)
    while (match) {
      if (match.index > lastIndex) {
        parts.push({ kind: 'text', content: text.slice(lastIndex, match.index) })
      }
      parts.push({ kind: 'code', lang: match[1] || undefined, content: match[2] ?? '' })
      lastIndex = match.index + match[0].length
      match = regex.exec(text)
    }
    if (lastIndex < text.length) {
      parts.push({ kind: 'text', content: text.slice(lastIndex) })
    }
    return parts
  }, [text])

  return (
    <div className="space-y-2 text-xs leading-relaxed">
      {segments.map((segment, index) => {
        if (segment.kind === 'code') {
          return (
            <pre
              className="overflow-x-auto rounded-lg border border-sidebar-border/70 bg-black/30 p-2.5 font-mono text-[11px] leading-snug text-sidebar-foreground/90"
              key={index}
            >
              <code>{segment.content}</code>
            </pre>
          )
        }
        return (
          <div className="whitespace-pre-wrap break-words" key={index}>
            {segment.content}
          </div>
        )
      })}
    </div>
  )
}

export default function AntigravityChatPanel() {
  const [settings, setSettings] = useState<AntigravityPluginSettings>(() => loadSettings())
  const [showSettings, setShowSettings] = useState(false)
  const [health, setHealth] = useState<AntigravityHealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  const [sessionId, setSessionId] = useState<string>(() => loadStoredSessionId())
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [sceneNotice, setSceneNotice] = useState<string | null>(null)
  const [authWarning, setAuthWarning] = useState<string | null>(null)
  const [authFlow, setAuthFlow] = useState<{
    status: 'idle' | 'starting' | 'awaiting_code' | 'verifying'
    authId?: string
    authUrl?: string
    code: string
    error?: string | null
  }>({ status: 'idle', code: '' })

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Subscribe to live Pascal scene & viewer state so the context pill stays fresh.
  const nodeCount = useScene((s) => Object.keys((s as { nodes?: Record<string, unknown> }).nodes ?? {}).length)
  const selectedIds = useViewer(
    (s) => ((s as { selection?: { selectedIds?: string[] } }).selection?.selectedIds ?? []),
  )

  const sceneContext = useMemo(() => {
    void nodeCount
    void selectedIds
    return readPascalSceneContext()
  }, [nodeCount, selectedIds])

  const updateSettings = useCallback((patch: Partial<AntigravityPluginSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  const refreshHealth = useCallback(async () => {
    setCheckingHealth(true)
    setHealthError(null)
    try {
      const result = await fetchAntigravityHealth(settings)
      setHealth(result)
      if (result.ok && result.binaryFound) {
        const modelsRes = await fetchAntigravityModels(settings).catch(() => null)
        if (modelsRes?.ok) {
          setAvailableModels(modelsRes.models)
          setAuthWarning(null)
        } else if (modelsRes?.authRequired) {
          setAuthWarning('Connecte ton compte Google Antigravity pour activer le chat.')
        }
      }
    } catch (error) {
      setHealth(null)
      setHealthError(error instanceof Error ? error.message : 'Impossible de joindre le bridge Antigravity.')
    } finally {
      setCheckingHealth(false)
    }
  }, [settings.mode, settings.bridgeUrl, settings.bridgeToken])

  const handleStartGoogleLogin = useCallback(async () => {
    setAuthFlow({ status: 'starting', code: '', error: null })
    try {
      const res = await startAntigravityAuth(settings)
      if (!res.ok) {
        setAuthFlow({
          status: 'idle',
          code: '',
          error: res.error ?? 'Impossible de démarrer la connexion Google.',
        })
        return
      }
      if (!res.authUrl) {
        // Already authenticated
        setAuthFlow({ status: 'idle', code: '', error: null })
        setAuthWarning(null)
        setSceneNotice('Antigravity déjà connecté ✓')
        setTimeout(() => setSceneNotice(null), 3500)
        void refreshHealth()
        return
      }
      setAuthFlow({
        status: 'awaiting_code',
        authId: res.authId,
        authUrl: res.authUrl,
        code: '',
        error: null,
      })
      window.open(res.authUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setAuthFlow({
        status: 'idle',
        code: '',
        error: error instanceof Error ? error.message : 'Erreur lors du démarrage OAuth.',
      })
    }
  }, [refreshHealth, settings])

  const handleCompleteGoogleLogin = useCallback(async () => {
    if (!authFlow.authId || !authFlow.code.trim()) return
    setAuthFlow((prev) => ({ ...prev, status: 'verifying', error: null }))
    try {
      const res = await completeAntigravityAuth(settings, authFlow.authId, authFlow.code.trim())
      if (!res.ok) {
        setAuthFlow((prev) => ({
          ...prev,
          status: 'awaiting_code',
          error: res.error ?? 'Code refusé ou expiré.',
        }))
        return
      }
      setAuthFlow({ status: 'idle', code: '', error: null })
      setAuthWarning(null)
      if (res.models && res.models.length > 0) {
        setAvailableModels(res.models)
      }
      setSceneNotice('Connecté à Google Antigravity ✓')
      setTimeout(() => setSceneNotice(null), 4000)
    } catch (error) {
      setAuthFlow((prev) => ({
        ...prev,
        status: 'awaiting_code',
        error: error instanceof Error ? error.message : 'Erreur de validation OAuth.',
      }))
    }
  }, [authFlow.authId, authFlow.code, settings])

  const handleCancelGoogleLogin = useCallback(async () => {
    await cancelAntigravityAuth(settings, authFlow.authId)
    setAuthFlow({ status: 'idle', code: '', error: null })
  }, [authFlow.authId, settings])

  useEffect(() => {
    void refreshHealth()
  }, [refreshHealth])

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isStreaming])

  const handleLoadModels = useCallback(async () => {
    setLoadingModels(true)
    try {
      const result = await fetchAntigravityModels(settings)
      if (result.ok) {
        setAvailableModels(result.models)
        setAuthWarning(null)
      } else if (result.authRequired) {
        setAuthWarning(result.error ?? 'Antigravity CLI doit être authentifié.')
      }
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : 'Erreur chargement des modèles.')
    } finally {
      setLoadingModels(false)
    }
  }, [settings])

  const handleReloadScene = useCallback(async () => {
    const ctx = readPascalSceneContext()
    const result = await reloadActivePascalScene(ctx.sceneId)
    if (result.ok) {
      setSceneNotice(`Scène synchronisée (${result.nodeCount ?? 0} nœuds).`)
    } else {
      setSceneNotice(result.error ?? 'Impossible de recharger la scène.')
    }
    setTimeout(() => setSceneNotice(null), 3500)
  }, [])

  const applySseEvent = useCallback(
    (
      event: AntigravitySseEvent,
      targetAssistantId?: string,
      onSceneMutated?: () => void,
    ) => {
      if (event.type === 'snapshot') {
        if (event.conversationId !== undefined) {
          setConversationId(event.conversationId ?? null)
        }
        if (event.messages.length > 0) {
          setMessages(event.messages)
        }
        setIsStreaming(event.isStreaming)
        return
      }
      if (event.type === 'init' && event.conversationId) {
        setConversationId(event.conversationId)
        return
      }
      if (event.type === 'session' && event.conversationId) {
        setConversationId(event.conversationId)
        return
      }

      const matchesTarget = (msg: ChatMessage, idx: number, list: ChatMessage[]) => {
        if (targetAssistantId) return msg.id === targetAssistantId
        if (msg.role !== 'assistant') return false
        if (msg.status === 'streaming') return true
        // Fallback to last assistant message when finalizing
        return idx === list.length - 1
      }

      if (event.type === 'text_delta') {
        setMessages((prev) =>
          prev.map((msg, idx, list) =>
            matchesTarget(msg, idx, list) ? { ...msg, content: msg.content + event.text } : msg,
          ),
        )
        return
      }
      if (event.type === 'tool_update') {
        setMessages((prev) =>
          prev.map((msg, idx, list) => {
            if (!matchesTarget(msg, idx, list)) return msg
            const existing = msg.toolCalls ?? []
            const foundIdx = existing.findIndex((item) => item.id === event.tool.id)
            const nextTools =
              foundIdx === -1
                ? [...existing, event.tool]
                : existing.map((item, i) => (i === foundIdx ? event.tool : item))
            return { ...msg, toolCalls: nextTools }
          }),
        )
        return
      }
      if (event.type === 'scene_changed') {
        onSceneMutated?.()
        setMessages((prev) =>
          prev.map((msg, idx, list) =>
            matchesTarget(msg, idx, list) ? { ...msg, sceneMutated: true } : msg,
          ),
        )
        if (settings.autoReloadScene && event.toolName === 'save_scene') {
          void handleReloadScene()
        }
        return
      }
      if (event.type === 'result') {
        if (event.conversationId) setConversationId(event.conversationId)
        setMessages((prev) =>
          prev.map((msg, idx, list) =>
            matchesTarget(msg, idx, list)
              ? {
                  ...msg,
                  status: event.error ? 'error' : 'done',
                  error: event.error,
                  durationSeconds: event.durationSeconds,
                  usage: event.usage,
                }
              : msg,
          ),
        )
        return
      }
      if (event.type === 'error') {
        if (event.authRequired) {
          setAuthWarning(event.message)
        }
        setMessages((prev) =>
          prev.map((msg, idx, list) =>
            matchesTarget(msg, idx, list)
              ? { ...msg, status: 'error', error: event.message }
              : msg,
          ),
        )
      }
    },
    [handleReloadScene, settings.autoReloadScene],
  )

  // Reconnect to any in-flight or persisted session on the bridge/host when opening Pascal.
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    let mutatedInReconnect = false

    reconnectAntigravitySession(
      settings,
      sessionId,
      (event) => {
        applySseEvent(event, undefined, () => {
          mutatedInReconnect = true
        })
        if (event.type === 'done') {
          setIsStreaming(false)
          if (mutatedInReconnect && settings.autoReloadScene) {
            void handleReloadScene()
          }
        }
      },
      controller.signal,
    ).catch(() => {
      // Ignore reconnect failures (e.g. offline bridge or component unmount).
    })

    return () => {
      controller.abort()
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    }
  }, [applySseEvent, handleReloadScene, sessionId, settings])

  const handleNewChat = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    await resetAntigravitySession(settings, sessionId)
    const nextSessionId = createId('ag-session')
    saveStoredSessionId(nextSessionId)
    setSessionId(nextSessionId)
    setConversationId(null)
    setMessages([])
    setIsStreaming(false)
    setAuthWarning(null)
  }, [settings, sessionId])

  const handleStop = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    await abortAntigravityTurn(settings, sessionId)
    setIsStreaming(false)
    setMessages((prev) =>
      prev.map((msg) =>
        msg.status === 'streaming'
          ? { ...msg, status: 'aborted' }
          : msg,
      ),
    )
  }, [settings, sessionId])

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    setUploadError(null)

    const nextItems: PendingUpload[] = []
    for (const file of files) {
      if (
        !file.type.startsWith('image/') &&
        file.type !== 'application/pdf'
      ) {
        setUploadError(`Format non supporté : ${file.name} (images PNG/JPG/WebP/GIF ou PDF).`)
        continue
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError(`Fichier trop volumineux : ${file.name} (max 15 Mo).`)
        continue
      }
      try {
        const dataUrl = await fileToDataUrl(file)
        const base64 = dataUrl.includes(',') ? (dataUrl.split(',')[1] ?? '') : dataUrl
        nextItems.push({
          id: createId('img'),
          name: file.name || `image-${Date.now()}.png`,
          mimeType: file.type || 'image/png',
          previewUrl: dataUrl,
          sizeBytes: file.size,
          dataBase64: base64,
        })
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : `Erreur lecture ${file.name}`)
      }
    }

    if (nextItems.length > 0) {
      setPendingUploads((prev) => [...prev, ...nextItems].slice(0, MAX_UPLOAD_FILES))
    }
  }, [])

  const removePendingUpload = useCallback((id: string) => {
    setPendingUploads((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const sendPrompt = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim()
      const uploadsToSend = pendingUploads
      if ((!prompt && uploadsToSend.length === 0) || isStreaming) return

      setInput('')
      setPendingUploads([])
      setUploadError(null)
      setAuthWarning(null)
      setIsStreaming(true)

      const attachmentPreviews: ChatAttachmentPreview[] = uploadsToSend.map(
        ({ id, name, mimeType, previewUrl, sizeBytes }) => ({
          id,
          name,
          mimeType,
          previewUrl,
          sizeBytes,
        }),
      )
      const attachmentPayload: ChatAttachmentInput[] = uploadsToSend.map(
        ({ name, mimeType, dataBase64 }) => ({
          name,
          mimeType,
          dataBase64,
        }),
      )

      const userMsg: ChatMessage = {
        id: createId('user'),
        role: 'user',
        content: prompt || (uploadsToSend.length === 1 ? `Image jointe : ${uploadsToSend[0]?.name}` : `${uploadsToSend.length} images jointes`),
        attachments: attachmentPreviews.length > 0 ? attachmentPreviews : undefined,
        createdAt: Date.now(),
        status: 'done',
      }
      const assistantMsgId = createId('assistant')
      const assistantPlaceholder: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        toolCalls: [],
        status: 'streaming',
      }

      setMessages((prev) => [...prev, userMsg, assistantPlaceholder])

      const controller = new AbortController()
      abortRef.current = controller
      let mutatedSceneInTurn = false

      const liveSceneContext = settings.includeSceneContext ? readPascalSceneContext() : null

      const handleEvent = (event: AntigravitySseEvent) => {
        applySseEvent(event, assistantMsgId, () => {
          mutatedSceneInTurn = true
        })
      }

      const modelHasEmbeddedEffort = /-(?:low|medium|high|xhigh|max)$/i.test(settings.model.trim())

      try {
        await streamAntigravityChat(
          settings,
          {
            sessionId,
            prompt,
            conversationId,
            model: settings.model || undefined,
            effort: modelHasEmbeddedEffort ? undefined : settings.effort,
            skipPermissions: settings.skipPermissions,
            useArchitecteSkill: settings.useArchitecteSkill,
            attachments: attachmentPayload.length > 0 ? attachmentPayload : undefined,
            sceneContext: liveSceneContext,
          },
          handleEvent,
          controller.signal,
        )

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId && msg.status === 'streaming'
              ? { ...msg, status: 'done' }
              : msg,
          ),
        )

        if (mutatedSceneInTurn && settings.autoReloadScene && liveSceneContext?.sceneId) {
          void handleReloadScene()
        }
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId ? { ...msg, status: 'aborted' } : msg,
            ),
          )
        } else {
          const message = error instanceof Error ? error.message : 'Erreur de communication.'
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId ? { ...msg, status: 'error', error: message } : msg,
            ),
          )
        }
      } finally {
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [conversationId, handleReloadScene, isStreaming, pendingUploads, sessionId, settings],
  )

  const endpointLabel = resolveEndpointBase(settings)
  const isConnected = Boolean(health?.ok && health.binaryFound)
  const pascalMcpReady = Boolean(health?.mcp.pascalConfigured)

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-sidebar-border/80 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-foreground">
            <SparkleIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="truncate text-xs font-semibold">Antigravity</h2>
              <button
                className="inline-flex items-center gap-1 rounded-full border border-sidebar-border px-1.5 py-0.5 text-[10px] text-sidebar-foreground/75 hover:bg-sidebar-accent"
                onClick={() => void refreshHealth()}
                title={
                  healthError
                    ? healthError
                    : isConnected
                      ? `Connecté (${endpointLabel}) · MCP pascal: ${pascalMcpReady ? 'actif' : 'non configuré'}`
                      : 'Bridge hors ligne — cliquer pour vérifier'
                }
                type="button"
              >
                <span
                  className={`size-1.5 rounded-full ${
                    checkingHealth
                      ? 'animate-pulse bg-amber-400'
                      : isConnected && pascalMcpReady
                        ? 'bg-emerald-400'
                        : isConnected
                          ? 'bg-amber-400'
                          : 'bg-red-400'
                  }`}
                />
                <span>{isConnected ? (pascalMcpReady ? 'MCP OK' : 'CLI OK') : 'Hors ligne'}</span>
              </button>
            </div>
            <p className="truncate font-mono text-[10px] text-sidebar-foreground/50">
              {sceneContext.sceneId ? `Scène: ${sceneContext.sceneId}` : 'Canvas local'}
              {' · '}
              {sceneContext.wallCount}m / {sceneContext.zones.length}z
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => void handleReloadScene()}
            title="Recharger la scène depuis Pascal"
            type="button"
          >
            <RefreshIcon />
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => void handleNewChat()}
            title="Nouvelle conversation"
            type="button"
          >
            <PlusIcon />
          </button>
          <button
            className={`flex size-7 items-center justify-center rounded-md transition-colors ${
              showSettings
                ? 'bg-sidebar-accent text-sidebar-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'
            }`}
            onClick={() => setShowSettings((prev) => !prev)}
            title="Paramètres Antigravity & Bridge"
            type="button"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>

      {/* Collapsible Settings Drawer */}
      {showSettings && (
        <div className="space-y-3 border-b border-sidebar-border/80 bg-sidebar-accent/25 px-3 py-3 text-xs">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/60">
              Connexion
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                className={`rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  settings.mode === 'host'
                    ? 'border-sidebar-foreground/40 bg-sidebar-accent text-sidebar-foreground'
                    : 'border-sidebar-border/70 text-sidebar-foreground/60 hover:bg-sidebar-accent/40'
                }`}
                onClick={() => updateSettings({ mode: 'host' })}
                type="button"
              >
                Host API
              </button>
              <button
                className={`rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  settings.mode === 'bridge'
                    ? 'border-sidebar-foreground/40 bg-sidebar-accent text-sidebar-foreground'
                    : 'border-sidebar-border/70 text-sidebar-foreground/60 hover:bg-sidebar-accent/40'
                }`}
                onClick={() => updateSettings({ mode: 'bridge' })}
                type="button"
              >
                Bridge local
              </button>
            </div>
            <p className="text-[10px] text-sidebar-foreground/50">
              {settings.mode === 'host'
                ? `Passe par ${HOST_API_BASE} sur le serveur Pascal.`
                : 'Connecte ce navigateur à un bridge local (pratique pour Docker ou une instance Pascal distante).'}
            </p>
          </div>

          {settings.mode === 'bridge' && (
            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-[10px] text-sidebar-foreground/60">
                  URL du bridge
                </label>
                <input
                  className="w-full rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 font-mono text-[11px] text-sidebar-foreground outline-none focus:border-sidebar-foreground/50"
                  onChange={(e) => updateSettings({ bridgeUrl: e.target.value })}
                  placeholder={DEFAULT_BRIDGE_URL}
                  type="url"
                  value={settings.bridgeUrl}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] text-sidebar-foreground/60">
                  Bearer Token (optionnel)
                </label>
                <input
                  className="w-full rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 font-mono text-[11px] text-sidebar-foreground outline-none focus:border-sidebar-foreground/50"
                  onChange={(e) => updateSettings({ bridgeToken: e.target.value })}
                  placeholder="ANTIGRAVITY_PASCAL_BRIDGE_TOKEN"
                  type="password"
                  value={settings.bridgeToken}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[10px] text-sidebar-foreground/60">Modèle</label>
                <button
                  className="text-[10px] text-sidebar-foreground/60 underline hover:text-sidebar-foreground"
                  disabled={loadingModels}
                  onClick={() => void handleLoadModels()}
                  type="button"
                >
                  {loadingModels ? '…' : 'Lister'}
                </button>
              </div>
              {availableModels.length > 0 ? (
                <select
                  className="w-full rounded-lg border border-sidebar-border bg-sidebar px-2 py-1.5 text-[11px] text-sidebar-foreground outline-none"
                  onChange={(e) => updateSettings({ model: e.target.value })}
                  value={settings.model}
                >
                  <option value="">Défaut Antigravity</option>
                  {availableModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="w-full rounded-lg border border-sidebar-border bg-sidebar px-2 py-1.5 font-mono text-[11px] text-sidebar-foreground outline-none"
                  onChange={(e) => updateSettings({ model: e.target.value })}
                  placeholder="Défaut"
                  type="text"
                  value={settings.model}
                />
              )}
            </div>

            <div>
              <label className="mb-1 block text-[10px] text-sidebar-foreground/60">Effort</label>
              {/-(?:low|medium|high|xhigh|max)$/i.test(settings.model.trim()) ? (
                <div className="rounded-lg border border-sidebar-border/60 bg-sidebar/50 px-2 py-1.5 text-[11px] text-sidebar-foreground/50">
                  Inclus dans le modèle
                </div>
              ) : (
                <select
                  className="w-full rounded-lg border border-sidebar-border bg-sidebar px-2 py-1.5 text-[11px] text-sidebar-foreground outline-none"
                  onChange={(e) => updateSettings({ effort: e.target.value as AntigravityEffort })}
                  value={settings.effort}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
              )}
            </div>
          </div>

          <div className="space-y-1.5 pt-0.5 text-[11px]">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={settings.useArchitecteSkill}
                onChange={(e) => updateSettings({ useArchitecteSkill: e.target.checked })}
                type="checkbox"
              />
              <span>Skill architecte actif par défaut</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={settings.skipPermissions}
                onChange={(e) => updateSettings({ skipPermissions: e.target.checked })}
                type="checkbox"
              />
              <span>Auto-approuver les appels MCP Pascal</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={settings.includeSceneContext}
                onChange={(e) => updateSettings({ includeSceneContext: e.target.checked })}
                type="checkbox"
              />
              <span>Injecter le contexte scène (ID, zones, sélection)</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={settings.autoReloadScene}
                onChange={(e) => updateSettings({ autoReloadScene: e.target.checked })}
                type="checkbox"
              />
              <span>Rafraîchir la scène après sauvegarde MCP</span>
            </label>
          </div>

          {health && (
            <div className="space-y-2">
              <div className="rounded-lg border border-sidebar-border/70 bg-sidebar/70 p-2 font-mono text-[10px] text-sidebar-foreground/65">
                <div className="truncate">CLI: {health.binaryPath ?? 'introuvable'}</div>
                <div>
                  MCP pascal:{' '}
                  {health.mcp.pascalConfigured ? 'configuré' : 'absent de mcp_config.json'}
                  {health.mcp.pascalRunning !== null
                    ? ` · daemon ${health.mcp.pascalRunning ? `OK (:${health.mcp.pascalPort ?? '?'})` : 'arrêté'}`
                    : ''}
                </div>
              </div>
              <button
                className="w-full rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 text-[11px] font-medium text-sidebar-foreground hover:bg-sidebar-accent disabled:opacity-50"
                disabled={authFlow.status === 'starting' || authFlow.status === 'verifying'}
                onClick={() => void handleStartGoogleLogin()}
                type="button"
              >
                {authFlow.status === 'starting'
                  ? 'Préparation du lien Google…'
                  : 'Connecter / Reconnecter Google Antigravity'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Notices */}
      {sceneNotice && (
        <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-300">
          {sceneNotice}
        </div>
      )}

      {healthError && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <div className="font-medium">Bridge non joignable ({endpointLabel})</div>
          <div className="mt-0.5 text-[10px] opacity-80">{healthError}</div>
        </div>
      )}

      {(authWarning || authFlow.status !== 'idle' || authFlow.error) && (
        <div className="space-y-2 border-b border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-[11px] text-sidebar-foreground">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-amber-300">Connexion Google Antigravity</span>
            {authFlow.status !== 'idle' && (
              <button
                className="text-[10px] text-sidebar-foreground/60 underline hover:text-sidebar-foreground"
                onClick={() => void handleCancelGoogleLogin()}
                type="button"
              >
                Annuler
              </button>
            )}
          </div>

          {authFlow.status === 'idle' && (
            <div className="space-y-2">
              <p className="text-[11px] leading-relaxed text-sidebar-foreground/75">
                Connecte ton compte Google directement depuis Pascal pour activer le chat et le MCP
                pascal.
              </p>
              <button
                className="w-full rounded-lg bg-sidebar-foreground px-3 py-1.5 text-xs font-medium text-sidebar transition-opacity hover:opacity-90"
                onClick={() => void handleStartGoogleLogin()}
                type="button"
              >
                Se connecter avec Google
              </button>
            </div>
          )}

          {authFlow.status === 'starting' && (
            <div className="text-[11px] text-sidebar-foreground/75">
              Génération du lien de connexion Google…
            </div>
          )}

          {(authFlow.status === 'awaiting_code' || authFlow.status === 'verifying') && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-sidebar-foreground/75">
                  1. Connecte-toi sur Google puis copie le code (ou l&apos;URL de redirection) :
                </span>
              </div>
              {authFlow.authUrl && (
                <a
                  className="inline-flex w-full items-center justify-center rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 text-[11px] font-medium text-sidebar-foreground hover:bg-sidebar-accent"
                  href={authFlow.authUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Ouvrir la page de connexion Google ↗
                </a>
              )}
              <div className="flex gap-1.5">
                <input
                  className="min-w-0 flex-1 rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 font-mono text-[11px] text-sidebar-foreground outline-none focus:border-sidebar-foreground/50"
                  disabled={authFlow.status === 'verifying'}
                  onChange={(e) => setAuthFlow((prev) => ({ ...prev, code: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleCompleteGoogleLogin()
                    }
                  }}
                  placeholder="Colle le code ou l'URL ici…"
                  type="text"
                  value={authFlow.code}
                />
                <button
                  className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  disabled={authFlow.status === 'verifying' || !authFlow.code.trim()}
                  onClick={() => void handleCompleteGoogleLogin()}
                  type="button"
                >
                  {authFlow.status === 'verifying' ? '…' : 'Valider'}
                </button>
              </div>
            </div>
          )}

          {authFlow.error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
              {authFlow.error}
            </div>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-center gap-4 py-4">
            <div className="space-y-1.5 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-2xl bg-sidebar-accent text-sidebar-foreground">
                <SparkleIcon className="size-5" />
              </div>
              <h3 className="text-sm font-semibold">Antigravity × Pascal MCP</h3>
              <p className="mx-auto max-w-[260px] text-xs leading-relaxed text-sidebar-foreground/60">
                Pilote directement ta scène 3D en langage naturel : murs, ouvertures, finitions,
                mobilier procédural et vérifications.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
              {QUICK_PROMPTS.map((item) => (
                <button
                  className="rounded-xl border border-sidebar-border/80 bg-sidebar-accent/30 px-3 py-2 text-left text-xs text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent/70 disabled:opacity-50"
                  disabled={isStreaming}
                  key={item.label}
                  onClick={() => void sendPrompt(item.prompt)}
                  type="button"
                >
                  <div className="font-medium">{item.label}</div>
                  <div className="mt-0.5 line-clamp-1 text-[10px] text-sidebar-foreground/55">
                    {item.prompt}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              className={`flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              key={msg.id}
            >
              {msg.role === 'user' ? (
                <div className="max-w-[90%] space-y-2 rounded-2xl rounded-br-sm bg-sidebar-accent px-3 py-2 text-xs leading-relaxed text-sidebar-foreground">
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {msg.attachments.map((att) =>
                        att.mimeType.startsWith('image/') ? (
                          <img
                            alt={att.name}
                            className="h-20 w-20 rounded-lg border border-sidebar-border/80 object-cover"
                            key={att.id}
                            src={att.previewUrl}
                          />
                        ) : (
                          <div
                            className="rounded-lg border border-sidebar-border/80 bg-sidebar/60 px-2 py-1 font-mono text-[10px]"
                            key={att.id}
                          >
                            {att.name}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                </div>
              ) : (
                <div className="w-full space-y-2 rounded-2xl rounded-bl-sm border border-sidebar-border/70 bg-sidebar-accent/20 px-3 py-2.5">
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="space-y-1.5">
                      {msg.toolCalls.map((tool) => (
                        <ToolCallCard key={tool.id} tool={tool} />
                      ))}
                    </div>
                  )}

                  {msg.content ? (
                    <FormattedMessageText text={msg.content} />
                  ) : msg.status === 'streaming' ? (
                    <div className="flex items-center gap-2 text-xs text-sidebar-foreground/55">
                      <span className="inline-block size-2 animate-pulse rounded-full bg-sidebar-foreground/60" />
                      <span>Antigravity réfléchit…</span>
                    </div>
                  ) : null}

                  {msg.error && (
                    <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300">
                      {msg.error}
                    </div>
                  )}

                  {(msg.durationSeconds !== undefined || msg.usage?.totalTokens || msg.sceneMutated) && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5 font-mono text-[10px] text-sidebar-foreground/45">
                      {msg.sceneMutated && (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400">
                          scène modifiée
                        </span>
                      )}
                      {typeof msg.durationSeconds === 'number' && (
                        <span>{msg.durationSeconds.toFixed(1)}s</span>
                      )}
                      {typeof msg.usage?.totalTokens === 'number' && (
                        <span>{msg.usage.totalTokens.toLocaleString()} tok</span>
                      )}
                      {msg.status === 'aborted' && <span className="text-amber-400">interrompu</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div
        className="border-t border-sidebar-border/80 p-2.5"
        onDragLeave={() => setIsDraggingFiles(false)}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDraggingFiles(true)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setIsDraggingFiles(false)
          if (e.dataTransfer.files?.length) {
            void addFiles(e.dataTransfer.files)
          }
        }}
      >
        <input
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          multiple
          onChange={(e) => {
            if (e.target.files?.length) {
              void addFiles(e.target.files)
              e.target.value = ''
            }
          }}
          ref={fileInputRef}
          type="file"
        />

        {uploadError && (
          <div className="mb-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[10px] text-red-300">
            {uploadError}
          </div>
        )}

        <div
          className={`rounded-xl border bg-sidebar-accent/35 p-2 transition-colors focus-within:border-sidebar-foreground/45 ${
            isDraggingFiles ? 'border-emerald-400 bg-emerald-500/10' : 'border-sidebar-border'
          }`}
        >
          {pendingUploads.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingUploads.map((item) => (
                <div
                  className="group relative overflow-hidden rounded-lg border border-sidebar-border bg-sidebar"
                  key={item.id}
                >
                  {item.mimeType.startsWith('image/') ? (
                    <img
                      alt={item.name}
                      className="h-14 w-14 object-cover"
                      src={item.previewUrl}
                    />
                  ) : (
                    <div className="flex h-14 w-20 items-center justify-center px-1.5 text-center font-mono text-[9px] text-sidebar-foreground/80">
                      {item.name}
                    </div>
                  )}
                  <button
                    aria-label={`Retirer ${item.name}`}
                    className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/75 text-[10px] text-white hover:bg-red-600"
                    onClick={() => removePendingUpload(item.id)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            className="max-h-36 min-h-[44px] w-full resize-none bg-transparent text-xs leading-relaxed text-sidebar-foreground placeholder:text-sidebar-foreground/45 outline-none"
            disabled={isStreaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void sendPrompt(input)
              }
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.files
              if (items && items.length > 0) {
                e.preventDefault()
                void addFiles(items)
              }
            }}
            placeholder="Décris ta demande ou dépose/colle un plan 2D (Ctrl+V)…"
            ref={textareaRef}
            rows={2}
            value={input}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sidebar-border px-2 py-1 text-[10px] font-medium text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-40"
                disabled={isStreaming || pendingUploads.length >= MAX_UPLOAD_FILES}
                onClick={() => fileInputRef.current?.click()}
                title="Joindre un plan 2D ou une image (PNG, JPG, WebP, PDF)"
                type="button"
              >
                <ImageUploadIcon className="size-3" />
                <span>Image</span>
              </button>
              {settings.useArchitecteSkill && (
                <span
                  className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[9px] text-emerald-400"
                  title="Skill architecte appliqué automatiquement"
                >
                  $architecte
                </span>
              )}
              <span className="truncate font-mono text-[10px] text-sidebar-foreground/45">
                {settings.includeSceneContext
                  ? `${sceneContext.nodeCount} nœuds${
                      sceneContext.selectedNodeIds.length > 0
                        ? ` · ${sceneContext.selectedNodeIds.length} sél.`
                        : ''
                    }`
                  : ''}
              </span>
            </div>

            {isStreaming ? (
              <button
                className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-red-500"
                onClick={() => void handleStop()}
                type="button"
              >
                <StopIcon className="size-3" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                className="inline-flex items-center gap-1 rounded-lg bg-sidebar-foreground px-2.5 py-1.5 text-[11px] font-medium text-sidebar transition-opacity hover:opacity-90 disabled:opacity-35"
                disabled={!input.trim() && pendingUploads.length === 0}
                onClick={() => void sendPrompt(input)}
                type="button"
              >
                <SendIcon className="size-3" />
                <span>Envoyer</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

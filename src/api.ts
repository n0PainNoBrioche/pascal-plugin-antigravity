import type {
  AntigravityAuthCompleteResponse,
  AntigravityAuthStartResponse,
  AntigravityHealthResponse,
  AntigravityModelsResponse,
  AntigravityPluginSettings,
  AntigravitySseEvent,
  ChatRequestPayload,
} from './types'

export const HOST_API_BASE = '/api/plugins/antigravity'
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4319'

export function resolveEndpointBase(settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl'>): string {
  if (settings.mode === 'host') {
    return HOST_API_BASE
  }
  const trimmed = settings.bridgeUrl.trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_BRIDGE_URL
}

function buildHeaders(settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeToken'>, hasBody = false): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (hasBody) {
    headers['Content-Type'] = 'application/json'
  }
  if (settings.bridgeToken.trim()) {
    headers.Authorization = `Bearer ${settings.bridgeToken.trim()}`
  }
  return headers
}

export async function fetchAntigravityHealth(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
): Promise<AntigravityHealthResponse> {
  const base = resolveEndpointBase(settings)
  const response = await fetch(`${base}/health`, {
    method: 'GET',
    headers: buildHeaders(settings),
    cache: 'no-store',
  })
  const data = (await response.json().catch(() => null)) as AntigravityHealthResponse | null
  if (!response.ok || !data) {
    throw new Error(data?.error ?? `Bridge health check failed (${response.status})`)
  }
  return data
}

export async function fetchAntigravityModels(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
): Promise<AntigravityModelsResponse> {
  const base = resolveEndpointBase(settings)
  const response = await fetch(`${base}/models`, {
    method: 'GET',
    headers: buildHeaders(settings),
    cache: 'no-store',
  })
  const data = (await response.json().catch(() => null)) as AntigravityModelsResponse | null
  if (!response.ok || !data) {
    throw new Error(data?.error ?? `Unable to fetch models (${response.status})`)
  }
  return data
}

export async function abortAntigravityTurn(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
  sessionId: string,
): Promise<void> {
  const base = resolveEndpointBase(settings)
  await fetch(`${base}/abort`, {
    method: 'POST',
    headers: buildHeaders(settings, true),
    body: JSON.stringify({ sessionId }),
  }).catch(() => undefined)
}

export async function resetAntigravitySession(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
  sessionId: string,
): Promise<void> {
  const base = resolveEndpointBase(settings)
  await fetch(`${base}/reset`, {
    method: 'POST',
    headers: buildHeaders(settings, true),
    body: JSON.stringify({ sessionId }),
  }).catch(() => undefined)
}

export async function startAntigravityAuth(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
): Promise<AntigravityAuthStartResponse> {
  const base = resolveEndpointBase(settings)
  const response = await fetch(`${base}/auth/start`, {
    method: 'POST',
    headers: buildHeaders(settings, true),
    body: JSON.stringify({}),
  })
  const data = (await response.json().catch(() => null)) as AntigravityAuthStartResponse | null
  if (!response.ok || !data) {
    throw new Error(data?.error ?? `Impossible de démarrer la connexion (${response.status})`)
  }
  return data
}

export async function completeAntigravityAuth(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
  authId: string,
  code: string,
): Promise<AntigravityAuthCompleteResponse> {
  const base = resolveEndpointBase(settings)
  const response = await fetch(`${base}/auth/complete`, {
    method: 'POST',
    headers: buildHeaders(settings, true),
    body: JSON.stringify({ authId, code }),
  })
  const data = (await response.json().catch(() => null)) as AntigravityAuthCompleteResponse | null
  if (!response.ok || !data) {
    throw new Error(data?.error ?? `Validation OAuth échouée (${response.status})`)
  }
  return data
}

export async function cancelAntigravityAuth(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
  authId?: string,
): Promise<void> {
  const base = resolveEndpointBase(settings)
  await fetch(`${base}/auth/cancel`, {
    method: 'POST',
    headers: buildHeaders(settings, true),
    body: JSON.stringify({ authId }),
  }).catch(() => undefined)
}

/**
 * Sends a chat turn and streams typed SSE events from either the Pascal host
 * adapter (`/api/plugins/antigravity/chat`) or the standalone local bridge.
 */
export async function streamAntigravityChat(
  settings: Pick<AntigravityPluginSettings, 'mode' | 'bridgeUrl' | 'bridgeToken'>,
  payload: ChatRequestPayload,
  onEvent: (event: AntigravitySseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = resolveEndpointBase(settings)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (settings.bridgeToken.trim()) {
    headers.Authorization = `Bearer ${settings.bridgeToken.trim()}`
  }

  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    let message = `Antigravity request failed (${response.status})`
    try {
      const errorJson = (await response.json()) as { error?: string }
      if (errorJson?.error) message = errorJson.error
    } catch {
      const text = await response.text().catch(() => '')
      if (text.trim()) message = text.trim()
    }
    throw new Error(message)
  }

  if (!response.body) {
    throw new Error('Streaming response body is unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawBlock = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        processSseBlock(rawBlock, onEvent)
        boundary = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim()) {
      processSseBlock(buffer, onEvent)
    }
  } finally {
    reader.releaseLock()
  }
}

function processSseBlock(block: string, onEvent: (event: AntigravitySseEvent) => void): void {
  const dataLines: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return

  const payload = dataLines.join('\n')
  try {
    const parsed = JSON.parse(payload) as AntigravitySseEvent
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      onEvent(parsed)
    }
  } catch {
    // Ignore malformed SSE comment/keepalive fragments.
  }
}

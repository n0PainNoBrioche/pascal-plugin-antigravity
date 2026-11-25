import { describe, expect, it } from 'vitest'
import type { AntigravitySseEvent, ChatRequestPayload } from '../types'
import type { AntigravitySessionManager } from './antigravity-runner'
import { handleAntigravityPascalRequest } from './index'

function createMockManager(): AntigravitySessionManager {
  return {
    async runTurn(
      payload: ChatRequestPayload,
      emit: (event: AntigravitySseEvent) => void,
    ): Promise<void> {
      emit({ type: 'session', sessionId: payload.sessionId, conversationId: 'conv-mock' })
      emit({ type: 'text_delta', text: `Echo: ${payload.prompt}` })
      emit({
        type: 'result',
        conversationId: 'conv-mock',
        status: 'SUCCESS',
        response: `Echo: ${payload.prompt}`,
        durationSeconds: 0.12,
      })
    },
    abortSession: () => true,
    disposeSession: () => true,
    disposeAll: () => undefined,
  } as unknown as AntigravitySessionManager
}

describe('handleAntigravityPascalRequest', () => {
  it('returns health payload and respects CORS headers', async () => {
    const req = new Request('http://127.0.0.1:4319/health', {
      method: 'GET',
      headers: { Origin: 'https://pascal.example.com' },
    })
    const res = await handleAntigravityPascalRequest(req, {
      corsOrigin: 'https://pascal.example.com',
      healthCheck: async () => ({
        ok: true,
        binaryFound: true,
        binaryPath: '/usr/local/bin/agy',
        mcp: { pascalConfigured: true, pascalRunning: true, pascalPort: 39797, servers: [] },
        cwd: '/tmp',
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://pascal.example.com')
    const data = (await res.json()) as { ok: boolean; mcp: { pascalConfigured: boolean } }
    expect(data.ok).toBe(true)
    expect(data.mcp.pascalConfigured).toBe(true)
  })

  it('enforces optional bearer token authentication', async () => {
    const unauthReq = new Request('http://127.0.0.1:4319/health')
    const unauthRes = await handleAntigravityPascalRequest(unauthReq, { authToken: 'secret-123' })
    expect(unauthRes.status).toBe(401)

    const authReq = new Request('http://127.0.0.1:4319/health', {
      headers: { Authorization: 'Bearer secret-123' },
    })
    const authRes = await handleAntigravityPascalRequest(authReq, {
      authToken: 'secret-123',
      healthCheck: async () => ({
        ok: true,
        binaryFound: true,
        binaryPath: '/usr/local/bin/agy',
        mcp: { pascalConfigured: true, pascalRunning: true, pascalPort: 39797, servers: [] },
        cwd: '/tmp',
      }),
    })
    expect(authRes.status).toBe(200)
  })

  it('streams SSE events for /api/plugins/antigravity/chat', async () => {
    const req = new Request('http://localhost:3002/api/plugins/antigravity/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-1', prompt: 'Ajoute un mur' }),
    })

    const res = await handleAntigravityPascalRequest(req, {
      sessionManager: createMockManager(),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()
    expect(body).toContain('"type":"session"')
    expect(body).toContain('"type":"text_delta","text":"Echo: Ajoute un mur"')
    expect(body).toContain('"type":"result"')
    expect(body).toContain('"type":"done"')
  })

  it('proxies requests cleanly when upstreamUrl is configured', async () => {
    let forwardedUrl = ''
    let forwardedAuth = ''
    const req = new Request('https://pascal.example.com/api/plugins/antigravity/health', {
      method: 'GET',
    })
    const res = await handleAntigravityPascalRequest(req, {
      upstreamUrl: 'http://pascal-antigravity-bridge:4319',
      upstreamToken: 'internal-secret',
      fetch: async (input, init) => {
        forwardedUrl = String(input)
        forwardedAuth = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(JSON.stringify({ ok: true, proxied: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    expect(forwardedUrl).toBe('http://pascal-antigravity-bridge:4319/health')
    expect(forwardedAuth).toBe('Bearer internal-secret')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, proxied: true })
  })

  it('handles /auth/start and /auth/complete endpoints', async () => {
    const mockAuth = {
      start: async () => ({
        ok: true,
        authId: 'auth-1',
        authUrl: 'https://accounts.google.com/o/oauth2/auth?state=test',
      }),
      complete: async (authId: string, code: string) => ({
        ok: authId === 'auth-1' && code === 'code-ok',
        models: ['gemini-4-neon'],
      }),
      cancel: () => undefined,
    } as unknown as import('./antigravity-runner').AntigravityAuthManager

    const startRes = await handleAntigravityPascalRequest(
      new Request('http://127.0.0.1:4319/auth/start', { method: 'POST' }),
      { authManager: mockAuth },
    )
    expect(startRes.status).toBe(200)
    expect(await startRes.json()).toMatchObject({ ok: true, authId: 'auth-1' })

    const completeRes = await handleAntigravityPascalRequest(
      new Request('http://127.0.0.1:4319/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authId: 'auth-1', code: 'code-ok' }),
      }),
      { authManager: mockAuth },
    )
    expect(completeRes.status).toBe(200)
    expect(await completeRes.json()).toEqual({ ok: true, models: ['gemini-4-neon'] })
  })

  it('supports GET /session and GET /events snapshot + live reconnection without aborting on disconnect', async () => {
    let abortCalled = false
    const subscribers = new Set<(event: AntigravitySseEvent) => void>()
    const snapshotMessages = [
      { id: 'u1', role: 'user' as const, content: 'Ajoute un mur', createdAt: 1, status: 'done' as const },
      { id: 'a1', role: 'assistant' as const, content: 'En cours...', createdAt: 2, status: 'streaming' as const },
    ]
    const detachedManager = {
      startTurn(payload: ChatRequestPayload, emit?: (event: AntigravitySseEvent) => void) {
        if (emit) subscribers.add(emit)
        emit?.({ type: 'session', sessionId: payload.sessionId, conversationId: 'conv-detached' })
        emit?.({ type: 'text_delta', text: 'Working...' })
        return {
          unsubscribe: () => {
            if (emit) subscribers.delete(emit)
          },
          done: Promise.resolve(),
        }
      },
      getSessionSnapshot(sessionId: string) {
        return {
          ok: true,
          sessionId,
          conversationId: 'conv-detached',
          isStreaming: true,
          messages: snapshotMessages,
        }
      },
      subscribeSession(sessionId: string, emit: (event: AntigravitySseEvent) => void) {
        emit({
          type: 'snapshot',
          sessionId,
          conversationId: 'conv-detached',
          isStreaming: true,
          messages: snapshotMessages,
        })
        emit({ type: 'text_delta', text: 'Fait !' })
        emit({ type: 'done' })
        return () => undefined
      },
      abortSession() {
        abortCalled = true
        return true
      },
      disposeSession: () => true,
      disposeAll: () => undefined,
    } as unknown as AntigravitySessionManager

    const chatRes = await handleAntigravityPascalRequest(
      new Request('http://127.0.0.1:4319/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-bg', prompt: 'Ajoute un mur' }),
      }),
      { sessionManager: detachedManager },
    )
    expect(chatRes.status).toBe(200)
    await chatRes.body?.cancel()
    expect(abortCalled).toBe(false)

    const sessionRes = await handleAntigravityPascalRequest(
      new Request('http://127.0.0.1:4319/session?sessionId=sess-bg'),
      { sessionManager: detachedManager },
    )
    expect(sessionRes.status).toBe(200)
    expect(await sessionRes.json()).toMatchObject({
      ok: true,
      sessionId: 'sess-bg',
      isStreaming: true,
      conversationId: 'conv-detached',
    })

    const eventsRes = await handleAntigravityPascalRequest(
      new Request('http://127.0.0.1:4319/events?sessionId=sess-bg'),
      { sessionManager: detachedManager },
    )
    expect(eventsRes.status).toBe(200)
    const sseText = await eventsRes.text()
    expect(sseText).toContain('"type":"snapshot"')
    expect(sseText).toContain('"type":"text_delta","text":"Fait !"')
    expect(sseText).toContain('"type":"done"')
  })
})

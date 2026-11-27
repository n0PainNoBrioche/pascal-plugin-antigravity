import { timingSafeEqual } from 'node:crypto'
import type { AntigravitySseEvent, ChatRequestPayload } from '../types.ts'
import {
  type AntigravityRunnerOptions,
  AntigravityAuthManager,
  AntigravitySessionManager,
  checkAntigravityHealth,
  getSharedAntigravityAuthManager,
  getSharedAntigravitySessionManager,
  listAntigravityModels,
} from './antigravity-runner.ts'

export interface AntigravityServerOptions extends AntigravityRunnerOptions {
  /**
   * Optional upstream bridge URL (e.g. `http://pascal-antigravity-bridge:4319`).
   * When set (or via `ANTIGRAVITY_UPSTREAM_URL`), requests are transparently
   * proxied — including SSE streams — to the sidecar bridge container.
   */
  upstreamUrl?: string
  /**
   * Optional bearer token sent to the upstream bridge when proxying.
   * Defaults to `process.env.ANTIGRAVITY_UPSTREAM_TOKEN`.
   */
  upstreamToken?: string
  /**
   * Optional bearer token required on all non-OPTIONS requests.
   * Defaults to `process.env.ANTIGRAVITY_PASCAL_BRIDGE_TOKEN`.
   */
  authToken?: string
  /**
   * Allowed CORS origin for standalone local bridge mode (e.g. `https://pascal.example.com`
   * or `*` when bound to 127.0.0.1). Leave unset for same-origin Next.js host routes.
   */
  corsOrigin?: string
  /**
   * Optional custom session manager (handy for unit tests or isolated instances).
   */
  sessionManager?: AntigravitySessionManager
  /**
   * Optional custom auth manager (handy for unit tests).
   */
  authManager?: AntigravityAuthManager
  /**
   * Optional overrides for health/models checks in tests.
   */
  healthCheck?: typeof checkAntigravityHealth
  modelsList?: typeof listAntigravityModels
  /**
   * Custom fetch implementation (used when proxying to `upstreamUrl`).
   */
  fetch?: typeof fetch
}

function corsHeaders(request: Request, configuredOrigin?: string): Record<string, string> {
  if (!configuredOrigin) return {}
  const requestOrigin = request.headers.get('origin')
  if (configuredOrigin === '*') {
    return {
      'Access-Control-Allow-Origin': requestOrigin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
  }
  const allowed = configuredOrigin
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (requestOrigin && allowed.includes(requestOrigin)) {
    return {
      'Access-Control-Allow-Origin': requestOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
  }
  return {}
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function authorizeRequest(request: Request, token: string | undefined): boolean {
  if (!token) return true
  const authHeader = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  if (!match?.[1]) return false
  return constantTimeEquals(match[1].trim(), token)
}

function extractSubpath(request: Request): string {
  const url = new URL(request.url)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const pluginPrefix = '/api/plugins/antigravity'
  if (pathname === pluginPrefix) return '/'
  if (pathname.startsWith(`${pluginPrefix}/`)) {
    return pathname.slice(pluginPrefix.length)
  }
  return pathname
}

function encodeSseEvent(event: AntigravitySseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

async function proxyToUpstream(
  request: Request,
  subpath: string,
  upstreamBase: string,
  options: AntigravityServerOptions,
  cors: Record<string, string>,
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch
  const cleanBase = upstreamBase.trim().replace(/\/+$/, '')
  const incomingUrl = new URL(request.url)
  const targetUrl = `${cleanBase}${subpath === '/' ? '/health' : subpath}${incomingUrl.search}`

  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

  const upstreamToken =
    options.upstreamToken ??
    process.env.ANTIGRAVITY_UPSTREAM_TOKEN ??
    process.env.ANTIGRAVITY_PASCAL_BRIDGE_TOKEN
  if (upstreamToken) {
    headers.set('authorization', `Bearer ${upstreamToken}`)
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  let upstreamRes: Response
  try {
    upstreamRes = await fetchImpl(targetUrl, init)
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: `Upstream Antigravity bridge unreachable (${cleanBase}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      502,
      cors,
    )
  }

  const outHeaders = new Headers()
  const passthrough = ['content-type', 'cache-control', 'x-accel-buffering']
  for (const key of passthrough) {
    const val = upstreamRes.headers.get(key)
    if (val) outHeaders.set(key, val)
  }
  for (const [key, val] of Object.entries(cors)) {
    outHeaders.set(key, val)
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: outHeaders,
  })
}

const STANDALONE_UI_HTML = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Antigravity × Pascal MCP</title>
  <style>
    :root { color-scheme: dark; --bg:#0d0f12; --panel:#14181f; --border:#252c38; --fg:#e8edf5; --muted:#8b95a7; --accent:#10b981; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); background:var(--panel); }
    .badge { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--border); color:var(--muted); }
    .badge.ok { border-color:rgba(16,185,129,.45); color:#34d399; }
    main { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; max-width:900px; width:100%; margin:0 auto; }
    .msg { padding:10px 14px; border-radius:14px; font-size:14px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
    .msg.user { align-self:flex-end; background:#1f2937; max-width:80%; }
    .msg.assistant { align-self:flex-start; background:var(--panel); border:1px solid var(--border); width:100%; }
    .tool { font-family: ui-monospace, monospace; font-size:12px; background:#0b0d10; border:1px solid var(--border); border-radius:8px; padding:6px 10px; margin-bottom:6px; color:#a7f3d0; }
    footer { border-top:1px solid var(--border); background:var(--panel); padding:12px 16px; }
    form { max-width:900px; margin:0 auto; display:flex; gap:8px; }
    input, textarea, button { font:inherit; color:var(--fg); background:#0d0f12; border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
    textarea { flex:1; resize:none; min-height:44px; max-height:140px; }
    button { background:#e8edf5; color:#0d0f12; font-weight:600; cursor:pointer; }
    button:disabled { opacity:.4; cursor:default; }
    .controls { display:flex; gap:8px; align-items:center; }
    .controls input { padding:5px 8px; font-size:12px; width:180px; }
  </style>
</head>
<body>
  <header>
    <div><strong>Antigravity × Pascal MCP</strong> <span id="status" class="badge">Vérification…</span></div>
    <div class="controls">
      <input id="sceneId" placeholder="Scene ID (optionnel)" />
      <input id="token" type="password" placeholder="Bearer token (si requis)" />
      <button id="newBtn" type="button" style="background:transparent;color:var(--fg);padding:5px 10px;font-size:12px;">Nouveau</button>
    </div>
  </header>
  <main id="log"></main>
  <footer>
    <form id="form">
      <textarea id="prompt" rows="2" placeholder="Demande à Antigravity de créer ou modifier une scène via le MCP pascal…"></textarea>
      <button id="sendBtn" type="submit">Envoyer</button>
    </form>
  </footer>
  <script>
    const log = document.getElementById('log');
    const statusEl = document.getElementById('status');
    const promptEl = document.getElementById('prompt');
    const sceneEl = document.getElementById('sceneId');
    const tokenEl = document.getElementById('token');
    const sendBtn = document.getElementById('sendBtn');
    let sessionId = 'ui-' + Math.random().toString(36).slice(2);
    let conversationId = null;

    function authHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (tokenEl.value.trim()) h['Authorization'] = 'Bearer ' + tokenEl.value.trim();
      return h;
    }

    async function checkHealth() {
      try {
        const res = await fetch('/health', { headers: authHeaders() });
        const d = await res.json();
        statusEl.textContent = d.ok ? (d.mcp?.pascalConfigured ? 'MCP Pascal OK' : 'CLI OK') : 'Erreur';
        statusEl.className = 'badge ' + (d.ok ? 'ok' : '');
      } catch {
        statusEl.textContent = 'Hors ligne';
      }
    }
    checkHealth();

    document.getElementById('newBtn').onclick = () => {
      fetch('/reset', { method:'POST', headers:authHeaders(), body:JSON.stringify({ sessionId }) }).catch(()=>{});
      sessionId = 'ui-' + Math.random().toString(36).slice(2);
      conversationId = null;
      log.innerHTML = '';
    };

    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const text = promptEl.value.trim();
      if (!text) return;
      promptEl.value = '';
      sendBtn.disabled = true;

      const u = document.createElement('div');
      u.className = 'msg user';
      u.textContent = text;
      log.appendChild(u);

      const a = document.createElement('div');
      a.className = 'msg assistant';
      const toolsBox = document.createElement('div');
      const textBox = document.createElement('div');
      a.appendChild(toolsBox);
      a.appendChild(textBox);
      log.appendChild(a);
      log.scrollTop = log.scrollHeight;

      const toolNodes = new Map();
      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            sessionId,
            conversationId,
            prompt: text,
            skipPermissions: true,
            sceneContext: sceneEl.value.trim() ? {
              sceneId: sceneEl.value.trim(),
              pathname: '/project/' + sceneEl.value.trim(),
              nodeCount: 0, wallCount: 0, zones: [], selectedNodeIds: [], activeLevelId: null
            } : null
          })
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\\n\\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block.split(/\\r?\\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\\n');
            if (!data) continue;
            const ev = JSON.parse(data);
            if (ev.type === 'init' && ev.conversationId) conversationId = ev.conversationId;
            if (ev.type === 'text_delta') textBox.textContent += ev.text;
            if (ev.type === 'tool_update') {
              let el = toolNodes.get(ev.tool.id);
              if (!el) { el = document.createElement('div'); el.className = 'tool'; toolsBox.appendChild(el); toolNodes.set(ev.tool.id, el); }
              el.textContent = (ev.tool.state === 'done' ? '✓ ' : ev.tool.state === 'error' ? '✕ ' : '● ') + ev.tool.name;
            }
            if (ev.type === 'error') textBox.textContent += '\\n[Erreur] ' + ev.message;
            log.scrollTop = log.scrollHeight;
          }
        }
      } catch (err) {
        textBox.textContent = '[Erreur] ' + err.message;
      } finally {
        sendBtn.disabled = false;
      }
    };
  </script>
</body>
</html>`

/**
 * Web Fetch standard handler for Pascal's Next.js route
 * (`/api/plugins/antigravity/[...path]`) AND the standalone local bridge server.
 */
export async function handleAntigravityPascalRequest(
  request: Request,
  options: AntigravityServerOptions = {},
): Promise<Response> {
  const cors = corsHeaders(request, options.corsOrigin ?? process.env.ANTIGRAVITY_BRIDGE_CORS_ORIGIN)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  const subpath = extractSubpath(request)

  // Standalone browser chat UI served by the bridge container on GET /ui
  if (request.method === 'GET' && subpath === '/ui') {
    return new Response(STANDALONE_UI_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  const upstreamUrl = options.upstreamUrl ?? process.env.ANTIGRAVITY_UPSTREAM_URL
  if (upstreamUrl) {
    return proxyToUpstream(request, subpath, upstreamUrl, options, cors)
  }

  const requiredToken = options.authToken ?? process.env.ANTIGRAVITY_PASCAL_BRIDGE_TOKEN
  if (!authorizeRequest(request, requiredToken)) {
    return jsonResponse({ ok: false, error: 'Unauthorized: invalid or missing Bearer token.' }, 401, cors)
  }

  const manager = options.sessionManager ?? getSharedAntigravitySessionManager(options)
  const authManager = options.authManager ?? getSharedAntigravityAuthManager(options)
  const healthCheck = options.healthCheck ?? checkAntigravityHealth
  const modelsList = options.modelsList ?? listAntigravityModels

  if (request.method === 'GET' && (subpath === '/health' || subpath === '/')) {
    const health = await healthCheck(options)
    return jsonResponse(health, 200, cors)
  }

  if (request.method === 'GET' && subpath === '/diag') {
    const fs = await import('node:fs')
    const pathMod = await import('node:path')
    const { execFile, spawn } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const appData = options.appDataDir ?? process.env.ANTIGRAVITY_PASCAL_APP_DATA_DIR ?? ''
    const geminiHome = options.geminiHome ?? process.env.ANTIGRAVITY_PASCAL_GEMINI_HOME ?? ''
    const hasOAuthTokenFile = appData ? fs.existsSync(pathMod.join(appData, 'antigravity-oauth-token')) : false
    const listNames = (dir: string) => (dir && fs.existsSync(dir) ? fs.readdirSync(dir) : [])

    let agyVersion = ''
    try {
      const { stdout } = await execFileAsync('/usr/local/bin/agy', ['--version'], { timeout: 5000 })
      agyVersion = stdout.trim()
    } catch (e) {
      agyVersion = e instanceof Error ? e.message : String(e)
    }

    let googleReachable = ''
    try {
      const r = await fetch('https://accounts.google.com', { method: 'HEAD', signal: AbortSignal.timeout(4000) })
      googleReachable = `HTTP ${r.status}`
    } catch (e) {
      googleReachable = e instanceof Error ? e.message : String(e)
    }

    const emptyGemini = '/tmp/diag-empty-gemini'
    fs.mkdirSync(pathMod.join(emptyGemini, 'config'), { recursive: true })
    const cleanHome = '/tmp/diag-clean-home'
    fs.mkdirSync(pathMod.join(cleanHome, '.config', 'antigravity'), { recursive: true })
    try {
      if (fs.existsSync('/root/.config/antigravity/plugin-secrets.json')) {
        fs.copyFileSync('/root/.config/antigravity/plugin-secrets.json', pathMod.join(cleanHome, '.config', 'antigravity', 'plugin-secrets.json'))
      }
      if (fs.existsSync('/root/.gemini/antigravity-cli')) {
        fs.cpSync('/root/.gemini/antigravity-cli', pathMod.join(cleanHome, '.gemini', 'antigravity-cli'), { recursive: true })
      }
    } catch {}

    const runTest = (label: string, args: string[], writeStdin?: string, endStdin = false) =>
      new Promise<{ label: string; stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const c = spawn('/usr/local/bin/agy', args, {
          cwd: '/app',
          env: { ...process.env, HOME: cleanHome, GEMINI_HOME: pathMod.join(cleanHome, '.gemini'), ANTIGRAVITY_APP_DATA_DIR: appData || '/tmp/diag-empty-app', AGY_ACP_FORCE_FILE_STORAGE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        c.stdout.on('data', (d) => { stdout += d.toString() })
        c.stderr.on('data', (d) => { stderr += d.toString() })
        const t = setTimeout(() => {
          timedOut = true
          c.kill('SIGQUIT')
          setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 1000)
        }, 12000)
        c.once('exit', (code) => { clearTimeout(t); resolve({ label, stdout, stderr, code, timedOut }) })
        if (writeStdin) c.stdin.write(writeStdin)
        if (endStdin) c.stdin.end()
      })

    const diagLogPath = '/tmp/agy-diag.log'
    try { fs.rmSync(diagLogPath, { force: true }) } catch {}

    const testPromptFlag = await runTest(
      'prompt-flag-no-mcp',
      ['-p', 'OK', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash-low', '--log-file', diagLogPath],
      undefined,
      true,
    )

    return jsonResponse({
      ok: true,
      agyVersion,
      testPromptFlag,
    }, 200, cors)
  }

  if (request.method === 'GET' && subpath === '/models') {
    const result = await modelsList(options)
    return jsonResponse(result, 200, cors)
  }

  if (request.method === 'POST' && subpath === '/auth/start') {
    const result = await authManager.start()
    return jsonResponse(result, result.ok ? 200 : 500, cors)
  }

  if (request.method === 'POST' && subpath === '/auth/complete') {
    const body = (await request.json().catch(() => ({}))) as { authId?: string; code?: string }
    if (!body.authId || !body.code) {
      return jsonResponse({ ok: false, error: 'authId and code are required.' }, 400, cors)
    }
    const result = await authManager.complete(body.authId, body.code)
    return jsonResponse(result, result.ok ? 200 : 400, cors)
  }

  if (request.method === 'POST' && subpath === '/auth/cancel') {
    const body = (await request.json().catch(() => ({}))) as { authId?: string }
    authManager.cancel(body.authId)
    return jsonResponse({ ok: true }, 200, cors)
  }

  if (request.method === 'GET' && subpath === '/session') {
    const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim()
    if (!sessionId) {
      return jsonResponse({ ok: false, error: 'sessionId query parameter is required.' }, 400, cors)
    }
    const snapshot =
      typeof manager.getSessionSnapshot === 'function'
        ? manager.getSessionSnapshot(sessionId)
        : { ok: true, sessionId, conversationId: null, isStreaming: false, messages: [] }
    return jsonResponse(snapshot, 200, cors)
  }

  if (request.method === 'GET' && subpath === '/events') {
    const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim()
    if (!sessionId) {
      return jsonResponse({ ok: false, error: 'sessionId query parameter is required.' }, 400, cors)
    }

    let unsubscribe: () => void = () => undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        let closed = false
        const closeStream = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          try {
            controller.close()
          } catch {
            // Stream already closed by client.
          }
        }
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return
          try {
            controller.enqueue(chunk)
          } catch {
            closeStream()
          }
        }
        const heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(': keepalive\n\n'))
        }, 15_000)

        request.signal?.addEventListener('abort', closeStream, { once: true })

        if (typeof manager.subscribeSession === 'function') {
          unsubscribe = manager.subscribeSession(sessionId, (event) => {
            safeEnqueue(encodeSseEvent(event))
            if (event.type === 'done') {
              closeStream()
            }
          })
        } else {
          safeEnqueue(
            encodeSseEvent({
              type: 'snapshot',
              sessionId,
              conversationId: null,
              isStreaming: false,
              messages: [],
            }),
          )
          safeEnqueue(encodeSseEvent({ type: 'done' }))
          closeStream()
        }
      },
      cancel() {
        unsubscribe()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...cors,
      },
    })
  }

  if (request.method === 'POST' && subpath === '/abort') {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: string }
    if (!body.sessionId) {
      return jsonResponse({ ok: false, error: 'sessionId is required.' }, 400, cors)
    }
    const aborted = manager.abortSession(body.sessionId)
    return jsonResponse({ ok: true, aborted }, 200, cors)
  }

  if (request.method === 'POST' && subpath === '/reset') {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: string }
    if (!body.sessionId) {
      return jsonResponse({ ok: false, error: 'sessionId is required.' }, 400, cors)
    }
    const disposed = manager.disposeSession(body.sessionId)
    return jsonResponse({ ok: true, disposed }, 200, cors)
  }

  if (request.method === 'POST' && subpath === '/chat') {
    let payload: ChatRequestPayload
    try {
      payload = (await request.json()) as ChatRequestPayload
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON request body.' }, 400, cors)
    }

    if (!payload?.sessionId || typeof payload.sessionId !== 'string') {
      return jsonResponse({ ok: false, error: 'sessionId is required.' }, 400, cors)
    }
    const hasPrompt = typeof payload?.prompt === 'string' && payload.prompt.trim().length > 0
    const hasAttachments = Array.isArray(payload?.attachments) && payload.attachments.length > 0
    if (!hasPrompt && !hasAttachments) {
      return jsonResponse({ ok: false, error: 'prompt or attachments are required.' }, 400, cors)
    }

    // Detached execution path: closing the browser tab only unsubscribes the SSE
    // stream while Antigravity keeps running in the background.
    if (typeof manager.startTurn === 'function') {
      let unsubscribe: () => void = () => undefined
      let turnHandle: { unsubscribe: () => void; done: Promise<void> }
      try {
        // Start turn before creating stream so synchronous validation errors return HTTP 409/400.
        const buffered: AntigravitySseEvent[] = []
        let forward: ((event: AntigravitySseEvent) => void) | null = null
        turnHandle = manager.startTurn(payload, (event) => {
          if (forward) {
            forward(event)
          } else {
            buffered.push(event)
          }
        })
        unsubscribe = turnHandle.unsubscribe

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            let closed = false
            const closeStream = () => {
              if (closed) return
              closed = true
              clearInterval(heartbeat)
              unsubscribe()
              try {
                controller.close()
              } catch {
                // Stream already closed by client.
              }
            }
            const safeEnqueue = (chunk: Uint8Array) => {
              if (closed) return
              try {
                controller.enqueue(chunk)
              } catch {
                closeStream()
              }
            }
            const heartbeat = setInterval(() => {
              safeEnqueue(encoder.encode(': keepalive\n\n'))
            }, 15_000)

            request.signal?.addEventListener('abort', closeStream, { once: true })

            const emitEvent = (event: AntigravitySseEvent) => {
              safeEnqueue(encodeSseEvent(event))
              if (event.type === 'done') {
                closeStream()
              }
            }
            forward = emitEvent
            for (const ev of buffered) {
              emitEvent(ev)
            }
            buffered.length = 0
          },
          cancel() {
            unsubscribe()
          },
        })

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...cors,
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to start Antigravity turn.'
        return jsonResponse({ ok: false, error: message }, 409, cors)
      }
    }

    const abortController = new AbortController()
    request.signal?.addEventListener('abort', () => abortController.abort(), { once: true })

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        let closed = false
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return
          try {
            controller.enqueue(chunk)
          } catch {
            closed = true
          }
        }

        const heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(': keepalive\n\n'))
        }, 15_000)

        try {
          await manager.runTurn(
            payload,
            (event) => safeEnqueue(encodeSseEvent(event)),
            abortController.signal,
          )
          safeEnqueue(encodeSseEvent({ type: 'done' }))
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Antigravity turn failed.'
          safeEnqueue(encodeSseEvent({ type: 'error', message }))
          safeEnqueue(encodeSseEvent({ type: 'done' }))
        } finally {
          clearInterval(heartbeat)
          if (!closed) {
            closed = true
            try {
              controller.close()
            } catch {
              // Stream already closed by client.
            }
          }
        }
      },
      cancel() {
        abortController.abort()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...cors,
      },
    })
  }

  return jsonResponse({ ok: false, error: `Unknown Antigravity plugin route: ${subpath}` }, 404, cors)
}

export {
  AntigravityAuthManager,
  AntigravitySessionManager,
  buildChildEnv,
  checkAntigravityHealth,
  getSharedAntigravityAuthManager,
  getSharedAntigravitySessionManager,
  listAntigravityModels,
  resolveAntigravityBinary,
  type AntigravityRunnerOptions,
} from './antigravity-runner.ts'
export {
  canonicalToolBaseName,
  isAuthenticationError,
  isPascalMcpTool,
  isPascalMutatingTool,
  parseAntigravityStreamLine,
} from './stream-parser.ts'

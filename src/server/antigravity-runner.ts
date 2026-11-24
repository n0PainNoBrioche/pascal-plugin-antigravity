import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  buildSceneContextPromptPrefix,
  type SavedAttachmentRef,
} from '../scene-prompt.ts'
import type {
  AntigravityAuthCompleteResponse,
  AntigravityAuthStartResponse,
  AntigravityEffort,
  AntigravityHealthResponse,
  AntigravityModelsResponse,
  AntigravitySseEvent,
  ChatAttachmentInput,
  ChatRequestPayload,
} from '../types.ts'
import { isAuthenticationError, parseAntigravityStreamLine } from './stream-parser.ts'

const ALLOWED_ATTACHMENT_MIME_TYPES = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
])
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 6
const MODEL_EFFORT_SUFFIX_RE = /-(?:low|medium|high|xhigh|max)$/i

export function modelEncodesEffort(model: string): boolean {
  return MODEL_EFFORT_SUFFIX_RE.test(model.trim())
}

export function resolveArchitecteSkillPath(options: AntigravityRunnerOptions = {}): string | null {
  const geminiHome =
    options.geminiHome ??
    process.env.ANTIGRAVITY_PASCAL_GEMINI_HOME ??
    path.join(homedir(), '.gemini')
  const candidates = [
    path.join(geminiHome, 'config', 'skills', 'architecte', 'SKILL.md'),
    path.join(homedir(), '.agents', 'skills', 'architecte', 'SKILL.md'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function persistChatAttachments(
  attachments: ChatAttachmentInput[] | undefined,
  cwd: string,
): SavedAttachmentRef[] {
  if (!attachments || attachments.length === 0) return []
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} fichiers par message.`)
  }

  const uploadsDir = path.join(cwd, '.pascal-chat-uploads')
  mkdirSync(uploadsDir, { recursive: true })

  const saved: SavedAttachmentRef[] = []
  for (const item of attachments) {
    const mime = (item.mimeType || '').toLowerCase().trim()
    const ext = ALLOWED_ATTACHMENT_MIME_TYPES.get(mime)
    if (!ext) {
      throw new Error(`Type de fichier non supporté : ${mime || 'inconnu'} (PNG, JPG, WebP, GIF, PDF uniquement).`)
    }

    const rawBase64 = item.dataBase64.replace(/^data:[^;]+;base64,/, '').trim()
    const buffer = Buffer.from(rawBase64, 'base64')
    if (buffer.byteLength === 0) {
      throw new Error(`Fichier vide : ${item.name}`)
    }
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Fichier trop volumineux (${item.name}, max 15 Mo).`)
    }

    const safeStem =
      path
        .basename(item.name || 'image', path.extname(item.name || ''))
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(0, 48) || 'image'
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeStem}${ext}`
    const absolutePath = path.join(uploadsDir, filename)
    writeFileSync(absolutePath, buffer)

    saved.push({
      name: item.name || filename,
      mimeType: mime,
      absolutePath,
    })
  }

  return saved
}

const execFileAsync = promisify(execFile)

export interface AntigravityRunnerOptions {
  binaryPath?: string
  cwd?: string
  appDataDir?: string
  geminiHome?: string
  idleTimeoutMs?: number
}

interface ActiveTurn {
  activeSceneId: string | null
  emit: (event: AntigravitySseEvent) => void
  resolve: () => void
  reject: (error: Error) => void
  sawTextDelta: boolean
}

interface PersistentSession {
  sessionId: string
  child: ChildProcessWithoutNullStreams
  conversationId: string | null
  model: string
  effort: AntigravityEffort | ''
  skipPermissions: boolean
  turnsSent: number
  stdoutBuffer: string
  stderrLines: string[]
  activeTurn: ActiveTurn | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the Antigravity CLI binary in order:
 * 1. Explicit option or `ANTIGRAVITY_BIN` env var
 * 2. `agy` or `antigravity` on `PATH`
 * 3. T3 Code's managed binary under `~/.t3/tools/antigravity-acp/<platform>/versions/.../antigravity`
 */
export function resolveAntigravityBinary(explicitPath?: string): string | null {
  const configured = explicitPath ?? process.env.ANTIGRAVITY_BIN
  if (configured && isExecutableFile(configured)) {
    return configured
  }

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const binName of ['agy', 'antigravity']) {
    for (const dir of pathDirs) {
      const candidate = path.join(/* turbopackIgnore: true */ dir, binName)
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }

  const home = homedir()
  const platformKey = `${process.platform}-${process.arch}`
  const t3Base = path.join(home, '.t3', 'tools', 'antigravity-acp', platformKey)

  try {
    const activeJsonPath = path.join(t3Base, 'active.json')
    if (existsSync(activeJsonPath)) {
      const parsed = JSON.parse(readFileSync(activeJsonPath, 'utf8')) as { releaseId?: string }
      if (parsed.releaseId) {
        const candidate = path.join(t3Base, 'versions', parsed.releaseId, 'antigravity')
        if (isExecutableFile(candidate)) return candidate
      }
    }
  } catch {
    // Fall through to scanning versions directory.
  }

  try {
    const versionsDir = path.join(t3Base, 'versions')
    if (existsSync(versionsDir)) {
      for (const entry of readdirSync(versionsDir)) {
        const candidate = path.join(versionsDir, entry, 'antigravity')
        if (isExecutableFile(candidate)) return candidate
      }
    }
  } catch {
    // Ignore filesystem errors.
  }

  return null
}

/**
 * Builds a clean environment for spawning Antigravity without leaking outer
 * parent-session variables (such as T3 Code's active LS socket) that could
 * conflict with a standalone session.
 */
export function buildChildEnv(options: AntigravityRunnerOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }

  // Strip outer session coupling variables unless explicitly kept.
  delete env.ANTIGRAVITY_LS_ADDRESS
  delete env.ANTIGRAVITY_CSRF_TOKEN
  delete env.ANTIGRAVITY_CONVERSATION_ID
  delete env.ANTIGRAVITY_TRAJECTORY_ID
  delete env.ANTIGRAVITY_SOURCE_METADATA
  delete env.ANTIGRAVITY_PROJECT_ID

  const appDataDir = options.appDataDir ?? process.env.ANTIGRAVITY_PASCAL_APP_DATA_DIR
  if (appDataDir) {
    env.ANTIGRAVITY_APP_DATA_DIR = appDataDir
  } else {
    delete env.ANTIGRAVITY_APP_DATA_DIR
  }

  const geminiHome = options.geminiHome ?? process.env.ANTIGRAVITY_PASCAL_GEMINI_HOME
  if (geminiHome) {
    env.GEMINI_HOME = geminiHome
  }

  return env
}

export async function checkAntigravityHealth(
  options: AntigravityRunnerOptions = {},
): Promise<AntigravityHealthResponse> {
  const cwd = options.cwd ?? process.env.ANTIGRAVITY_CWD ?? process.cwd()
  const binaryPath = resolveAntigravityBinary(options.binaryPath)
  const env = buildChildEnv(options)

  const mcpServers: Array<{ name: string; type: string; status: string }> = []
  let pascalConfigured = false
  let pascalRunning: boolean | null = null
  let pascalPort: number | null = null
  let error: string | undefined

  if (binaryPath) {
    try {
      const { stdout } = await execFileAsync(binaryPath, ['mcp', 'list'], {
        cwd,
        env,
        timeout: 8_000,
      })
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('NAME')) continue
        const parts = line.split(/\s{2,}/)
        if (parts.length >= 3) {
          const server = {
            name: parts[0] ?? '',
            type: parts[1] ?? '',
            status: parts[2] ?? '',
          }
          mcpServers.push(server)
          if (server.name.toLowerCase() === 'pascal' && server.status.toLowerCase() === 'enabled') {
            pascalConfigured = true
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to inspect Antigravity MCP servers.'
    }
  } else {
    error =
      'Antigravity CLI binary not found. Install `agy` or set ANTIGRAVITY_BIN in your environment.'
  }

  try {
    const { stdout } = await execFileAsync('pascal', ['mcp', 'status', '--json'], {
      cwd,
      env,
      timeout: 5_000,
    })
    const status = JSON.parse(stdout) as { running?: boolean; healthy?: boolean; port?: number }
    pascalRunning = Boolean(status.running && status.healthy !== false)
    pascalPort = typeof status.port === 'number' ? status.port : null
  } catch {
    pascalRunning = null
  }

  return {
    ok: Boolean(binaryPath),
    binaryFound: Boolean(binaryPath),
    binaryPath,
    mcp: {
      pascalConfigured,
      pascalRunning,
      pascalPort,
      servers: mcpServers,
    },
    cwd,
    error,
  }
}

export async function listAntigravityModels(
  options: AntigravityRunnerOptions = {},
): Promise<AntigravityModelsResponse> {
  const binaryPath = resolveAntigravityBinary(options.binaryPath)
  if (!binaryPath) {
    return {
      ok: false,
      models: [],
      error: 'Antigravity CLI binary not found.',
    }
  }

  const cwd = options.cwd ?? process.env.ANTIGRAVITY_CWD ?? process.cwd()
  const env = buildChildEnv(options)

  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['models'], {
      cwd,
      env,
      timeout: 12_000,
    })
    const combined = `${stdout}\n${stderr}`
    if (isAuthenticationError(combined)) {
      return {
        ok: false,
        models: [],
        authRequired: true,
        error: 'Antigravity CLI is not signed in. Run the binary once in a terminal to authenticate.',
      }
    }

    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^fetching|^available|^name\s+|^---/i.test(line))
      .map((line) => line.split(/\s+/)[0] ?? '')
      .filter(Boolean)

    return { ok: true, models: Array.from(new Set(models)) }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to query Antigravity models.'
    return {
      ok: false,
      models: [],
      authRequired: isAuthenticationError(message),
      error: message,
    }
  }
}

/**
 * Manages warm streaming Antigravity CLI sessions (`--input-format stream-json
 * --output-format stream-json`) so multi-turn conversations inside Pascal stay
 * fast and retain MCP Pascal context without respawning on every message.
 */
export class AntigravitySessionManager {
  private readonly sessions = new Map<string, PersistentSession>()
  private readonly options: AntigravityRunnerOptions
  private readonly idleTimeoutMs: number

  constructor(options: AntigravityRunnerOptions = {}) {
    this.options = options
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60 * 1000
  }

  private scheduleIdleCleanup(session: PersistentSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (!session.activeTurn) {
        this.disposeSession(session.sessionId)
      }
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private spawnSession(payload: ChatRequestPayload): PersistentSession {
    const binaryPath = resolveAntigravityBinary(this.options.binaryPath)
    if (!binaryPath) {
      throw new Error(
        'Antigravity CLI binary not found. Install `agy` or set ANTIGRAVITY_BIN in your environment.',
      )
    }

    const model = (payload.model ?? '').trim()
    // Many Antigravity models already encode their effort level in the model ID
    // (e.g. `gemini-4-neon-medium`). Passing `--effort` alongside them causes a CLI conflict.
    const effort: AntigravityEffort | '' =
      model && modelEncodesEffort(model) ? '' : (payload.effort ?? '')
    const skipPermissions = payload.skipPermissions ?? true

    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json']
    if (skipPermissions) {
      args.push('--dangerously-skip-permissions')
    }
    if (model) {
      args.push('--model', model)
    }
    if (effort) {
      args.push('--effort', effort)
    }
    if (payload.conversationId) {
      args.push('--conversation', payload.conversationId)
    }

    const cwd = this.options.cwd ?? process.env.ANTIGRAVITY_CWD ?? process.cwd()
    const child = spawn(/* turbopackIgnore: true */ binaryPath, args, {
      cwd,
      env: buildChildEnv(this.options),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session: PersistentSession = {
      sessionId: payload.sessionId,
      child,
      conversationId: payload.conversationId ?? null,
      model,
      effort,
      skipPermissions,
      turnsSent: 0,
      stdoutBuffer: '',
      stderrLines: [],
      activeTurn: null,
      idleTimer: null,
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      session.stdoutBuffer += chunk
      let newlineIdx = session.stdoutBuffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = session.stdoutBuffer.slice(0, newlineIdx)
        session.stdoutBuffer = session.stdoutBuffer.slice(newlineIdx + 1)
        this.handleStdoutLine(session, line)
        newlineIdx = session.stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const lines = chunk
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      for (const line of lines) {
        session.stderrLines.push(line)
        if (session.stderrLines.length > 40) {
          session.stderrLines.shift()
        }
      }
    })

    child.on('error', (err) => {
      const turn = session.activeTurn
      session.activeTurn = null
      this.sessions.delete(session.sessionId)
      if (turn) {
        turn.emit({ type: 'error', message: err.message })
        turn.reject(err)
      }
    })

    child.on('exit', (code, signal) => {
      if (session.idleTimer) clearTimeout(session.idleTimer)
      const turn = session.activeTurn
      session.activeTurn = null
      if (this.sessions.get(session.sessionId) === session) {
        this.sessions.delete(session.sessionId)
      }

      if (turn) {
        const stderrTail = session.stderrLines.slice(-6).join('\n').trim()
        const detail =
          stderrTail ||
          `Antigravity process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`
        const authRequired = isAuthenticationError(detail)
        turn.emit({
          type: 'error',
          message: authRequired
            ? `${detail}\n\nConnecte-toi une fois dans un terminal avec \`${binaryPath}\` (ou configure ANTIGRAVITY_PASCAL_APP_DATA_DIR).`
            : detail,
          authRequired,
        })
        turn.resolve()
      }
    })

    this.sessions.set(payload.sessionId, session)
    return session
  }

  private handleStdoutLine(session: PersistentSession, line: string): void {
    const turn = session.activeTurn
    const events = parseAntigravityStreamLine(line, turn?.activeSceneId)
    for (const event of events) {
      if (event.type === 'init' && event.conversationId) {
        session.conversationId = event.conversationId
      }
      if (event.type === 'result' && event.conversationId) {
        session.conversationId = event.conversationId
      }
      if (!turn) continue

      if (event.type === 'text_delta') {
        turn.sawTextDelta = true
      }

      if (event.type === 'result') {
        // Fallback: if the CLI didn't emit incremental text_delta chunks before
        // the final result, emit the complete response text so the UI always shows it.
        if (!turn.sawTextDelta && event.response) {
          turn.emit({ type: 'text_delta', text: event.response })
        }
        turn.emit(event)
        session.activeTurn = null
        this.scheduleIdleCleanup(session)
        turn.resolve()
        return
      }

      turn.emit(event)
    }
  }

  async runTurn(
    payload: ChatRequestPayload,
    emit: (event: AntigravitySseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let session = this.sessions.get(payload.sessionId)
    const desiredModel = (payload.model ?? '').trim()
    const desiredEffort: AntigravityEffort | '' =
      desiredModel && modelEncodesEffort(desiredModel) ? '' : (payload.effort ?? '')
    const desiredSkip = payload.skipPermissions ?? true

    // Respawn cleanly if settings changed or previous process exited.
    if (
      session &&
      (session.child.killed ||
        session.child.exitCode !== null ||
        session.model !== desiredModel ||
        session.effort !== desiredEffort ||
        session.skipPermissions !== desiredSkip)
    ) {
      const priorConversation = session.conversationId
      this.disposeSession(payload.sessionId)
      session = this.spawnSession({
        ...payload,
        conversationId: payload.conversationId ?? priorConversation,
      })
    }

    if (!session) {
      session = this.spawnSession(payload)
    }

    if (session.activeTurn) {
      throw new Error('Another turn is already running in this session. Abort it first.')
    }

    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }

    emit({
      type: 'session',
      sessionId: session.sessionId,
      conversationId: session.conversationId,
    })

    const isFirstTurn = session.turnsSent === 0
    const cwd = this.options.cwd ?? process.env.ANTIGRAVITY_CWD ?? process.cwd()
    const savedAttachments = persistChatAttachments(payload.attachments, cwd)
    const useArchitecteSkill = payload.useArchitecteSkill ?? true
    const architecteSkillPath =
      isFirstTurn && useArchitecteSkill ? resolveArchitecteSkillPath(this.options) : null
    const contextPrefix = buildSceneContextPromptPrefix(payload.sceneContext, {
      isFirstTurn,
      useArchitecteSkill,
      architecteSkillPath,
      savedAttachments,
    })
    const promptBody =
      payload.prompt.trim() ||
      (savedAttachments.length > 0
        ? 'Analyse les images jointes et propose les actions adaptées dans Pascal.'
        : '')
    const fullPrompt = `${contextPrefix}${promptBody}`
    session.turnsSent += 1

    const activeSession = session
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.abortSession(activeSession.sessionId)
        resolve()
      }

      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      activeSession.activeTurn = {
        activeSceneId: payload.sceneContext?.sceneId ?? null,
        emit,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
        sawTextDelta: false,
      }

      const wireMessage = JSON.stringify({
        event: 'user',
        message: { content: fullPrompt },
      })

      activeSession.child.stdin.write(`${wireMessage}\n`, (err) => {
        if (err && activeSession.activeTurn) {
          const turn = activeSession.activeTurn
          activeSession.activeTurn = null
          turn.emit({ type: 'error', message: `Failed to send prompt to Antigravity: ${err.message}` })
          turn.reject(err)
        }
      })
    })
  }

  abortSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const turn = session.activeTurn
    session.activeTurn = null
    this.disposeSession(sessionId)
    if (turn) {
      turn.emit({ type: 'error', message: 'Generation stopped by user.' })
      turn.resolve()
    }
    return true
  }

  disposeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.sessions.delete(sessionId)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    try {
      session.child.stdin.end()
    } catch {
      // Ignore already-closed stdin.
    }
    try {
      session.child.kill('SIGTERM')
    } catch {
      // Ignore already-exited child.
    }
    return true
  }

  disposeAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.disposeSession(id)
    }
  }
}

let sharedManager: AntigravitySessionManager | null = null

export function getSharedAntigravitySessionManager(
  options?: AntigravityRunnerOptions,
): AntigravitySessionManager {
  if (!sharedManager) {
    sharedManager = new AntigravitySessionManager(options)
  }
  return sharedManager
}

interface PendingAuthFlow {
  authId: string
  child: ChildProcessWithoutNullStreams
  output: string
  timeout: ReturnType<typeof setTimeout>
}

const OAUTH_URL_REGEX = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/

/**
 * Manages interactive `antigravity acp --login` OAuth sessions so the user can
 * authenticate Antigravity directly from Pascal's sidebar UI without a terminal.
 */
export class AntigravityAuthManager {
  private pending: PendingAuthFlow | null = null
  private readonly options: AntigravityRunnerOptions

  constructor(options: AntigravityRunnerOptions = {}) {
    this.options = options
  }

  cancel(authId?: string): void {
    if (!this.pending) return
    if (authId && this.pending.authId !== authId) return
    const current = this.pending
    this.pending = null
    clearTimeout(current.timeout)
    try {
      current.child.stdin.end()
    } catch {
      // Ignore.
    }
    try {
      current.child.kill('SIGTERM')
    } catch {
      // Ignore.
    }
  }

  async start(): Promise<AntigravityAuthStartResponse> {
    this.cancel()
    const binaryPath = resolveAntigravityBinary(this.options.binaryPath)
    if (!binaryPath) {
      return { ok: false, error: 'Antigravity CLI binary not found.' }
    }

    const cwd = this.options.cwd ?? process.env.ANTIGRAVITY_CWD ?? process.cwd()
    const env = buildChildEnv(this.options)
    if (!env.AGY_ACP_FORCE_FILE_STORAGE) {
      env.AGY_ACP_FORCE_FILE_STORAGE = '1'
    }

    const child = spawn(/* turbopackIgnore: true */ binaryPath, ['acp', '--login'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const authId = randomUUID()
    const flow: PendingAuthFlow = {
      authId,
      child,
      output: '',
      timeout: setTimeout(() => {
        if (this.pending?.authId === authId) {
          this.cancel(authId)
        }
      }, 5 * 60 * 1000),
    }
    flow.timeout.unref?.()
    this.pending = flow

    return await new Promise<AntigravityAuthStartResponse>((resolve) => {
      let settled = false
      const finish = (result: AntigravityAuthStartResponse) => {
        if (settled) return
        settled = true
        clearTimeout(startupTimer)
        resolve(result)
      }

      const startupTimer = setTimeout(() => {
        const tail = flow.output.trim()
        this.cancel(authId)
        finish({
          ok: false,
          error: tail || 'Timed out waiting for Google OAuth URL from Antigravity CLI.',
        })
      }, 12_000)

      const onData = (chunk: Buffer) => {
        flow.output += chunk.toString('utf8')
        const match = OAUTH_URL_REGEX.exec(flow.output)
        if (match?.[0]) {
          finish({ ok: true, authId, authUrl: match[0] })
        }
      }

      child.stdout.on('data', onData)
      child.stderr.on('data', onData)

      child.once('error', (err) => {
        if (this.pending?.authId === authId) this.pending = null
        clearTimeout(flow.timeout)
        finish({ ok: false, error: err.message })
      })

      child.once('exit', (code) => {
        if (this.pending?.authId === authId) {
          this.pending = null
          clearTimeout(flow.timeout)
        }
        if (!settled) {
          const tail = flow.output.trim()
          if (code === 0) {
            finish({ ok: true, authId, authUrl: '' })
          } else {
            finish({
              ok: false,
              error: tail || `Antigravity login exited with code ${code ?? 'unknown'}.`,
            })
          }
        }
      })
    })
  }

  async complete(authId: string, codeOrUrl: string): Promise<AntigravityAuthCompleteResponse> {
    const flow = this.pending
    if (!flow || flow.authId !== authId) {
      return {
        ok: false,
        error: 'Session de connexion expirée ou introuvable. Clique à nouveau sur « Se connecter ».',
      }
    }

    const trimmed = codeOrUrl.trim()
    if (!trimmed) {
      return { ok: false, error: 'Colle le code d’autorisation ou l’URL de redirection.' }
    }

    let extraOutput = ''
    const collect = (chunk: Buffer) => {
      extraOutput += chunk.toString('utf8')
    }
    flow.child.stdout.on('data', collect)
    flow.child.stderr.on('data', collect)

    const exitResult = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.cancel(authId)
        resolve({ code: null, timedOut: true })
      }, 25_000)

      flow.child.once('exit', (code) => {
        clearTimeout(timer)
        if (this.pending?.authId === authId) {
          this.pending = null
          clearTimeout(flow.timeout)
        }
        resolve({ code, timedOut: false })
      })

      try {
        flow.child.stdin.write(`${trimmed}\n`)
        flow.child.stdin.end()
      } catch {
        clearTimeout(timer)
        resolve({ code: 1, timedOut: false })
      }
    })

    if (exitResult.timedOut) {
      return {
        ok: false,
        error: 'La validation du code OAuth a expiré. Réessaie avec un nouveau lien.',
      }
    }

    if (exitResult.code !== 0) {
      const cleanErr = extraOutput.trim() || `Échec de connexion (code ${exitResult.code ?? '?'}).`
      return { ok: false, error: cleanErr }
    }

    // Dispose any stale unauthenticated chat sessions so the next prompt uses the new credentials.
    getSharedAntigravitySessionManager(this.options).disposeAll()

    const modelsRes = await listAntigravityModels(this.options)
    if (!modelsRes.ok && modelsRes.authRequired) {
      return {
        ok: false,
        error:
          extraOutput.trim() ||
          'Le code a été accepté mais la session ne semble pas encore active. Réessaie.',
      }
    }

    return { ok: true, models: modelsRes.models }
  }
}

let sharedAuthManager: AntigravityAuthManager | null = null

export function getSharedAntigravityAuthManager(
  options?: AntigravityRunnerOptions,
): AntigravityAuthManager {
  if (!sharedAuthManager) {
    sharedAuthManager = new AntigravityAuthManager(options)
  }
  return sharedAuthManager
}

#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  getSharedAntigravitySessionManager,
  handleAntigravityPascalRequest,
  resolveAntigravityBinary,
} from '../server/index.ts'

const HOST = process.env.ANTIGRAVITY_BRIDGE_HOST ?? '127.0.0.1'
const PORT = Number.parseInt(process.env.ANTIGRAVITY_BRIDGE_PORT ?? '4319', 10)
const CORS_ORIGIN = process.env.ANTIGRAVITY_BRIDGE_CORS_ORIGIN ?? '*'
const AUTH_TOKEN = process.env.ANTIGRAVITY_PASCAL_BRIDGE_TOKEN

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return undefined
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

async function handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = `http://${req.headers.host ?? `${HOST}:${PORT}`}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })

  const body = await readRequestBody(req)
  const webRequest = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: body ? new Uint8Array(body) : undefined,
    signal: controller.signal,
  })

  const webResponse = await handleAntigravityPascalRequest(webRequest, {
    corsOrigin: CORS_ORIGIN,
    authToken: AUTH_TOKEN,
  })

  const outHeaders: Record<string, string> = {}
  webResponse.headers.forEach((value, key) => {
    outHeaders[key] = value
  })
  res.writeHead(webResponse.status, outHeaders)

  if (!webResponse.body) {
    res.end()
    return
  }

  const nodeStream = Readable.fromWeb(webResponse.body as unknown as import('node:stream/web').ReadableStream)
  nodeStream.on('error', () => {
    if (!res.writableEnded) res.end()
  })
  nodeStream.pipe(res)
}

const server = http.createServer((req, res) => {
  void handleNodeRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'Internal bridge error',
        }),
      )
    } else if (!res.writableEnded) {
      res.end()
    }
  })
})

server.listen(PORT, HOST, () => {
  const binary = resolveAntigravityBinary()
  console.log(`[antigravity-pascal-bridge] listening on http://${HOST}:${PORT}`)
  console.log(`[antigravity-pascal-bridge] binary: ${binary ?? 'NOT FOUND (set ANTIGRAVITY_BIN)'}`)
  console.log(`[antigravity-pascal-bridge] cors: ${CORS_ORIGIN}`)
  console.log(
    `[antigravity-pascal-bridge] auth: ${AUTH_TOKEN ? 'Bearer token enabled' : 'open (loopback)'}`,
  )
})

const shutdown = () => {
  getSharedAntigravitySessionManager().disposeAll()
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

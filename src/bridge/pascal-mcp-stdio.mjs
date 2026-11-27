#!/usr/bin/env node
/**
 * Serializes the MCP stdio initialization handshake in front of `pascal mcp connect`.
 *
 * `@pascal-app/cli`'s `pascal mcp connect` forwards stdin lines over HTTP to a local
 * server and rejects pipelined `notifications/initialized` or `tools/list` requests
 * with `-32000 Server not initialized` if they arrive before the `initialize` response
 * completes. Buffering post-initialize messages until the `initialize` response is
 * emitted avoids the race condition in headless clients like `agy`.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const child = spawn('pascal', ['mcp', 'connect'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
})

let initRequestId = null
let initialized = false
const pendingLines = []

child.stdout.pipe(process.stdout)

const childOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
childOut.on('line', (line) => {
  if (initialized) return
  try {
    const msg = JSON.parse(line)
    if (initRequestId !== null && msg.id === initRequestId && msg.result !== undefined) {
      initialized = true
      setTimeout(() => {
        console.error(`[pascal-mcp-stdio] initialized; flushing ${pendingLines.length} queued message(s)`)
        while (pendingLines.length > 0) {
          child.stdin.write(`${pendingLines.shift()}\n`)
        }
      }, 50)
    }
  } catch {
    // Ignore non-JSON lines.
  }
})

const stdinIn = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
stdinIn.on('line', (line) => {
  if (initialized) {
    child.stdin.write(`${line}\n`)
    return
  }
  try {
    const msg = JSON.parse(line)
    if (msg.method === 'initialize' && msg.id !== undefined) {
      initRequestId = msg.id
      child.stdin.write(`${line}\n`)
      return
    }
  } catch {
    // Fall through to queue.
  }
  pendingLines.push(line)
})

stdinIn.on('close', () => {
  child.stdin.end()
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig)
  })
}

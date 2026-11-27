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
import fs from 'node:fs'
import readline from 'node:readline'

const logWire = (dir, line) => {
  try {
    fs.appendFileSync('/tmp/mcp-wire.log', `${new Date().toISOString()} ${dir} ${line.slice(0, 220)}\n`)
  } catch {}
}

const child = spawn('pascal', ['mcp', 'connect'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

let initRequestId = null
let initialized = false
const pendingLines = []

child.stderr.on('data', (d) => {
  logWire('CHILD_ERR', d.toString().trim())
  process.stderr.write(d)
})

child.stdout.pipe(process.stdout)

const childOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
childOut.on('line', (line) => {
  logWire('CHILD_OUT', line)
  if (initialized) return
  try {
    const msg = JSON.parse(line)
    if (initRequestId !== null && msg.id === initRequestId && msg.result !== undefined) {
      initialized = true
      setTimeout(() => {
        console.error(`[pascal-mcp-stdio] initialized; flushing ${pendingLines.length} queued message(s)`)
        while (pendingLines.length > 0) {
          const q = pendingLines.shift()
          logWire('FLUSH_IN', q)
          child.stdin.write(`${q}\n`)
        }
      }, 50)
    }
  } catch {
    // Ignore non-JSON lines.
  }
})

const stdinIn = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
stdinIn.on('line', (line) => {
  logWire('AGY_IN', line)
  if (initialized) {
    child.stdin.write(`${line}\n`)
    return
  }
  try {
    const msg = JSON.parse(line)
    if (msg.method === 'server/discover' && msg.id !== undefined) {
      // `pascal mcp connect` drops pre-initialize HTTP requests without replying on stdout,
      // which stalls go_sdk/mcp's `(*Client).discover`. Reply -32601 so it falls back to `initialize`.
      const reply = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      })
      logWire('WRAPPER_OUT', reply)
      process.stdout.write(`${reply}\n`)
      return
    }
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

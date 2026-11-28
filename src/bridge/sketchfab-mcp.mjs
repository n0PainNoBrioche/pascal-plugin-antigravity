#!/usr/bin/env node
/**
 * Stdio MCP server exposing Sketchfab's free downloadable 3D model search & GLB URL resolver
 * (`search_sketchfab_models` and `get_sketchfab_glb`) to Antigravity.
 */
import readline from 'node:readline'

const SKETCHFAB_API_BASE = 'https://api.sketchfab.com/v3'

async function searchModels({ query, category, limit }) {
  const params = new URLSearchParams({
    type: 'models',
    downloadable: 'true',
    archives_flavors: 'false',
    sort_by: '-likeCount',
    count: String(Math.min(Math.max(1, Number(limit ?? 12)), 30)),
  })
  if (query && String(query).trim()) params.set('q', String(query).trim())
  if (category && category !== 'all') params.set('categories', String(category))

  const headers = { 'User-Agent': 'pascal-sketchfab-mcp/0.1.0' }
  if (process.env.SKETCHFAB_API_TOKEN?.trim()) {
    headers.Authorization = `Token ${process.env.SKETCHFAB_API_TOKEN.trim()}`
  }

  const res = await fetch(`${SKETCHFAB_API_BASE}/search?${params.toString()}`, { headers })
  if (!res.ok) throw new Error(`Sketchfab search API returned HTTP ${res.status}`)
  const data = await res.json()
  return (data.results ?? []).map((item) => ({
    uid: item.uid,
    name: item.name,
    faceCount: item.faceCount ?? 0,
    categories: (item.categories ?? []).map((c) => c.name ?? c.slug).filter(Boolean),
    license: item.license?.label ?? 'Free',
    viewerUrl: item.viewerUrl,
  }))
}

async function resolveModel(uid) {
  const baseUrl = (process.env.PASCAL_PUBLIC_URL || 'https://archi.brioche.ovh').replace(/\/$/, '')
  const res = await fetch(`${baseUrl}/api/plugins/sketchfab/resolve?uid=${encodeURIComponent(uid)}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Pascal Sketchfab resolve returned HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!data.ok) throw new Error(data.error ?? 'Failed to resolve Sketchfab GLB')
  return {
    uid,
    pascalGlbUrl: `${baseUrl}${data.src}`,
    dimensionsMeters: data.dimensionsMeters ?? [1, 1, 1],
  }
}

const TOOLS = [
  {
    name: 'search_sketchfab_models',
    description:
      'Search free downloadable 3D models on Sketchfab (furniture, architecture, plants, decor). Prefer models with lower faceCount (< 50000) for smooth WebGL performance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search (e.g. "hydrangea", "oak chair", "granite chimney").' },
        category: { type: 'string', description: 'Optional category slug (e.g. "furniture-home", "architecture", "nature-plants").' },
        limit: { type: 'number', description: 'Max results to return (default 12, max 30).' },
      },
    },
  },
  {
    name: 'get_sketchfab_glb',
    description:
      'Download and cache a Sketchfab model as a Pascal-ready GLB URL + exact dimensionsMeters [w, h, d] for placing as a Pascal ItemNode.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Sketchfab model UID (from search_sketchfab_models).' },
      },
      required: ['uid'],
    },
  },
]

function writeReply(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = req
  if (id === undefined) return

  try {
    if (method === 'server/discover') {
      writeReply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    if (method === 'initialize') {
      writeReply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sketchfab-mcp', version: '0.1.0' },
        },
      })
      return
    }
    if (method === 'tools/list') {
      writeReply({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    }
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (name === 'search_sketchfab_models') {
        const models = await searchModels(args)
        writeReply({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify({ count: models.length, models }, null, 2) }] },
        })
        return
      }
      if (name === 'get_sketchfab_glb') {
        const data = await resolveModel(String(args.uid ?? ''))
        writeReply({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
        })
        return
      }
      writeReply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } })
      return
    }
    writeReply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (err) {
    writeReply({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      },
    })
  }
})

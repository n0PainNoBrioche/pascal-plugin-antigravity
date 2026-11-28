#!/usr/bin/env node
/**
 * Lightweight stdio MCP server exposing free CC0 3D models from Poly Haven
 * (`search_polyhaven_models` and `get_polyhaven_glb`) to Antigravity.
 */
import readline from 'node:readline'

const POLYHAVEN_API_BASE = 'https://api.polyhaven.com'
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000

let cachedModels = null

function toMeters(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length < 3) return [1, 1, 1]
  const [x, y, z] = dimensions
  const scale = Math.max(x, y, z) > 25 ? 0.001 : 1
  return [
    Math.max(0.05, Number((x * scale).toFixed(3))),
    Math.max(0.05, Number((z * scale).toFixed(3))),
    Math.max(0.05, Number((y * scale).toFixed(3))),
  ]
}

async function fetchModelsIndex() {
  if (cachedModels && Date.now() - cachedModels.fetchedAt < MODELS_CACHE_TTL_MS) {
    return cachedModels.items
  }
  const res = await fetch(`${POLYHAVEN_API_BASE}/assets?t=models`, {
    headers: { 'User-Agent': 'pascal-polyhaven-mcp/0.1.0' },
  })
  if (!res.ok) throw new Error(`Poly Haven API returned HTTP ${res.status}`)
  const raw = await res.json()
  const items = Object.entries(raw)
    .map(([id, entry]) => ({
      id,
      name: entry.name ?? id,
      description: entry.description ?? '',
      categories: Array.isArray(entry.categories) ? entry.categories : [],
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      thumbnailUrl:
        entry.thumbnail_url ??
        `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(id)}.png?width=256&height=256&format=webp`,
      dimensionsMeters: toMeters(entry.dimensions),
      downloadCount: typeof entry.download_count === 'number' ? entry.download_count : 0,
    }))
    .sort((a, b) => b.downloadCount - a.downloadCount)
  cachedModels = { fetchedAt: Date.now(), items }
  return items
}

async function getModelFiles(assetId, resolution = '1k') {
  const res = await fetch(`${POLYHAVEN_API_BASE}/files/${encodeURIComponent(assetId)}`, {
    headers: { 'User-Agent': 'pascal-polyhaven-mcp/0.1.0' },
  })
  if (!res.ok) throw new Error(`Poly Haven files API returned HTTP ${res.status}`)
  const files = await res.json()
  const gltfMap = files.gltf ?? {}
  const chosenRes = gltfMap[resolution] ? resolution : Object.keys(gltfMap)[0]
  const variant = chosenRes ? gltfMap[chosenRes]?.gltf : undefined
  if (!variant?.url) throw new Error(`No glTF variant found for "${assetId}".`)
  const index = await fetchModelsIndex()
  const meta = index.find((m) => m.id === assetId)
  return {
    id: assetId,
    name: meta?.name ?? assetId,
    categories: meta?.categories ?? [],
    dimensionsMeters: meta?.dimensionsMeters ?? [1, 1, 1],
    thumbnailUrl:
      meta?.thumbnailUrl ??
      `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(assetId)}.png?width=256&height=256&format=webp`,
    resolution: chosenRes,
    gltfUrl: variant.url,
    pascalGlbUrl: `${(process.env.PASCAL_PUBLIC_URL || 'https://archi.brioche.ovh').replace(/\/$/, '')}/api/plugins/polyhaven/glb/${encodeURIComponent(assetId)}.glb?res=${encodeURIComponent(chosenRes)}`,
  }
}

const TOOLS = [
  {
    name: 'search_polyhaven_models',
    description:
      'Search free CC0 3D models on Poly Haven (furniture, plants, trees, rocks, lighting, decor). Returns model IDs, names, categories, dimensions in meters [w, h, d], and thumbnails.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search (e.g. "wooden chair", "plant", "lamp").' },
        category: { type: 'string', description: 'Optional category filter (e.g. "furniture", "nature", "decor").' },
        limit: { type: 'number', description: 'Max results to return (default 12, max 30).' },
      },
    },
  },
  {
    name: 'get_polyhaven_glb',
    description:
      'Resolve a Poly Haven 3D model ID to its Pascal-ready GLB endpoint (/api/plugins/polyhaven/glb/<id>.glb), dimensionsMeters [w, h, d], and thumbnailUrl for placing as a Pascal ItemNode.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Exact Poly Haven model ID (from search_polyhaven_models).' },
        resolution: { type: 'string', description: 'Texture resolution: 1k (default) or 2k.' },
      },
      required: ['assetId'],
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
          serverInfo: { name: 'polyhaven-mcp', version: '0.1.0' },
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
      if (name === 'search_polyhaven_models') {
        const items = await fetchModelsIndex()
        const q = String(args.query ?? '').trim().toLowerCase()
        const cat = String(args.category ?? '').trim().toLowerCase()
        const limit = Math.min(Math.max(1, Number(args.limit ?? 12)), 30)
        const matches = items
          .filter((item) => {
            if (cat && cat !== 'all' && !item.categories.some((c) => c.toLowerCase() === cat)) return false
            if (!q) return true
            const hay = [item.id, item.name, item.description, ...item.categories, ...item.tags].join(' ').toLowerCase()
            return q.split(/\s+/).every((t) => hay.includes(t))
          })
          .slice(0, limit)
        writeReply({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify({ count: matches.length, models: matches }, null, 2) }] },
        })
        return
      }
      if (name === 'get_polyhaven_glb') {
        const data = await getModelFiles(String(args.assetId ?? ''), String(args.resolution ?? '1k'))
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

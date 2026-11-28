import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { packPolyHavenAssetToGlb, searchPolyHavenModels } from './client.ts'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function getGlbCacheDir(): string {
  const base = process.env.PASCAL_DATA_DIR || '/tmp'
  const dir = path.join(base, 'polyhaven-glb')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '')
}

async function loadOrPackGlb(
  assetId: string,
  resolution: string,
): Promise<{ glb: Buffer; dimensionsMeters: [number, number, number] | null }> {
  const safeId = sanitizeId(assetId)
  const safeRes = sanitizeId(resolution) || '1k'
  if (!safeId) {
    throw new Error('Invalid Poly Haven assetId.')
  }

  const cacheDir = getGlbCacheDir()
  const glbPath = path.join(cacheDir, `${safeId}-${safeRes}.glb`)
  const metaPath = path.join(cacheDir, `${safeId}-${safeRes}.json`)

  if (existsSync(glbPath)) {
    const glb = readFileSync(glbPath)
    let dimensionsMeters: [number, number, number] | null = null
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
          dimensionsMeters?: [number, number, number] | null
        }
        dimensionsMeters = meta.dimensionsMeters ?? null
      } catch {
        // Ignore corrupt metadata.
      }
    }
    return { glb, dimensionsMeters }
  }

  const packed = await packPolyHavenAssetToGlb(safeId, safeRes)
  try {
    writeFileSync(glbPath, packed.glb)
    writeFileSync(metaPath, JSON.stringify({ dimensionsMeters: packed.dimensionsMeters }))
  } catch {
    // Non-fatal if cache dir is read-only.
  }
  return packed
}

/**
 * Next.js route handler for `/api/plugins/polyhaven/*`.
 */
export async function handlePolyHavenRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const prefix = '/api/plugins/polyhaven'
  const idx = url.pathname.indexOf(prefix)
  const subpath = idx >= 0 ? url.pathname.slice(idx + prefix.length) || '/' : url.pathname

  try {
    if (request.method === 'GET' && subpath === '/search') {
      const q = url.searchParams.get('q') ?? undefined
      const category = url.searchParams.get('category') ?? undefined
      const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '24', 10)
      const models = await searchPolyHavenModels({
        query: q,
        category,
        limit: Number.isFinite(limitParam) ? limitParam : 24,
      })
      return jsonResponse({ ok: true, models })
    }

    if (request.method === 'GET' && subpath === '/resolve') {
      const id = sanitizeId(url.searchParams.get('id') ?? '')
      const res = sanitizeId(url.searchParams.get('res') ?? '1k') || '1k'
      if (!id) {
        return jsonResponse({ ok: false, error: 'Missing id query parameter.' }, 400)
      }
      const packed = await loadOrPackGlb(id, res)
      return jsonResponse({
        ok: true,
        id,
        src: `/api/plugins/polyhaven/glb/${encodeURIComponent(id)}.glb?res=${encodeURIComponent(res)}`,
        dimensionsMeters: packed.dimensionsMeters,
      })
    }

    if (request.method === 'GET' && subpath.startsWith('/glb/')) {
      const rawName = subpath.slice('/glb/'.length).replace(/\.glb$/i, '')
      const id = sanitizeId(decodeURIComponent(rawName))
      const res = sanitizeId(url.searchParams.get('res') ?? '1k') || '1k'
      if (!id) {
        return new Response('Invalid asset ID', { status: 400 })
      }
      const packed = await loadOrPackGlb(id, res)
      return new Response(new Uint8Array(packed.glb), {
        status: 200,
        headers: {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': String(packed.glb.byteLength),
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    return jsonResponse({ ok: false, error: `Not found: ${subpath}` }, 404)
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Poly Haven proxy error' },
      500,
    )
  }
}

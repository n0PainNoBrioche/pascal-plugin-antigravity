import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { downloadSketchfabGlb, searchSketchfabModels } from './client.ts'

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
  const dir = path.join(base, 'sketchfab-glb')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeUid(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '')
}

async function loadOrDownloadGlb(
  uid: string,
): Promise<{ glb: Buffer; dimensionsMeters: [number, number, number] | null }> {
  const safeUid = sanitizeUid(uid)
  if (!safeUid) {
    throw new Error('Invalid Sketchfab model UID.')
  }

  const cacheDir = getGlbCacheDir()
  const glbPath = path.join(cacheDir, `${safeUid}.glb`)
  const metaPath = path.join(cacheDir, `${safeUid}.json`)

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

  const downloaded = await downloadSketchfabGlb(safeUid)
  try {
    writeFileSync(glbPath, downloaded.glb)
    writeFileSync(metaPath, JSON.stringify({ dimensionsMeters: downloaded.dimensionsMeters }))
  } catch {
    // Non-fatal if cache dir is read-only.
  }
  return downloaded
}

/**
 * Next.js route handler for `/api/plugins/sketchfab/*`.
 */
export async function handleSketchfabRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const prefix = '/api/plugins/sketchfab'
  const idx = url.pathname.indexOf(prefix)
  const subpath = idx >= 0 ? url.pathname.slice(idx + prefix.length) || '/' : url.pathname

  try {
    if (request.method === 'GET' && subpath === '/status') {
      return jsonResponse({
        ok: true,
        tokenConfigured: Boolean(process.env.SKETCHFAB_API_TOKEN?.trim()),
      })
    }

    if (request.method === 'GET' && subpath === '/search') {
      const q = url.searchParams.get('q') ?? undefined
      const category = url.searchParams.get('category') ?? undefined
      const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '24', 10)
      const models = await searchSketchfabModels({
        query: q,
        category,
        limit: Number.isFinite(limitParam) ? limitParam : 24,
      })
      return jsonResponse({ ok: true, models })
    }

    if (request.method === 'GET' && subpath === '/resolve') {
      const uid = sanitizeUid(url.searchParams.get('uid') ?? '')
      if (!uid) {
        return jsonResponse({ ok: false, error: 'Missing uid query parameter.' }, 400)
      }
      const downloaded = await loadOrDownloadGlb(uid)
      return jsonResponse({
        ok: true,
        uid,
        src: `/api/plugins/sketchfab/glb/${encodeURIComponent(uid)}.glb`,
        dimensionsMeters: downloaded.dimensionsMeters,
      })
    }

    if (request.method === 'GET' && subpath.startsWith('/glb/')) {
      const rawName = subpath.slice('/glb/'.length).replace(/\.glb$/i, '')
      const uid = sanitizeUid(decodeURIComponent(rawName))
      if (!uid) {
        return new Response('Invalid model UID', { status: 400 })
      }
      const downloaded = await loadOrDownloadGlb(uid)
      return new Response(new Uint8Array(downloaded.glb), {
        status: 200,
        headers: {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': String(downloaded.glb.byteLength),
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    return jsonResponse({ ok: false, error: `Not found: ${subpath}` }, 404)
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Sketchfab proxy error' },
      500,
    )
  }
}

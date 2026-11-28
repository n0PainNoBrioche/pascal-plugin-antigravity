export interface SketchfabModelSummary {
  uid: string
  name: string
  description: string
  categories: string[]
  tags: string[]
  thumbnailUrl: string
  faceCount: number
  vertexCount: number
  license: string
  author: string
  viewerUrl: string
}

export interface SketchfabSearchOptions {
  query?: string
  category?: string
  limit?: number
  apiToken?: string
}

interface RawSketchfabResult {
  uid?: string
  name?: string
  description?: string
  categories?: Array<{ name?: string; slug?: string }>
  tags?: Array<{ name?: string; slug?: string }>
  thumbnails?: { images?: Array<{ url?: string; width?: number; height?: number }> }
  faceCount?: number
  vertexCount?: number
  license?: { label?: string; slug?: string }
  user?: { displayName?: string; username?: string }
  viewerUrl?: string
}

const SKETCHFAB_API_BASE = 'https://api.sketchfab.com/v3'

function pickThumbnail(images: Array<{ url?: string; width?: number }> | undefined): string {
  if (!Array.isArray(images) || images.length === 0) return ''
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  const medium = sorted.find((img) => (img.width ?? 0) >= 256) ?? sorted[sorted.length - 1]
  return medium?.url ?? ''
}

export async function searchSketchfabModels(
  options: SketchfabSearchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SketchfabModelSummary[]> {
  const params = new URLSearchParams({
    type: 'models',
    downloadable: 'true',
    archives_flavors: 'false',
    sort_by: '-likeCount',
    count: String(Math.min(Math.max(1, options.limit ?? 24), 48)),
  })
  if (options.query?.trim()) {
    params.set('q', options.query.trim())
  }
  if (options.category && options.category !== 'all') {
    params.set('categories', options.category)
  }

  const headers: Record<string, string> = {
    'User-Agent': 'pascal-sketchfab-plugin/0.1.0',
  }
  const token = options.apiToken ?? process.env.SKETCHFAB_API_TOKEN
  if (token?.trim()) {
    headers.Authorization = `Token ${token.trim()}`
  }

  const res = await fetchImpl(`${SKETCHFAB_API_BASE}/search?${params.toString()}`, { headers })
  if (!res.ok) {
    throw new Error(`Sketchfab search API returned HTTP ${res.status}`)
  }

  const data = (await res.json()) as { results?: RawSketchfabResult[] }
  return (data.results ?? [])
    .filter((item): item is RawSketchfabResult & { uid: string } => Boolean(item.uid))
    .map((item) => ({
      uid: item.uid,
      name: item.name ?? item.uid,
      description: item.description ?? '',
      categories: (item.categories ?? []).map((c) => c.name ?? c.slug ?? '').filter(Boolean),
      tags: (item.tags ?? []).map((t) => t.name ?? t.slug ?? '').filter(Boolean),
      thumbnailUrl: pickThumbnail(item.thumbnails?.images),
      faceCount: typeof item.faceCount === 'number' ? item.faceCount : 0,
      vertexCount: typeof item.vertexCount === 'number' ? item.vertexCount : 0,
      license: item.license?.label ?? item.license?.slug ?? 'Free',
      author: item.user?.displayName ?? item.user?.username ?? '',
      viewerUrl: item.viewerUrl ?? `https://sketchfab.com/3d-models/${item.uid}`,
    }))
}

/**
 * Extracts `[width, height, depth]` in meters from a glTF 2.0 binary (`.glb`) buffer
 * by inspecting the POSITION accessor min/max bounds.
 */
export function extractGlbBounds(glb: Buffer): [number, number, number] | null {
  if (glb.byteLength < 20) return null
  if (glb.readUInt32LE(0) !== 0x46546c67) return null // 'glTF'

  const jsonLen = glb.readUInt32LE(12)
  const chunkType = glb.readUInt32LE(16)
  if (chunkType !== 0x4e4f534a || 20 + jsonLen > glb.byteLength) return null // 'JSON'

  try {
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8')) as {
      accessors?: Array<{ min?: number[]; max?: number[] }>
      meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: number } }> }>
    }
    const accessors = gltf.accessors ?? []
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (const mesh of gltf.meshes ?? []) {
      for (const prim of mesh.primitives ?? []) {
        const idx = prim.attributes?.POSITION
        if (typeof idx !== 'number') continue
        const acc = accessors[idx]
        if (acc?.min && acc?.max && acc.min.length >= 3 && acc.max.length >= 3) {
          minX = Math.min(minX, acc.min[0])
          minY = Math.min(minY, acc.min[1])
          minZ = Math.min(minZ, acc.min[2])
          maxX = Math.max(maxX, acc.max[0])
          maxY = Math.max(maxY, acc.max[1])
          maxZ = Math.max(maxZ, acc.max[2])
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
    return [
      Math.max(0.05, Number((maxX - minX).toFixed(3))),
      Math.max(0.05, Number((maxY - minY).toFixed(3))),
      Math.max(0.05, Number((maxZ - minZ).toFixed(3))),
    ]
  } catch {
    return null
  }
}

export async function downloadSketchfabGlb(
  uid: string,
  apiToken?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ glb: Buffer; dimensionsMeters: [number, number, number] | null }> {
  const token = (apiToken ?? process.env.SKETCHFAB_API_TOKEN ?? '').trim()
  if (!token) {
    throw new Error(
      'SKETCHFAB_API_TOKEN manquant sur le serveur. Ajoute ton token Sketchfab dans les variables d’environnement.',
    )
  }

  const metaRes = await fetchImpl(`${SKETCHFAB_API_BASE}/models/${encodeURIComponent(uid)}/download`, {
    headers: {
      Authorization: `Token ${token}`,
      'User-Agent': 'pascal-sketchfab-plugin/0.1.0',
    },
  })
  if (!metaRes.ok) {
    const body = await metaRes.text().catch(() => '')
    throw new Error(
      `Sketchfab download API returned HTTP ${metaRes.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
  }

  const downloadInfo = (await metaRes.json()) as {
    glb?: { url?: string }
  }
  const glbUrl = downloadInfo.glb?.url
  if (!glbUrl) {
    throw new Error(`Ce modèle Sketchfab (${uid}) n’a pas de variante GLB téléchargeable.`)
  }

  const glbRes = await fetchImpl(glbUrl)
  if (!glbRes.ok) {
    throw new Error(`Échec du téléchargement GLB Sketchfab (HTTP ${glbRes.status}).`)
  }
  const glb = Buffer.from(await glbRes.arrayBuffer())
  return { glb, dimensionsMeters: extractGlbBounds(glb) }
}

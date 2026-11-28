export interface PolyHavenModelSummary {
  id: string
  name: string
  description: string
  categories: string[]
  tags: string[]
  thumbnailUrl: string
  /** Approximate [width, height, depth] in meters. */
  dimensionsMeters: [number, number, number]
  polycount: number
  downloadCount: number
}

export interface PolyHavenSearchOptions {
  query?: string
  category?: string
  limit?: number
}

export interface PolyHavenGltfBundle {
  assetId: string
  resolution: string
  gltfUrl: string
  include: Record<string, { url: string; size?: number; md5?: string }>
}

interface RawPolyHavenAsset {
  name?: string
  description?: string
  categories?: string[]
  tags?: string[]
  dimensions?: number[]
  polycount?: number
  download_count?: number
  thumbnail_url?: string
}

const POLYHAVEN_API_BASE = 'https://api.polyhaven.com'
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000

let cachedModels: { fetchedAt: number; items: PolyHavenModelSummary[] } | null = null

function toMeters(dimensions: number[] | undefined): [number, number, number] {
  if (!Array.isArray(dimensions) || dimensions.length < 3) {
    return [1, 1, 1]
  }
  const [x, y, z] = dimensions
  // Poly Haven dimensions are typically in millimeters.
  const scale = Math.max(x, y, z) > 25 ? 0.001 : 1
  return [
    Math.max(0.05, Number((x * scale).toFixed(3))),
    Math.max(0.05, Number((z * scale).toFixed(3))),
    Math.max(0.05, Number((y * scale).toFixed(3))),
  ]
}

export async function fetchPolyHavenModelsIndex(
  fetchImpl: typeof fetch = fetch,
): Promise<PolyHavenModelSummary[]> {
  if (cachedModels && Date.now() - cachedModels.fetchedAt < MODELS_CACHE_TTL_MS) {
    return cachedModels.items
  }

  const res = await fetchImpl(`${POLYHAVEN_API_BASE}/assets?t=models`, {
    headers: { 'User-Agent': 'pascal-polyhaven-plugin/0.1.0' },
  })
  if (!res.ok) {
    throw new Error(`Poly Haven API returned HTTP ${res.status}`)
  }

  const raw = (await res.json()) as Record<string, RawPolyHavenAsset>
  const items: PolyHavenModelSummary[] = Object.entries(raw).map(([id, entry]) => ({
    id,
    name: entry.name ?? id,
    description: entry.description ?? '',
    categories: Array.isArray(entry.categories) ? entry.categories : [],
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    thumbnailUrl:
      entry.thumbnail_url ??
      `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(id)}.png?width=256&height=256&format=webp`,
    dimensionsMeters: toMeters(entry.dimensions),
    polycount: typeof entry.polycount === 'number' ? entry.polycount : 0,
    downloadCount: typeof entry.download_count === 'number' ? entry.download_count : 0,
  }))

  items.sort((a, b) => b.downloadCount - a.downloadCount)
  cachedModels = { fetchedAt: Date.now(), items }
  return items
}

export function filterPolyHavenModels(
  items: PolyHavenModelSummary[],
  options: PolyHavenSearchOptions = {},
): PolyHavenModelSummary[] {
  const q = (options.query ?? '').trim().toLowerCase()
  const cat = (options.category ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(1, options.limit ?? 24), 60)

  const filtered = items.filter((item) => {
    if (cat && cat !== 'all') {
      const hasCat = item.categories.some((c) => c.toLowerCase() === cat)
      if (!hasCat) return false
    }
    if (!q) return true
    const haystack = [item.id, item.name, item.description, ...item.categories, ...item.tags]
      .join(' ')
      .toLowerCase()
    return q.split(/\s+/).every((term) => haystack.includes(term))
  })

  return filtered.slice(0, limit)
}

export async function searchPolyHavenModels(
  options: PolyHavenSearchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<PolyHavenModelSummary[]> {
  const index = await fetchPolyHavenModelsIndex(fetchImpl)
  return filterPolyHavenModels(index, options)
}

export async function getPolyHavenGltfBundle(
  assetId: string,
  resolution = '1k',
  fetchImpl: typeof fetch = fetch,
): Promise<PolyHavenGltfBundle> {
  const res = await fetchImpl(`${POLYHAVEN_API_BASE}/files/${encodeURIComponent(assetId)}`, {
    headers: { 'User-Agent': 'pascal-polyhaven-plugin/0.1.0' },
  })
  if (!res.ok) {
    throw new Error(`Poly Haven files API returned HTTP ${res.status} for ${assetId}`)
  }

  const files = (await res.json()) as {
    gltf?: Record<string, { gltf?: { url?: string; include?: Record<string, { url: string; size?: number; md5?: string }> } }>
  }
  const gltfMap = files.gltf ?? {}
  const chosenRes = gltfMap[resolution] ? resolution : Object.keys(gltfMap)[0]
  const variant = chosenRes ? gltfMap[chosenRes]?.gltf : undefined
  if (!variant?.url) {
    throw new Error(`No glTF variant available on Poly Haven for "${assetId}".`)
  }

  return {
    assetId,
    resolution: chosenRes,
    gltfUrl: variant.url,
    include: variant.include ?? {},
  }
}

function padTo4Bytes(buf: Buffer, padByte = 0x00): Buffer {
  const rem = buf.byteLength % 4
  if (rem === 0) return buf
  const pad = Buffer.alloc(4 - rem, padByte)
  return Buffer.concat([buf, pad])
}

/**
 * Fetches a Poly Haven `.gltf` + `.bin` + textures and packs them into a single
 * self-contained glTF 2.0 binary (`.glb`) buffer.
 */
export async function packPolyHavenAssetToGlb(
  assetId: string,
  resolution = '1k',
  fetchImpl: typeof fetch = fetch,
): Promise<{ glb: Buffer; dimensionsMeters: [number, number, number] | null }> {
  const bundle = await getPolyHavenGltfBundle(assetId, resolution, fetchImpl)
  const gltfRes = await fetchImpl(bundle.gltfUrl)
  if (!gltfRes.ok) {
    throw new Error(`Failed to fetch glTF (${gltfRes.status}) from ${bundle.gltfUrl}`)
  }

  const gltf = (await gltfRes.json()) as {
    buffers?: Array<{ uri?: string; byteLength?: number }>
    bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; target?: number }>
    images?: Array<{ uri?: string; mimeType?: string; bufferView?: number }>
    accessors?: Array<{ type?: string; min?: number[]; max?: number[] }>
    meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: number } }> }>
  }

  // Compute exact bounding box from POSITION accessors if available.
  let dimensionsMeters: [number, number, number] | null = null
  const accessors = gltf.accessors ?? []
  const posIndices = new Set<number>()
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (typeof prim.attributes?.POSITION === 'number') {
        posIndices.add(prim.attributes.POSITION)
      }
    }
  }
  if (posIndices.size > 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (const idx of posIndices) {
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
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      dimensionsMeters = [
        Math.max(0.05, Number((maxX - minX).toFixed(3))),
        Math.max(0.05, Number((maxY - minY).toFixed(3))),
        Math.max(0.05, Number((maxZ - minZ).toFixed(3))),
      ]
    }
  }

  const binChunks: Buffer[] = []
  let binOffset = 0

  // 1. Fetch primary .bin buffer if referenced
  const primaryUri = gltf.buffers?.[0]?.uri
  if (primaryUri) {
    const entry = bundle.include[primaryUri]
    const binUrl = entry?.url ?? new URL(primaryUri, bundle.gltfUrl).toString()
    const binRes = await fetchImpl(binUrl)
    if (!binRes.ok) {
      throw new Error(`Failed to fetch .bin (${binRes.status}) from ${binUrl}`)
    }
    const rawBin = Buffer.from(await binRes.arrayBuffer())
    const paddedBin = padTo4Bytes(rawBin, 0x00)
    binChunks.push(paddedBin)
    binOffset += paddedBin.byteLength
    delete gltf.buffers![0].uri
    gltf.buffers![0].byteLength = rawBin.byteLength
  }

  // 2. Embed external images into bufferViews
  gltf.bufferViews = gltf.bufferViews ?? []
  for (const img of gltf.images ?? []) {
    if (!img.uri) continue
    const entry = bundle.include[img.uri]
    const imgUrl = entry?.url ?? new URL(img.uri, bundle.gltfUrl).toString()
    const imgRes = await fetchImpl(imgUrl)
    if (!imgRes.ok) {
      throw new Error(`Failed to fetch image (${imgRes.status}) from ${imgUrl}`)
    }
    const rawImg = Buffer.from(await imgRes.arrayBuffer())
    const paddedImg = padTo4Bytes(rawImg, 0x00)
    const viewIdx = gltf.bufferViews.length
    gltf.bufferViews.push({
      buffer: 0,
      byteOffset: binOffset,
      byteLength: rawImg.byteLength,
    })
    binChunks.push(paddedImg)
    binOffset += paddedImg.byteLength
    if (!img.mimeType) {
      img.mimeType = img.uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    }
    delete img.uri
    img.bufferView = viewIdx
  }

  if (gltf.buffers?.[0]) {
    gltf.buffers[0].byteLength = binOffset
  }

  const jsonBuf = padTo4Bytes(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20)
  const binBuf = Buffer.concat(binChunks)

  const totalLength = 12 + 8 + jsonBuf.byteLength + 8 + binBuf.byteLength
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4) // version 2
  header.writeUInt32LE(totalLength, 8)

  const jsonChunkHeader = Buffer.alloc(8)
  jsonChunkHeader.writeUInt32LE(jsonBuf.byteLength, 0)
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'

  const binChunkHeader = Buffer.alloc(8)
  binChunkHeader.writeUInt32LE(binBuf.byteLength, 0)
  binChunkHeader.writeUInt32LE(0x004e4942, 4) // 'BIN\0'

  return {
    glb: Buffer.concat([header, jsonChunkHeader, jsonBuf, binChunkHeader, binBuf]),
    dimensionsMeters,
  }
}

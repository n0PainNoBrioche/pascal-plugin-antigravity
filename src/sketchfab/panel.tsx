'use client'

import type { AssetInput } from '@pascal-app/core'
import { useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useCallback, useEffect, useState } from 'react'
import type { SketchfabModelSummary } from './client'

const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'Tous' },
  { id: 'furniture-home', label: 'Meubles' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'nature-plants', label: 'Nature' },
  { id: 'electronics-gadgets', label: 'Objets' },
]

export default function SketchfabPanel() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('furniture-home')
  const [models, setModels] = useState<SketchfabModelSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placingUid, setPlacingUid] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const runSearch = useCallback(async (q: string, cat: string) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '24' })
      if (q.trim()) params.set('q', q.trim())
      if (cat && cat !== 'all') params.set('category', cat)
      const res = await fetch(`/api/plugins/sketchfab/search?${params.toString()}`)
      const data = (await res.json()) as {
        ok: boolean
        models?: SketchfabModelSummary[]
        error?: string
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setModels(data.models ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la recherche Sketchfab.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void runSearch(query, category)
    }, 260)
    return () => clearTimeout(timer)
  }, [category, query, runSearch])

  const handlePlace = useCallback(async (model: SketchfabModelSummary) => {
    setPlacingUid(model.uid)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(
        `/api/plugins/sketchfab/resolve?uid=${encodeURIComponent(model.uid)}`,
      )
      const data = (await res.json()) as {
        ok: boolean
        src?: string
        dimensionsMeters?: [number, number, number] | null
        error?: string
      }
      if (!res.ok || !data.ok || !data.src) {
        throw new Error(data.error ?? `Impossible de préparer ${model.name}`)
      }

      const resolvedSrc =
        data.src.startsWith('http://') || data.src.startsWith('https://')
          ? data.src
          : `${window.location.origin}${data.src.startsWith('/') ? '' : '/'}${data.src}`

      const asset: AssetInput = {
        id: `sketchfab:${model.uid}`,
        category: model.categories[0] ?? 'furniture',
        name: model.name,
        thumbnail: model.thumbnailUrl,
        src: resolvedSrc,
        dimensions: data.dimensionsMeters ?? [1, 1, 1],
        tags: model.tags,
      }

      useViewer.getState().setSelection({ selectedIds: [], zoneId: null })
      const editor = useEditor.getState()
      editor.setSelectedItem(asset)
      editor.setTool('item')
      editor.setMode('build')
      setNotice(`Prêt à placer : ${model.name} (clique dans la scène 3D)`)
      setTimeout(() => setNotice(null), 4000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors du téléchargement GLB.')
    } finally {
      setPlacingUid(null)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border/80 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold tracking-tight">Sketchfab 3D</h2>
            <p className="text-[11px] text-sidebar-foreground/60">
              Modèles 3D gratuits téléchargeables (GLB)
            </p>
          </div>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300">
            Gratuit
          </span>
        </div>

        <div className="mt-2.5">
          <input
            className="w-full rounded-lg border border-sidebar-border/80 bg-black/25 px-2.5 py-1.5 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/45 focus:border-sidebar-foreground/40 focus:outline-none"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher (sofa, oak tree, kitchen, lamp…)"
            type="text"
            value={query}
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {CATEGORIES.map((cat) => {
            const active = category === cat.id
            return (
              <button
                className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-sidebar-foreground text-sidebar'
                    : 'border border-sidebar-border/70 bg-black/20 text-sidebar-foreground/75 hover:text-sidebar-foreground'
                }`}
                key={cat.id}
                onClick={() => setCategory(cat.id)}
                type="button"
              >
                {cat.label}
              </button>
            )
          })}
        </div>
      </div>

      {notice && (
        <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200">
          {notice}
        </div>
      )}

      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2.5">
        {loading && models.length === 0 ? (
          <div className="py-8 text-center text-xs text-sidebar-foreground/55">
            Recherche sur Sketchfab…
          </div>
        ) : models.length === 0 ? (
          <div className="py-8 text-center text-xs text-sidebar-foreground/55">
            Aucun modèle trouvé.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {models.map((model) => {
              const isPlacing = placingUid === model.uid
              const trisLabel =
                model.faceCount >= 1000
                  ? `${Math.round(model.faceCount / 1000)}k tris`
                  : `${model.faceCount} tris`
              const isHeavy = model.faceCount > 50_000
              return (
                <div
                  className="flex flex-col overflow-hidden rounded-lg border border-sidebar-border/70 bg-black/20"
                  key={model.uid}
                >
                  <div className="relative aspect-square w-full bg-black/35">
                    {model.thumbnailUrl && (
                      <img
                        alt={model.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        src={model.thumbnailUrl}
                      />
                    )}
                    {model.faceCount > 0 && (
                      <span
                        className={`absolute right-1 top-1 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                          isHeavy
                            ? 'bg-amber-950/85 text-amber-200'
                            : 'bg-black/75 text-sidebar-foreground/85'
                        }`}
                      >
                        {trisLabel}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col justify-between gap-1.5 p-2">
                    <div>
                      <div className="truncate text-[11px] font-medium text-sidebar-foreground">
                        {model.name}
                      </div>
                      <div className="truncate text-[10px] text-sidebar-foreground/55">
                        {model.author || model.license}
                      </div>
                    </div>
                    <button
                      className="w-full rounded-md bg-sidebar-foreground/90 px-2 py-1 text-[11px] font-medium text-sidebar transition hover:bg-sidebar-foreground disabled:opacity-50"
                      disabled={isPlacing}
                      onClick={() => void handlePlace(model)}
                      type="button"
                    >
                      {isPlacing ? 'Téléchargement…' : 'Placer'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

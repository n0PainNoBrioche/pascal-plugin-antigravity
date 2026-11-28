import { describe, expect, it } from 'vitest'
import { filterPolyHavenModels, type PolyHavenModelSummary } from './client.ts'

const SAMPLE_ITEMS: PolyHavenModelSummary[] = [
  {
    id: 'ArmChair_01',
    name: 'Arm Chair 01',
    description: 'Vintage Victorian armchair',
    categories: ['furniture', 'seating'],
    tags: ['chair', 'wood', 'velvet'],
    thumbnailUrl: 'https://cdn.polyhaven.com/asset_img/thumbs/ArmChair_01.png',
    dimensionsMeters: [0.85, 1.07, 0.77],
    polycount: 5626,
    downloadCount: 33000,
  },
  {
    id: 'potted_plant_02',
    name: 'Potted Plant 02',
    description: 'Indoor potted plant',
    categories: ['nature', 'plants'],
    tags: ['plant', 'pot', 'green'],
    thumbnailUrl: 'https://cdn.polyhaven.com/asset_img/thumbs/potted_plant_02.png',
    dimensionsMeters: [0.4, 0.9, 0.4],
    polycount: 3200,
    downloadCount: 15000,
  },
]

describe('filterPolyHavenModels', () => {
  it('filters by multi-word query and category', () => {
    expect(filterPolyHavenModels(SAMPLE_ITEMS, { query: 'wood chair' })).toHaveLength(1)
    expect(filterPolyHavenModels(SAMPLE_ITEMS, { category: 'nature' })).toEqual([
      SAMPLE_ITEMS[1],
    ])
    expect(filterPolyHavenModels(SAMPLE_ITEMS, { query: 'nonexistent' })).toEqual([])
  })
})

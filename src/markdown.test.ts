import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from './markdown.tsx'

describe('parseMarkdownBlocks', () => {
  it('parses headings, lists, blockquotes, tables, and fenced code blocks', () => {
    const md = [
      '### Résumé',
      '',
      'Voici les **pièces** :',
      '- Séjour (35 m²)',
      '- Cuisine (14 m²)',
      '',
      '| Pièce | Surface |',
      '| --- | --- |',
      '| Séjour | 35 m² |',
      '',
      '> Vérifié avec check_collisions.',
      '',
      '```json',
      '{"ok":true}',
      '```',
    ].join('\n')

    const blocks = parseMarkdownBlocks(md)
    expect(blocks).toEqual([
      { kind: 'heading', level: 3, text: 'Résumé' },
      { kind: 'paragraph', text: 'Voici les **pièces** :' },
      { kind: 'list', ordered: false, items: ['Séjour (35 m²)', 'Cuisine (14 m²)'] },
      { kind: 'table', headers: ['Pièce', 'Surface'], rows: [['Séjour', '35 m²']] },
      { kind: 'blockquote', lines: ['Vérifié avec check_collisions.'] },
      { kind: 'code', lang: 'json', content: '{"ok":true}' },
    ])
  })

  it('handles unclosed fenced code blocks gracefully while streaming', () => {
    const blocks = parseMarkdownBlocks('```ts\nconst x = 1')
    expect(blocks).toEqual([{ kind: 'code', lang: 'ts', content: 'const x = 1' }])
  })
})

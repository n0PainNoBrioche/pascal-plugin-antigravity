import React, { Fragment, useMemo } from 'react'

export type MarkdownBlock =
  | { kind: 'code'; lang?: string; content: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'hr' }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'paragraph'; text: string }

const HEADING_RE = /^(#{1,4})\s+(.+)$/
const HR_RE = /^(?:---|\*\*\*|___)\s*$/
const UNORDERED_LIST_RE = /^[-*+]\s+(.+)$/
const ORDERED_LIST_RE = /^\d+\.\s+(.+)$/
const BLOCKQUOTE_RE = /^>\s?(.*)$/
const FENCE_OPEN_RE = /^```([a-zA-Z0-9_+-]*)\s*$/
const FENCE_CLOSE_RE = /^```\s*$/
const TABLE_SEP_RE = /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableHeaderPair(line: string, nextLine: string | undefined): boolean {
  if (!nextLine) return false
  return line.includes('|') && TABLE_SEP_RE.test(nextLine.trim())
}

/**
 * Parses a Markdown string into block-level AST nodes.
 * Handles unclosed fenced code blocks gracefully during live streaming.
 */
export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // Fenced code block
    const fenceMatch = FENCE_OPEN_RE.exec(line.trim())
    if (fenceMatch) {
      const lang = fenceMatch[1] || undefined
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !FENCE_CLOSE_RE.test((lines[i] ?? '').trim())) {
        codeLines.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length && FENCE_CLOSE_RE.test((lines[i] ?? '').trim())) {
        i += 1
      }
      blocks.push({ kind: 'code', lang, content: codeLines.join('\n') })
      continue
    }

    if (line.trim() === '') {
      i += 1
      continue
    }

    if (HR_RE.test(line.trim())) {
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    const headingMatch = HEADING_RE.exec(line.trim())
    if (headingMatch) {
      const level = Math.min(4, Math.max(1, headingMatch[1].length)) as 1 | 2 | 3 | 4
      blocks.push({ kind: 'heading', level, text: headingMatch[2].trim() })
      i += 1
      continue
    }

    if (isTableHeaderPair(line, lines[i + 1])) {
      const headers = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const rowLine = lines[i] ?? ''
        if (rowLine.trim() === '' || !rowLine.includes('|')) break
        rows.push(splitTableRow(rowLine))
        i += 1
      }
      blocks.push({ kind: 'table', headers, rows })
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const qm = BLOCKQUOTE_RE.exec(lines[i] ?? '')
        if (!qm) break
        quoteLines.push(qm[1])
        i += 1
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines })
      continue
    }

    if (UNORDERED_LIST_RE.test(line.trim())) {
      const items: string[] = []
      while (i < lines.length) {
        const lm = UNORDERED_LIST_RE.exec((lines[i] ?? '').trim())
        if (!lm) break
        items.push(lm[1])
        i += 1
      }
      blocks.push({ kind: 'list', ordered: false, items })
      continue
    }

    if (ORDERED_LIST_RE.test(line.trim())) {
      const items: string[] = []
      while (i < lines.length) {
        const lm = ORDERED_LIST_RE.exec((lines[i] ?? '').trim())
        if (!lm) break
        items.push(lm[1])
        i += 1
      }
      blocks.push({ kind: 'list', ordered: true, items })
      continue
    }

    // Paragraph: collect contiguous plain lines
    const paraLines: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ''
      if (
        cur.trim() === '' ||
        FENCE_OPEN_RE.test(cur.trim()) ||
        HR_RE.test(cur.trim()) ||
        HEADING_RE.test(cur.trim()) ||
        BLOCKQUOTE_RE.test(cur) ||
        UNORDERED_LIST_RE.test(cur.trim()) ||
        ORDERED_LIST_RE.test(cur.trim()) ||
        isTableHeaderPair(cur, lines[i + 1])
      ) {
        break
      }
      paraLines.push(cur)
      i += 1
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: 'paragraph', text: paraLines.join('\n') })
    }
  }

  return blocks
}

function isSafeHref(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim())
}

const INLINE_TOKEN_PATTERN =
  '(`[^`\\n]+`|\\*\\*[^*\\n]+?\\*\\*|__[^_\\n]+?__|\\[[^\\]]+\\]\\([^)\\s]+\\)|\\*[^*\\n]+?\\*)'

export function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let key = 0
  // Use a local RegExp instance per call so recursive calls never reset an outer loop's lastIndex.
  const regex = new RegExp(INLINE_TOKEN_PATTERN, 'g')

  let match = regex.exec(text)
  while (match) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>)
    }
    const token = match[0]
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          className="rounded bg-black/35 px-1 py-0.5 font-mono text-[11px] text-sidebar-foreground/95"
          key={key++}
        >
          {token.slice(1, -1)}
        </code>,
      )
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      nodes.push(
        <strong className="font-semibold text-sidebar-foreground" key={key++}>
          {renderInlineMarkdown(token.slice(2, -2))}
        </strong>,
      )
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const splitIdx = token.indexOf('](')
      const label = token.slice(1, splitIdx)
      const href = token.slice(splitIdx + 2, -1)
      if (isSafeHref(href)) {
        nodes.push(
          <a
            className="underline decoration-sidebar-foreground/40 underline-offset-2 hover:text-sidebar-foreground"
            href={href}
            key={key++}
            rel="noopener noreferrer"
            target="_blank"
          >
            {label}
          </a>,
        )
      } else {
        nodes.push(<Fragment key={key++}>{token}</Fragment>)
      }
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em className="italic" key={key++}>
          {renderInlineMarkdown(token.slice(1, -1))}
        </em>,
      )
    } else {
      nodes.push(<Fragment key={key++}>{token}</Fragment>)
    }

    lastIndex = match.index + token.length
    match = regex.exec(text)
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>)
  }
  return nodes
}

export function MarkdownContent({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text])

  return (
    <div className="space-y-2 text-xs leading-relaxed text-sidebar-foreground/90">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre
                className="overflow-x-auto rounded-lg border border-sidebar-border/70 bg-black/35 p-2.5 font-mono text-[11px] leading-snug text-sidebar-foreground/95"
                key={index}
              >
                <code>{block.content}</code>
              </pre>
            )
          case 'hr':
            return <hr className="border-sidebar-border/60" key={index} />
          case 'heading': {
            const cls =
              block.level === 1
                ? 'text-sm font-semibold text-sidebar-foreground'
                : block.level === 2
                  ? 'text-[13px] font-semibold text-sidebar-foreground'
                  : 'text-xs font-semibold text-sidebar-foreground'
            return (
              <div className={cls} key={index}>
                {renderInlineMarkdown(block.text)}
              </div>
            )
          }
          case 'blockquote':
            return (
              <blockquote
                className="border-l-2 border-sidebar-foreground/30 pl-2.5 text-sidebar-foreground/75"
                key={index}
              >
                {block.lines.map((line, lineIdx) => (
                  <p className="break-words" key={lineIdx}>
                    {renderInlineMarkdown(line)}
                  </p>
                ))}
              </blockquote>
            )
          case 'list':
            return block.ordered ? (
              <ol className="list-decimal space-y-1 pl-4" key={index}>
                {block.items.map((item, itemIdx) => (
                  <li className="break-words" key={itemIdx}>
                    {renderInlineMarkdown(item)}
                  </li>
                ))}
              </ol>
            ) : (
              <ul className="list-disc space-y-1 pl-4" key={index}>
                {block.items.map((item, itemIdx) => (
                  <li className="break-words" key={itemIdx}>
                    {renderInlineMarkdown(item)}
                  </li>
                ))}
              </ul>
            )
          case 'table':
            return (
              <div className="overflow-x-auto rounded-lg border border-sidebar-border/70" key={index}>
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="bg-black/25 text-sidebar-foreground">
                    <tr>
                      {block.headers.map((header, hIdx) => (
                        <th className="border-b border-sidebar-border/70 px-2 py-1 font-semibold" key={hIdx}>
                          {renderInlineMarkdown(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr className="border-b border-sidebar-border/40 last:border-b-0" key={rIdx}>
                        {block.headers.map((_, cIdx) => (
                          <td className="px-2 py-1 align-top" key={cIdx}>
                            {renderInlineMarkdown(row[cIdx] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'paragraph':
            return (
              <p className="whitespace-pre-wrap break-words" key={index}>
                {renderInlineMarkdown(block.text)}
              </p>
            )
        }
      })}
    </div>
  )
}

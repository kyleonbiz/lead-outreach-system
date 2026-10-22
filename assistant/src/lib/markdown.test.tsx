import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown, MAX_MARKDOWN_CHARS, parseInline, safeHref } from './markdown'

const html = (text: string) => render(<Markdown text={text} />).container

describe('Markdown rendering', () => {
  it('renders bold, italic, inline code and paragraphs', () => {
    const c = html('Hello **bold** and *italic* with `code`.\n\nSecond paragraph.')
    expect(c.querySelector('strong')).toHaveTextContent('bold')
    expect(c.querySelector('em')).toHaveTextContent('italic')
    expect(c.querySelector('code')).toHaveTextContent('code')
    expect(c.querySelectorAll('p')).toHaveLength(2)
    expect(c.textContent).not.toContain('**')
  })

  it('renders the assistant-style morning summary without literal asterisks', () => {
    const c = html("Here's what stands out:\n\n**Urgent email (3)**\n- Hartwell — quote expires Friday\n- Dana — confirm visit\n\n**Overdue (1):** Send Q3 invoices")
    expect(c.querySelectorAll('li')).toHaveLength(2)
    expect(c.querySelectorAll('strong')).toHaveLength(2)
    expect(c.textContent).not.toMatch(/\*\*/)
  })

  it('renders ordered lists, blockquotes, headings and fenced code', () => {
    const c = html('# Plan\n1. one\n2. two\n\n> quoted\n\n```\nconst a = **1**\n```')
    expect(c.querySelector('ol')?.children).toHaveLength(2)
    expect(c.querySelector('blockquote')).toHaveTextContent('quoted')
    expect(c.querySelector('pre')).toHaveTextContent('const a = **1**') // not formatted inside code
    expect(c.textContent).toContain('Plan')
  })

  it('keeps single newlines as line breaks and does not treat snake_case as emphasis', () => {
    const c = html('line one\nline two and a_snake_case_word')
    expect(c.querySelector('br')).not.toBeNull()
    expect(c.querySelector('em')).toBeNull()
    expect(c.textContent).toContain('a_snake_case_word')
  })

  it('renders safe links with rel=noopener noreferrer in a new tab', () => {
    const c = html('See [the quote](https://example.com/q?a=1&b=2) or [mail me](mailto:kyle@example.com).')
    const links = [...c.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/q?a=1&b=2', 'mailto:kyle@example.com'])
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      expect(a.getAttribute('target')).toBe('_blank')
    }
  })

  it('degrades unmatched markers to plain text', () => {
    const c = html('2 * 3 = 6 and **unclosed and [not a link and `tick')
    expect(c.textContent).toBe('2 * 3 = 6 and **unclosed and [not a link and `tick')
  })
})

describe('Markdown is safe against hostile content', () => {
  it('never creates script/img/iframe elements or event handlers from raw HTML', () => {
    const c = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.test"></iframe> <a href="javascript:alert(1)" onclick="x()">hi</a>')
    expect(c.querySelector('script, img, iframe, style, object, embed, form')).toBeNull()
    expect(c.querySelector('a')).toBeNull()
    expect(c.querySelector('[onerror], [onclick]')).toBeNull()
    expect(c.textContent).toContain('<script>alert(1)</script>') // shown literally
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
    '//evil.test/x', '/relative/path', 'ftp://example.com/x', 'blob:https://example.com/id',
  ])('does not turn %s into a link', (target) => {
    const c = html(`[click me](${target})`)
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toBe('click me')
    expect(safeHref(target)).toBeNull()
  })

  it('never loads images: shows alt text only', () => {
    const c = html('![tracking pixel](https://evil.test/p.gif) ![x](javascript:alert(1))')
    expect(c.querySelector('img')).toBeNull()
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toContain('tracking pixel')
  })

  it('does not let quotes in a URL break out of the href attribute', () => {
    const c = html('[x](https://example.com/"onmouseover="alert(1))')
    const a = c.querySelector('a')
    expect(a?.getAttributeNames().sort()).toEqual(['class', 'href', 'rel', 'target'])
  })

  it('treats nested/lookalike markup inside labels as text', () => {
    const c = html('[**<b>bold</b>**](https://example.com)')
    expect(c.querySelector('b')).toBeNull()
    expect(c.querySelector('a strong')).toHaveTextContent('<b>bold</b>')
  })

  it('stays fast on adversarial input and falls back to plain text when huge', () => {
    for (const unit of ['**a ', '[', '](', '*a ', '`', '![', '_a ', '> ', '- ']) {
      const t0 = performance.now()
      parseInline(unit.repeat(10_000))
      expect(performance.now() - t0).toBeLessThan(1500)
    }
    const huge = 'x'.repeat(MAX_MARKDOWN_CHARS + 1)
    expect(html(huge).textContent).toBe(huge)
  })

  it('caps nesting depth', () => {
    const nested = '*'.repeat(0) + '**a '.repeat(50) + 'b' + ' a**'.repeat(50)
    expect(() => html(nested)).not.toThrow()
  })
})

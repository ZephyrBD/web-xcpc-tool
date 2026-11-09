import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const css = readFileSync(join(import.meta.dir, 'tokens.css'), 'utf8')

describe('tokens.css', () => {
  test('declares the five brand variables', () => {
    for (const [name, value] of [
      ['--brand-green', '#0acf83'],
      ['--brand-orange', '#f24e1e'],
      ['--brand-purple', '#a259ff'],
      ['--brand-red', '#ff7262'],
      ['--brand-blue', '#1abcfe'],
    ] as const) {
      expect(css).toContain(`${name}: ${value}`)
    }
  })

  test('declares a darker danger text color (body-size error copy)', () => {
    expect(css).toContain('--danger-text: #c2311a')
    // 亮红仍然保留给图标 / 描边。
    expect(css).toContain('--brand-red: #ff7262')
  })

  test('declares radius values', () => {
    expect(css).toContain('--radius-card: 16px')
    expect(css).toContain('--radius-control: 8px')
    expect(css).toContain('--radius-pill: 999px')
  })

  test('declares card hover shadow', () => {
    expect(css).toContain('--shadow-card: 0 8px 24px rgba(15, 15, 20, .08)')
  })

  test('declares surface and text variables', () => {
    for (const name of ['--bg', '--bg-alt', '--text', '--text-muted', '--border']) {
      expect(css).toContain(`${name}:`)
    }
  })

  test('declares the type scale', () => {
    for (const size of ['13', '15', '17', '20', '24', '32', '44']) {
      expect(css).toContain(`--text-${size}:`)
    }
  })
})

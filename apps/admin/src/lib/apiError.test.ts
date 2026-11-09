import { describe, expect, test } from 'bun:test'
import { ApiError } from '@/api'
import { serverMessage, serverMessageOrEmpty } from '@/lib/apiError'

describe('serverMessage', () => {
  test('prefers the message field', () => {
    const err = new ApiError(403, { error: 'contest id locked', message: '比赛 ID 已锁定，设置后不可修改' })
    expect(serverMessage(err, '兜底')).toBe('比赛 ID 已锁定，设置后不可修改')
  })

  test('falls back to the error field', () => {
    expect(serverMessage(new ApiError(400, { error: '配置格式不正确' }), '兜底')).toBe('配置格式不正确')
  })

  test('falls back to the reason field (import / sync style bodies)', () => {
    expect(serverMessage(new ApiError(400, { reason: 'invalid excel file' }), '兜底')).toBe('invalid excel file')
  })

  test('uses the fallback when the body carries no message', () => {
    expect(serverMessage(new ApiError(502, {}), '兜底')).toBe('兜底')
    expect(serverMessage(new ApiError(502, null), '兜底')).toBe('兜底')
    expect(serverMessage(new Error('boom'), '兜底')).toBe('兜底')
    expect(serverMessage(undefined, '兜底')).toBe('兜底')
  })

  test('ignores blank strings', () => {
    expect(serverMessage(new ApiError(500, { error: '   ' }), '兜底')).toBe('兜底')
  })

  test('serverMessageOrEmpty reports the absence of a message', () => {
    expect(serverMessageOrEmpty(new ApiError(502, {}))).toBe('')
    expect(serverMessageOrEmpty(new ApiError(502, { error: 'domjudge sync failed' }))).toBe('domjudge sync failed')
  })
})

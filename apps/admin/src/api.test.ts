import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { apiFetch, clearToken, setToken } from './api'

const calls: Array<{ url: string; init: RequestInit }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('apiFetch', () => {
  beforeEach(() => {
    localStorage.clear()
    calls.length = 0
    mockFetch()
  })

  afterEach(() => {
    // Leave no token behind — other test files mount pages that read the session.
    clearToken()
  })

  test('sets Content-Type application/json for a JSON body', async () => {
    await apiFetch('/admin/api/teams/sync', {
      method: 'POST',
      body: JSON.stringify({ contestId: 'c1' }),
    })
    expect(calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  test('does not set Content-Type for a FormData body (browser sets the multipart boundary)', async () => {
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'application/octet-stream' }), 'teams.xlsx')
    await apiFetch('/admin/api/teams/import-excel', { method: 'POST', body: form })
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['Content-Type']).toBeUndefined()
  })

  test('still attaches the bearer token for FormData uploads', async () => {
    setToken('tok-1')
    const form = new FormData()
    form.append('file', new Blob(['x']), 'teams.xlsx')
    await apiFetch('/admin/api/teams/import-excel', { method: 'POST', body: form })
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-1')
  })
})

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'
import { useSessionStore } from '@/stores/session'
import type { AuthTask } from '@/types'

// ElMessageBox renders into document.body via its own app — mock it out so the
// confirm click is deterministic in happy-dom.
const confirmMock = mock(() => Promise.resolve('confirm'))
mock.module('element-plus', () => ({
  ...elementPlus,
  ElMessageBox: { ...elementPlus.ElMessageBox, confirm: confirmMock },
}))

const { default: AuthTasksPage } = await import('./AuthTasksPage.vue')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let tasks: AuthTask[] = []
const calls: Array<{ method: string; path: string; body: unknown }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/cxtool/, '')
    const method = init?.method ?? 'GET'
    let body: unknown = null
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    calls.push({ method, path, body })

    const approveMatch = path.match(/^\/admin\/api\/auth-tasks\/(.+)\/approve$/)
    const rejectMatch = path.match(/^\/admin\/api\/auth-tasks\/(.+)\/reject$/)
    if (method === 'POST' && approveMatch) {
      const t = tasks.find((x) => x.id === approveMatch[1])
      if (t) t.status = 'approved'
      return new Response(JSON.stringify(t), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'POST' && rejectMatch) {
      const t = tasks.find((x) => x.id === rejectMatch[1])
      if (t) t.status = 'rejected'
      return new Response(JSON.stringify(t), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET' && path === '/admin/api/auth-tasks') {
      return new Response(JSON.stringify(tasks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

function makeTask(id: string, overrides: Partial<AuthTask> = {}): AuthTask {
  return {
    id,
    examNum: `2026${id}`,
    clientId: `client-${id}`,
    strategy: 'cookie',
    status: 'pending',
    createdAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  listeners: Record<string, Array<(e: { data: string }) => void>> = {}

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (e: { data: string }) => void) {
    ;(this.listeners[name] ??= []).push(fn)
  }

  emit(name: string, data: unknown) {
    for (const fn of this.listeners[name] ?? []) fn({ data: JSON.stringify(data) })
  }

  close() {
    this.closed = true
  }
}

describe('AuthTasksPage', () => {
  beforeEach(() => {
    localStorage.clear()
    confirmMock.mockClear()
    FakeEventSource.instances.length = 0
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    tasks = [makeTask('t1'), makeTask('t2', { strategy: 'fingerprint' })]
    calls.length = 0
    mockFetch()
  })

  test('renders task rows from the mocked API', async () => {
    const wrapper = mount(AuthTasksPage, { global: { plugins: [createPinia()] } })
    await flush()
    await flush()

    expect(calls[0]).toMatchObject({ method: 'GET', path: '/admin/api/auth-tasks' })
    expect(wrapper.text()).toContain('2026t1')
    expect(wrapper.text()).toContain('2026t2')
    expect(wrapper.text()).toContain('fingerprint')
    // status pills
    expect(wrapper.findAll('.pill--pending').length).toBe(2)
  })

  test('approve click confirms, calls the approve API, and refreshes the list', async () => {
    const wrapper = mount(AuthTasksPage, { global: { plugins: [createPinia()] } })
    await flush()
    await flush()

    const approveBtn = wrapper.findAll('button').find((b) => b.text() === '批准')!
    expect(approveBtn).toBeDefined()
    await approveBtn.trigger('click')
    await flush()
    await flush()

    expect(confirmMock).toHaveBeenCalled()
    const approveCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/t1/approve'))
    expect(approveCall).toBeDefined()

    // list was refetched and the row now shows the approved pill
    const gets = calls.filter((c) => c.method === 'GET' && c.path === '/admin/api/auth-tasks')
    expect(gets.length).toBeGreaterThanOrEqual(2)
    expect(wrapper.findAll('.pill--approved').length).toBe(1)
    expect(wrapper.text()).toContain('已批准')
  })

  test('reject click posts to the reject route with an empty body', async () => {
    const wrapper = mount(AuthTasksPage, { global: { plugins: [createPinia()] } })
    await flush()
    await flush()

    const rejectBtn = wrapper.findAll('button').find((b) => b.text() === '拒绝')!
    await rejectBtn.trigger('click')
    await flush()
    await flush()

    const rejectCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/t1/reject'))
    expect(rejectCall).toBeDefined()
    expect(rejectCall!.body).toEqual({})
    expect(wrapper.findAll('.pill--rejected').length).toBe(1)
  })

  test('connects SSE with the session token in the query string', async () => {
    const pinia = createPinia()
    const session = useSessionStore(pinia)
    session.sseToken = 'sse-tok-9'

    mount(AuthTasksPage, { global: { plugins: [pinia] } })
    await flush()

    expect(FakeEventSource.instances.length).toBe(1)
    const es = FakeEventSource.instances[0]
    expect(es.url).toContain('/cxtool/admin/api/events')
    expect(es.url).toContain('token=sse-tok-9')
  })

  test('an SSE auth-task event triggers a debounced list refresh', async () => {
    const pinia = createPinia()
    const session = useSessionStore(pinia)
    session.sseToken = 'sse-tok-9'

    const wrapper = mount(AuthTasksPage, { global: { plugins: [pinia] } })
    await flush()
    await flush()
    const getsBefore = calls.filter((c) => c.method === 'GET').length

    FakeEventSource.instances[0].emit('auth-task', makeTask('t3'))
    tasks.push(makeTask('t3'))
    // event for an id already reflected in the list → still refreshes (debounced, not dropped)
    FakeEventSource.instances[0].emit('auth-task', makeTask('t1'))
    await wait(400)

    const getsAfter = calls.filter((c) => c.method === 'GET').length
    expect(getsAfter).toBe(getsBefore + 1)
    expect(wrapper.text()).toContain('2026t3')
  })
})

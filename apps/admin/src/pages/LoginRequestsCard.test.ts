import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import * as elementPlus from 'element-plus'
import type { LoginRequest } from '@/types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

// bun 在同一进程里交错跑异步测试，固定次数的 flush 会和响应时机竞态，
// 这里用带超时的轮询等待条件成立。
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false
    await flush()
  }
  return true
}

// 自动确认所有 confirm 弹窗（不能直接改写 ElMessageBox 对象，用模块级 mock）。
const confirmMock = mock(async () => 'confirm')
// bun 的模块 mock 是进程级的：先留一份未受污染的命名空间，本文件跑完再恢复，
// 否则其它页面测试（如 App.test 挂载真实路由页）会拿到被替换成普通对象的
// ElMessageBox，进而挂掉。
const pristineElementPlus = { ...elementPlus }
mock.module('element-plus', () => ({
  ...pristineElementPlus,
  ElMessageBox: { ...pristineElementPlus.ElMessageBox, confirm: confirmMock },
}))

const { default: LoginRequestsCard } = await import('./LoginRequestsCard.vue')

afterAll(() => {
  mock.module('element-plus', () => ({ ...pristineElementPlus }))
})

function makeRequest(id: string, overrides: Partial<LoginRequest> = {}): LoginRequest {
  return {
    id,
    icpcId: `icpc-${id}`,
    teamCode: `code-${id}`,
    teamName: `队伍${id}`,
    ip: '10.0.0.1',
    requestedAt: '2026-11-09T10:00:00.000Z',
    status: 'pending',
    decidedAt: null,
    ...overrides,
  }
}

let pending: LoginRequest[] = []
let recent: LoginRequest[] = []
let decisionShouldFail = false
const calls: Array<{ method: string; path: string; body?: unknown }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/wxt/, '')
    const method = init?.method ?? 'GET'
    const call: { method: string; path: string; body?: unknown } = { method, path }
    if (init?.body) call.body = init.body
    calls.push(call)

    const decision = path.match(/^\/admin\/api\/login-requests\/([^/]+)\/decision$/)
    if (method === 'POST' && decision) {
      if (decisionShouldFail) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      const { decision: value } = JSON.parse(String(init?.body)) as { decision: LoginRequest['status'] }
      const req = [...pending, ...recent].find((r) => r.id === decision[1])!
      const updated: LoginRequest = { ...req, status: value, decidedAt: '2026-11-09T10:05:00.000Z' }
      pending = pending.filter((r) => r.id !== req.id)
      recent = [updated, ...recent]
      return new Response(JSON.stringify(updated), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'GET' && path === '/admin/api/login-requests') {
      return new Response(JSON.stringify({ pending, recent }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

function mountCard() {
  return mount(LoginRequestsCard)
}

describe('LoginRequestsCard', () => {
  beforeEach(() => {
    pending = []
    recent = []
    decisionShouldFail = false
    calls.length = 0
    confirmMock.mockClear()
    mockFetch()
  })

  test('mounts and GETs the login requests, rendering pending rows', async () => {
    pending = [makeRequest('a'), makeRequest('b', { teamName: '队伍二', ip: null })]
    const wrapper = mountCard()
    await waitFor(() => calls.some((c) => c.method === 'GET' && c.path === '/admin/api/login-requests'))
    await waitFor(() => wrapper.findAll('.el-table__row').length >= 2)

    const text = wrapper.text()
    expect(text).toContain('登录审批')
    expect(text).toContain('队伍a')
    expect(text).toContain('code-a')
    expect(text).toContain('队伍二')
    // ip null → 占位符
    expect(wrapper.findAll('.el-table__row')[1].text()).toContain('—')
    expect(wrapper.findAll('button').some((b) => b.text() === '同意')).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text() === '拒绝')).toBe(true)
  })

  test('empty pending list shows the friendly copy', async () => {
    const wrapper = mountCard()
    await waitFor(() => calls.some((c) => c.method === 'GET' && c.path === '/admin/api/login-requests'))
    await flush()
    expect(wrapper.text()).toContain('暂无待审批的登录请求')
  })

  test('同意 confirms then POSTs an approved decision and refreshes the list', async () => {
    pending = [makeRequest('a')]
    const wrapper = mountCard()
    await waitFor(() => wrapper.findAll('.el-table__row').length >= 1)

    const btn = wrapper.findAll('button').find((b) => b.text() === '同意')!
    await btn.trigger('click')
    await waitFor(() => calls.some((c) => c.method === 'POST' && c.path.endsWith('/a/decision')))

    expect(confirmMock).toHaveBeenCalled()
    const post = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/login-requests/a/decision')
    expect(JSON.parse(String(post!.body))).toEqual({ decision: 'approved' })
    // 操作后刷新：GET 次数 ≥ 2，pending 清空
    await waitFor(() => calls.filter((c) => c.method === 'GET' && c.path === '/admin/api/login-requests').length >= 2)
    await waitFor(() => wrapper.text().includes('暂无待审批的登录请求'))
  })

  test('拒绝 POSTs a rejected decision', async () => {
    pending = [makeRequest('a')]
    const wrapper = mountCard()
    await waitFor(() => wrapper.findAll('.el-table__row').length >= 1)

    const btn = wrapper.findAll('button').find((b) => b.text() === '拒绝')!
    await btn.trigger('click')
    await waitFor(() => calls.some((c) => c.method === 'POST' && c.path.endsWith('/a/decision')))

    const post = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/login-requests/a/decision')
    expect(JSON.parse(String(post!.body))).toEqual({ decision: 'rejected' })
  })

  test('cancelling the confirmation does not POST', async () => {
    pending = [makeRequest('a')]
    const wrapper = mountCard()
    await waitFor(() => wrapper.findAll('.el-table__row').length >= 1)

    confirmMock.mockImplementationOnce(async () => {
      throw new Error('cancel')
    })
    const btn = wrapper.findAll('button').find((b) => b.text() === '同意')!
    await btn.trigger('click')
    await flush()
    await flush()

    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  test('a failed decision still refreshes and keeps the request pending', async () => {
    decisionShouldFail = true
    pending = [makeRequest('a')]
    const wrapper = mountCard()
    await waitFor(() => wrapper.findAll('.el-table__row').length >= 1)

    const btn = wrapper.findAll('button').find((b) => b.text() === '同意')!
    await btn.trigger('click')
    await waitFor(() => calls.filter((c) => c.method === 'GET' && c.path === '/admin/api/login-requests').length >= 2)
    await flush()

    // 失败的请求留在 pending 里，行仍在
    expect(wrapper.findAll('.el-table__row').some((r) => r.text().includes('队伍a'))).toBe(true)
  })

  test('refresh button re-fetches the list', async () => {
    const wrapper = mountCard()
    await waitFor(() => calls.some((c) => c.method === 'GET' && c.path === '/admin/api/login-requests'))

    const btn = wrapper.findAll('button').find((b) => b.text() === '刷新')!
    await btn.trigger('click')
    await waitFor(() => calls.filter((c) => c.method === 'GET' && c.path === '/admin/api/login-requests').length >= 2)
  })

  test('recent entries render with status tags 已同意 / 已拒绝 / 已使用', async () => {
    recent = [
      makeRequest('r1', { status: 'approved', decidedAt: '2026-11-09T10:01:00.000Z' }),
      makeRequest('r2', { status: 'rejected', decidedAt: '2026-11-09T10:02:00.000Z' }),
      makeRequest('r3', { status: 'claimed', decidedAt: '2026-11-09T10:03:00.000Z' }),
    ]
    const wrapper = mountCard()
    await waitFor(() => calls.some((c) => c.method === 'GET' && c.path === '/admin/api/login-requests'))
    await flush()

    const text = wrapper.text()
    expect(text).toContain('最近处理')
    expect(text).toContain('已同意')
    expect(text).toContain('已拒绝')
    expect(text).toContain('已使用')
  })
})

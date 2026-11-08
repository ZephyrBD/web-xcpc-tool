import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'
import type { LoginHistoryEntry, TeamCodeRow } from '@/types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

// happy-dom 会真的跟随 <a download> 点击触发的 blob: 导航，把 window.location
// 拐跑（origin 变 null），后续所有 fetch 都会炸。让 <a>.click 变成空操作。
;(HTMLAnchorElement.prototype as unknown as { click: () => void }).click = () => {}

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
mock.module('element-plus', () => ({
  ...elementPlus,
  ElMessageBox: { ...elementPlus.ElMessageBox, confirm: async () => 'confirm' },
}))

const { default: TeamCodesPage } = await import('./TeamCodesPage.vue')

let teamCodeRows: TeamCodeRow[] = []
let unassignedCount = 0
let loginHistory: LoginHistoryEntry[] = []
const calls: Array<{ method: string; path: string; body?: unknown }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/wxt/, '')
    const method = init?.method ?? 'GET'
    const call: { method: string; path: string; body?: unknown } = { method, path: path + u.search }
    if (init?.body) call.body = init.body
    calls.push(call)
    if (path === '/admin/api/team-codes' && method === 'GET') {
      return new Response(JSON.stringify({ rows: teamCodeRows, unassigned: unassignedCount }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/admin/api/team-codes/generate' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { icpcId?: string; all?: boolean }
      if (body.all) return new Response(JSON.stringify({ count: 2 }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ icpcId: body.icpcId, teamCode: 'newcode12345' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/admin/api/team-codes/provision' && method === 'POST') {
      return new Response(JSON.stringify({ provisioned: 2, skipped: 1, errors: [{ icpcId: 'icpcX', reason: 'DOMjudge 中没有该用户名的账号' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/admin/api/team-codes/export' && method === 'GET') {
      return new Response('\uFEFF队伍名,队伍码\n队伍一,abcdefghjkmn', { status: 200, headers: { 'content-type': 'text/csv' } })
    }
    if (path === '/admin/api/login-history' && method === 'GET') {
      return new Response(JSON.stringify(loginHistory), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

async function mountPage() {
  const wrapper = mount(TeamCodesPage, { global: { plugins: [createPinia()] } })
  await waitFor(() => calls.some((c) => c.path === '/admin/api/team-codes'))
  await flush()
  return wrapper
}

describe('TeamCodesPage', () => {
  beforeEach(() => {
    localStorage.clear()
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: true },
    ]
    unassignedCount = 1
    loginHistory = []
    calls.length = 0
    mockFetch()
  })

  test('renders only coded teams with monospace codes and an unassigned summary', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()
    expect(text).toContain('队伍一')
    expect(text).toContain('icpc1')
    expect(text).toContain('abcdefghjkmn')
    // non-coded teams are not listed; the unassigned count is summarized instead
    expect(text).not.toContain('队伍二')
    expect(text).toContain('已发队伍码 1 / 2')
    expect(text).toContain('还有 1 个队伍未分配队伍码')
    expect(text).toContain('有密码')
    expect(wrapper.findAll('.code-text').length).toBeGreaterThanOrEqual(1)
    expect(text).toContain('导出内容包含 DOMjudge 密码，请妥善保管')
  })

  test('regenerate button confirms and POSTs generate with the row icpcId', async () => {
    const wrapper = await mountPage()
    const btn = wrapper.findAll('button').find((b) => b.text() === '重新生成')!
    await btn.trigger('click')
    await waitFor(() => calls.some((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/generate'))

    const post = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/generate')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post!.body))).toEqual({ icpcId: 'icpc1' })
  })

  test('批量生成 button POSTs generate with all:true', async () => {
    const wrapper = await mountPage()
    const btn = wrapper.findAll('button').find((b) => b.text() === '为未分配队伍批量生成')!
    await btn.trigger('click')
    await waitFor(() => calls.some((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/generate'))

    const post = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/generate')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post!.body))).toEqual({ all: true })
  })

  test('一键配置密码 confirms and POSTs provision with all:true', async () => {
    const wrapper = await mountPage()
    const btn = wrapper.findAll('button').find((b) => b.text() === '一键配置密码')!
    await btn.trigger('click')
    await waitFor(() => calls.some((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision'))

    const post = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post!.body))).toEqual({ all: true })
  })

  test('导出 CSV requests the export endpoint as a blob', async () => {
    const wrapper = await mountPage()
    const btn = wrapper.findAll('button').find((b) => b.text() === '导出 CSV')!
    await btn.trigger('click')
    await waitFor(() => calls.some((c) => c.method === 'GET' && c.path === '/admin/api/team-codes/export'))

    expect(calls.some((c) => c.method === 'GET' && c.path === '/admin/api/team-codes/export')).toBe(true)
  })

  test('shows a friendly empty state when no teams exist', async () => {
    teamCodeRows = []
    unassignedCount = 0
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('还没有队伍')
  })

  test('all-unassigned teams get a hint pointing at batch generation', async () => {
    teamCodeRows = []
    unassignedCount = 2
    const wrapper = await mountPage()
    const text = wrapper.text()
    expect(text).toContain('已发队伍码 0 / 2')
    expect(text).toContain('所有队伍都还没有队伍码')
  })

  test('history tab renders mocked login history newest first', async () => {
    loginHistory = [
      { icpcId: 'icpc2', teamCode: 'bbbbbbbbbbbb', at: '2026-11-07T11:00:00.000Z', ip: null },
      { icpcId: 'icpc1', teamCode: 'abcdefghjkmn', at: '2026-11-07T10:00:00.000Z', ip: '10.0.0.1' },
    ]
    const wrapper = await mountPage()
    const tabs = wrapper.findAll('.el-tabs__item')
    const historyTab = tabs.find((t) => t.text() === '登录历史')!
    await historyTab.trigger('click')
    await waitFor(() => calls.some((c) => c.path.startsWith('/admin/api/login-history')))

    expect(calls.some((c) => c.path.startsWith('/admin/api/login-history'))).toBe(true)
    // el-tabs keeps both panes mounted; scope assertions to the history pane
    const pane = wrapper.find('#pane-history')
    await waitFor(() => pane.findAll('.el-table__row').length >= 2)
    expect(pane.text()).toContain('icpc2')
    expect(pane.text()).toContain('icpc1')
    const rows = pane.findAll('.el-table__row')
    expect(rows.length).toBe(2)
    expect(rows[0].text()).toContain('icpc2')
    expect(rows[1].text()).toContain('icpc1')
  })
})

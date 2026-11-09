import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'
import type { LoginHistoryEntry, LoginRequest, TeamCodeRow } from '@/types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

const { default: AuthPage } = await import('./AuthPage.vue')

let teamCodeRows: TeamCodeRow[] = []
let unassignedCount = 0
let loginHistory: LoginHistoryEntry[] = []
let loginRequests: LoginRequest[] = []
let provisionHandler: ((body: { icpcId?: string; all?: boolean }) => Response | Promise<Response>) | null = null
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
      const body = JSON.parse(String(init?.body)) as { icpcId?: string; all?: boolean }
      if (provisionHandler) return provisionHandler(body)
      return new Response(JSON.stringify({ provisioned: 1, skipped: 0, errors: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/admin/api/team-codes/export' && method === 'GET') {
      return new Response('\uFEFF队伍名,队伍码\n队伍一,abcdefghjkmn', { status: 200, headers: { 'content-type': 'text/csv' } })
    }
    if (path === '/admin/api/login-history' && method === 'GET') {
      return new Response(JSON.stringify(loginHistory), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/admin/api/login-requests' && method === 'GET') {
      return new Response(JSON.stringify({ pending: loginRequests, recent: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

async function mountPage() {
  const wrapper = mount(AuthPage, { global: { plugins: [createPinia()] } })
  await waitFor(() => calls.some((c) => c.path === '/admin/api/team-codes'))
  await flush()
  return wrapper
}

describe('AuthPage', () => {
  beforeEach(() => {
    localStorage.clear()
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: true, djUsername: 'team1095218' },
    ]
    unassignedCount = 1
    loginHistory = []
    loginRequests = []
    provisionHandler = null
    calls.length = 0
    mockFetch()
  })

  /** ElDialog 默认不 teleport，对话框内容就在组件树里。 */
  function dialogText(wrapper: Awaited<ReturnType<typeof mountPage>>): string {
    return wrapper.text()
  }

  function dialogButton(wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) {
    return wrapper.findAll('button').find((b) => b.text() === label)
  }

  async function startProvision(): Promise<Awaited<ReturnType<typeof mountPage>>> {
    const wrapper = await mountPage()
    const btn = wrapper.findAll('button').find((b) => b.text() === '一键配置密码')!
    await btn.trigger('click')
    await waitFor(() => dialogText(wrapper).includes('正在配置') || dialogText(wrapper).includes('配置完成') || dialogText(wrapper).includes('已取消'))
    return wrapper
  }

  test('renders only coded teams with monospace codes and an unassigned summary', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()
    expect(text).toContain('队伍一')
    expect(text).toContain('icpc1')
    expect(text).toContain('abcdefghjkmn')
    expect(text).toContain('用户名')
    expect(text).toContain('team1095218')
    // non-coded teams are not listed; the unassigned count is summarized instead
    expect(text).not.toContain('队伍二')
    expect(text).toContain('已发队伍码 1 / 2')
    expect(text).toContain('还有 1 个队伍未分配队伍码')
    expect(text).toContain('有密码')
    expect(wrapper.findAll('.code-text').length).toBeGreaterThanOrEqual(1)
    expect(text).toContain('导出内容包含 DOMjudge 密码，请妥善保管')
  })

  test('shows an em dash when the DOMjudge username is not provisioned', async () => {
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: true, djUsername: null },
    ]
    const wrapper = await mountPage()
    const row = wrapper.findAll('.el-table__row')[0]
    expect(row.text()).toContain('—')
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

  test('一键配置密码 confirms then provisions each target team sequentially with its icpcId', async () => {
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: false, djUsername: 'team1095218' },
      { icpcId: 'icpc2', name: '队伍二', teamCode: 'bbbbbbbbbbbb', hasPassword: false, djUsername: null },
      { icpcId: 'icpc3', name: '队伍三', teamCode: 'cccccccccccc', hasPassword: true, djUsername: 'team3' },
    ]
    unassignedCount = 0
    const wrapper = await startProvision()
    await waitFor(() => calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision').length >= 2)
    await waitFor(() => dialogText(wrapper).includes('配置完成'))

    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision')
    // one call per target (icpc3 already has a password), each with its own icpcId
    expect(posts.map((p) => JSON.parse(String(p.body)))).toEqual([{ icpcId: 'icpc1' }, { icpcId: 'icpc2' }])
    expect(dialogText(wrapper)).toContain('成功 2')
    expect(dialogText(wrapper)).toContain('失败 0')
    // the list refreshed after provisioning finished
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/admin/api/team-codes').length).toBeGreaterThanOrEqual(2)
    expect(dialogText(wrapper)).toContain('关闭')
  })

  test('progress dialog shows the current team, live percentage and per-team results', async () => {
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: false, djUsername: null },
      { icpcId: 'icpc2', name: '队伍二', teamCode: 'bbbbbbbbbbbb', hasPassword: false, djUsername: null },
      { icpcId: 'icpc3', name: '队伍三', teamCode: 'cccccccccccc', hasPassword: false, djUsername: null },
    ]
    unassignedCount = 0
    provisionHandler = async (body) => {
      if (body.icpcId === 'icpc1') {
        return new Response(JSON.stringify({ provisioned: 1, skipped: 0, errors: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (body.icpcId === 'icpc2') {
        await delay(80)
        return new Response(JSON.stringify({ provisioned: 0, skipped: 1, errors: [{ icpcId: 'icpc2', reason: 'refusing non-team user' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ provisioned: 1, skipped: 0, errors: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const wrapper = await startProvision()
    await waitFor(() => calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision').length >= 2)
    // while icpc2's request is in flight the dialog shows the live line
    await waitFor(() => dialogText(wrapper).includes('队伍二（第 2 / 共 3 支）'))
    expect(dialogText(wrapper)).toContain('正在配置')
    await waitFor(() => dialogText(wrapper).includes('配置完成'))

    const text = dialogText(wrapper)
    expect(text).toContain('成功 2')
    expect(text).toContain('跳过 1')
    expect(text).toContain('该账号不是纯队伍账号')
    // the progress bar reflects completion (its text node doesn't render under happy-dom)
    const barInner = wrapper.find('.el-progress-bar__inner')
    expect(barInner.exists()).toBe(true)
    expect(barInner.attributes('style') ?? '').toContain('100%')
  })

  test('cancel stops the loop after the in-flight request finishes', async () => {
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: false, djUsername: null },
      { icpcId: 'icpc2', name: '队伍二', teamCode: 'bbbbbbbbbbbb', hasPassword: false, djUsername: null },
      { icpcId: 'icpc3', name: '队伍三', teamCode: 'cccccccccccc', hasPassword: false, djUsername: null },
    ]
    unassignedCount = 0
    provisionHandler = async (body) => {
      if (body.icpcId === 'icpc2') await delay(200)
      return new Response(JSON.stringify({ provisioned: 1, skipped: 0, errors: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const wrapper = await startProvision()
    await waitFor(() => calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision').length >= 2)

    const cancelBtn = dialogButton(wrapper, '取消')
    expect(cancelBtn).toBeDefined()
    await cancelBtn!.trigger('click')
    await waitFor(() => dialogText(wrapper).includes('已取消'))

    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision')
    expect(posts.length).toBe(2)
    expect(dialogText(wrapper)).toContain('成功 2')
    // 关闭 button replaces 取消 once the loop stops
    expect(dialogButton(wrapper, '关闭')).toBeDefined()
  })

  test('unmounting the page stops the loop after the in-flight request finishes', async () => {
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: false, djUsername: null },
      { icpcId: 'icpc2', name: '队伍二', teamCode: 'bbbbbbbbbbbb', hasPassword: false, djUsername: null },
      { icpcId: 'icpc3', name: '队伍三', teamCode: 'cccccccccccc', hasPassword: false, djUsername: null },
    ]
    unassignedCount = 0
    provisionHandler = async (body) => {
      if (body.icpcId === 'icpc2') await delay(150)
      return new Response(JSON.stringify({ provisioned: 1, skipped: 0, errors: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const wrapper = await startProvision()
    await waitFor(() => calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision').length >= 2)

    wrapper.unmount()
    await delay(300)

    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision')
    // no further provision (or list-refresh) requests after the page is gone
    expect(posts.length).toBe(2)
    // GET count = mount-time load + provision-start refresh; the finally-block
    // refresh must NOT run after unmount
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/admin/api/team-codes').length).toBe(2)
  })

  test('when every failure has the same reason a DOMjudge-permission hint is shown', async () => {
    teamCodeRows = [
      { icpcId: 'icpc1', name: '队伍一', teamCode: 'abcdefghjkmn', hasPassword: false, djUsername: null },
      { icpcId: 'icpc2', name: '队伍二', teamCode: 'bbbbbbbbbbbb', hasPassword: false, djUsername: null },
    ]
    unassignedCount = 0
    provisionHandler = () =>
      new Response(JSON.stringify({ provisioned: 0, skipped: 0, errors: [{ icpcId: 'x', reason: 'DOMjudge API 401 Unauthorized' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    const wrapper = await startProvision()
    await waitFor(() => dialogText(wrapper).includes('配置完成'))

    const text = dialogText(wrapper)
    expect(text).toContain('失败 2')
    expect(text).toContain('请检查 DOMjudge 账号是否具备用户管理(Admin)权限')
  })

  test('with no teams left to provision it shows an all-done message without calling the API', async () => {
    const wrapper = await mountPage()
    const btn = wrapper.findAll('button').find((b) => b.text() === '一键配置密码')!
    await btn.trigger('click')
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/admin/api/team-codes/provision')).toBe(false)
    expect(wrapper.text()).not.toContain('正在配置')
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

  test('history tab renders mocked login history newest first with team name labels', async () => {
    loginHistory = [
      { icpcId: 'icpc2', teamCode: 'bbbbbbbbbbbb', at: '2026-11-07T11:00:00.000Z', ip: null, teamName: '队伍二', djUsername: 'team2' },
      { icpcId: 'icpc1', teamCode: 'abcdefghjkmn', at: '2026-11-07T10:00:00.000Z', ip: '10.0.0.1', teamName: null, djUsername: null },
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
    expect(pane.text()).toContain('队伍二（team2）')
    expect(pane.text()).toContain('icpc1')
    const rows = pane.findAll('.el-table__row')
    expect(rows.length).toBe(2)
    expect(rows[0].text()).toContain('队伍二（team2）')
    // both enriched fields unknown → falls back to the raw icpcId
    expect(rows[1].text()).toContain('icpc1')
  })

  test('renders the 登录审批 card above the team-code tabs', async () => {
    loginRequests = [
      {
        id: 'lr1',
        icpcId: 'icpc1',
        teamCode: 'abcdefghjkmn',
        teamName: '队伍一',
        ip: '10.0.0.5',
        requestedAt: '2026-11-09T10:00:00.000Z',
        status: 'pending',
        decidedAt: null,
      },
    ]
    const wrapper = await mountPage()
    await waitFor(() => calls.some((c) => c.path === '/admin/api/login-requests'))
    await waitFor(() => wrapper.text().includes('暂无待审批') === false)

    const text = wrapper.text()
    expect(text).toContain('登录审批')
    // 登录审批卡片排在队伍码 tabs 之前
    const html = wrapper.html()
    expect(html.indexOf('登录审批')).toBeLessThan(html.indexOf('el-tabs'))
    expect(wrapper.findAll('button').some((b) => b.text() === '同意')).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text() === '拒绝')).toBe(true)
  })

  test('keeps every existing team-code action (tabs, batch generate, provision, export)', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()
    expect(text).toContain('已发队伍码 1 / 2')
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels).toContain('为未分配队伍批量生成')
    expect(labels).toContain('一键配置密码')
    expect(labels).toContain('导出 CSV')
    expect(wrapper.findAll('.el-tabs__item').map((t) => t.text())).toEqual(['队伍码', '登录历史'])
  })
})

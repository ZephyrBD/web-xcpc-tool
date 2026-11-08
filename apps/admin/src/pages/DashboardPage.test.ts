import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import DashboardPage from './DashboardPage.vue'
import type { LoginHistoryEntry, TeamCodeRow } from '@/types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let teamCodeRows: TeamCodeRow[] = []
let loginHistory: LoginHistoryEntry[] = []
let pendingPrintTasks: unknown[] = []
let pendingBalloonTasks: unknown[] = []
let originalFetch: typeof fetch | null = null
const getPaths: string[] = []

function mockFetch() {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/wxt/, '')
    getPaths.push(path + u.search)
    const body = (() => {
      if (path === '/admin/api/team-codes') return teamCodeRows
      if (path === '/admin/api/login-history') return loginHistory
      if (path === '/admin/api/print-tasks') return pendingPrintTasks
      if (path === '/admin/api/balloon-tasks') return pendingBalloonTasks
      return null
    })()
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function makeCodeRow(icpcId: string, withCode: boolean): TeamCodeRow {
  return { icpcId, name: `队伍 ${icpcId}`, teamCode: withCode ? `code-${icpcId}` : null, hasPassword: withCode, djUsername: null }
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  return mount(DashboardPage, { global: { plugins: [createPinia(), router] } })
}

describe('DashboardPage', () => {
  beforeEach(() => {
    localStorage.clear()
    teamCodeRows = []
    loginHistory = []
    pendingPrintTasks = []
    pendingBalloonTasks = []
    getPaths.length = 0
    mockFetch()
  })

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
  })

  test('renders four stat cards with counts aggregated from the list APIs', async () => {
    teamCodeRows = [makeCodeRow('t1', true), makeCodeRow('t2', true), makeCodeRow('t3', false)]
    loginHistory = [{ icpcId: 't1', teamCode: 'c', at: '2026-11-07T10:00:00.000Z', ip: null }]
    pendingPrintTasks = [{ id: 'p1' }]
    pendingBalloonTasks = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]

    const wrapper = await mountPage()
    await flush()
    await flush()

    const values = wrapper.findAll('.stat-value').map((n) => n.text())
    expect(values).toEqual(['2/3', '1', '3', '1'])

    const labels = wrapper.findAll('.stat-label').map((n) => n.text())
    expect(labels).toEqual(['已发队伍码', '待打任务', '待发气球', '最近登录'])

    // Each card consumes one brand hue via CSS variables (no hardcoded hex).
    const accents = wrapper.findAll('.stat-card').map((n) => n.attributes('style'))
    expect(accents.join(' ')).toContain('--card-accent')
  })

  test('queries team-codes, login-history (limit 5), and pending tasks', async () => {
    const wrapper = await mountPage()
    await flush()
    await flush()

    expect(getPaths).toContain('/admin/api/team-codes')
    expect(getPaths).toContain('/admin/api/login-history?limit=5')
    expect(getPaths).toContain('/admin/api/print-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/balloon-tasks?status=pending')
  })

  test('shows the friendly all-clear copy when nothing is pending', async () => {
    const wrapper = await mountPage()
    await flush()
    await flush()

    expect(wrapper.text()).toContain('现在一切正常，没有待办事项')
  })

  test('renders the latest login rows with a link to /team-codes', async () => {
    loginHistory = [
      { icpcId: 't6', teamCode: 'c6', at: '2026-11-07T09:00:00.000Z', ip: null },
      { icpcId: 't5', teamCode: 'c5', at: '2026-11-07T08:55:00.000Z', ip: null },
      { icpcId: 't4', teamCode: 'c4', at: '2026-11-07T08:50:00.000Z', ip: null },
      { icpcId: 't3', teamCode: 'c3', at: '2026-11-07T08:45:00.000Z', ip: null },
      { icpcId: 't2', teamCode: 'c2', at: '2026-11-07T08:40:00.000Z', ip: null },
      { icpcId: 't1', teamCode: 'c1', at: '2026-11-07T08:35:00.000Z', ip: null },
    ]

    const wrapper = await mountPage()
    await flush()
    await flush()

    const rows = wrapper.findAll('.dash-panel')[0].findAll('.panel-row')
    expect(rows.length).toBe(5)
    expect(rows[0].text()).toContain('t6')
    expect(wrapper.text()).not.toContain('t1')

    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toContain('/team-codes')
  })

  test('renders merged print + balloon job rows sorted by createdAt desc', async () => {
    pendingPrintTasks = [
      { id: 'p1', originalFilename: 'main.c.pdf', teamName: '队伍A', createdAt: '2026-11-07T08:00:00.000Z' },
    ]
    pendingBalloonTasks = [
      { id: 'b1', problemLabel: 'C', teamName: '队伍B', createdAt: '2026-11-07T08:30:00.000Z' },
    ]

    const wrapper = await mountPage()
    await flush()
    await flush()

    const rows = wrapper.findAll('.dash-panel')[1].findAll('.panel-row')
    expect(rows.length).toBe(2)
    // balloon (08:30) 排在 print (08:00) 前面
    expect(rows[0].text()).toContain('题目 C')
    expect(rows[0].text()).toContain('气球')
    expect(rows[1].text()).toContain('main.c.pdf')
    expect(rows[1].text()).toContain('打印')

    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toContain('/jobs')
  })

  test('shows friendly empty copy in both panels when nothing is pending', async () => {
    const wrapper = await mountPage()
    await flush()
    await flush()

    expect(wrapper.text()).toContain('还没有队伍登录')
    expect(wrapper.text()).toContain('打印和气球队列都空着')
  })

  test('stat cards link to their sections, 已发队伍码 goes to /team-codes', async () => {
    teamCodeRows = [makeCodeRow('t1', true)]
    const wrapper = await mountPage()
    await flush()
    await flush()

    const cards = wrapper.findAll('.stat-card').map((c) => c.attributes('href'))
    expect(cards).toEqual(['/team-codes', '/jobs', '/jobs', '/team-codes'])
  })
})

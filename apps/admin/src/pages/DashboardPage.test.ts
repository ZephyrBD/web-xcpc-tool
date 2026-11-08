import { beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import DashboardPage from './DashboardPage.vue'
import type { AuthTask } from '@/types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let pendingAuthTasks: AuthTask[] = []
let pendingPrintTasks: unknown[] = []
let pendingBalloonTasks: unknown[] = []
let teams: unknown[] = []
const getPaths: string[] = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/cxtool/, '')
    getPaths.push(path + u.search)
    const body = (() => {
      if (path === '/admin/api/auth-tasks') return pendingAuthTasks
      if (path === '/admin/api/print-tasks') return pendingPrintTasks
      if (path === '/admin/api/balloon-tasks') return pendingBalloonTasks
      if (path === '/admin/api/teams') return teams
      return null
    })()
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
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
    pendingAuthTasks = []
    pendingPrintTasks = []
    pendingBalloonTasks = []
    teams = []
    getPaths.length = 0
    mockFetch()
  })

  test('renders four stat cards with counts aggregated from the list APIs', async () => {
    pendingAuthTasks = [makeTask('1'), makeTask('2')]
    pendingPrintTasks = [{ id: 'p1' }]
    pendingBalloonTasks = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
    teams = [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }, { id: 't5' }]

    const wrapper = await mountPage()
    await flush()
    await flush()

    const values = wrapper.findAll('.stat-value').map((n) => n.text())
    expect(values).toEqual(['2', '1', '3', '5'])

    const labels = wrapper.findAll('.stat-label').map((n) => n.text())
    expect(labels).toEqual(['待审认证', '待打任务', '待发气球', '队伍数'])

    // Each card consumes one brand hue via CSS variables (no hardcoded hex).
    const accents = wrapper.findAll('.stat-card').map((n) => n.attributes('style'))
    expect(accents.join(' ')).toContain('--card-accent')
  })

  test('queries each source with status=pending except teams', async () => {
    const wrapper = await mountPage()
    await flush()
    await flush()

    expect(getPaths).toContain('/admin/api/auth-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/print-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/balloon-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/teams')
  })

  test('shows the friendly all-clear copy when nothing is pending', async () => {
    const wrapper = await mountPage()
    await flush()
    await flush()

    expect(wrapper.text()).toContain('现在一切正常，没有待办事项')
  })

  test('renders the latest pending auth rows with a link to /auth-tasks', async () => {
    pendingAuthTasks = [
      makeTask('1', { examNum: '2026001', createdAt: '2026-11-07T09:00:00.000Z' }),
      makeTask('2', { examNum: '2026002', createdAt: '2026-11-07T09:05:00.000Z' }),
      makeTask('3', { examNum: '2026003' }),
      makeTask('4', { examNum: '2026004' }),
      makeTask('5', { examNum: '2026005' }),
      makeTask('6', { examNum: '2026006' }),
    ]

    const wrapper = await mountPage()
    await flush()
    await flush()

    const rows = wrapper.findAll('.dash-panel')[0].findAll('.panel-row')
    expect(rows.length).toBe(5)
    expect(rows[0].text()).toContain('2026001')
    expect(wrapper.text()).not.toContain('2026006')

    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toContain('/auth-tasks')
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

    expect(wrapper.text()).toContain('没有待审的认证申请')
    expect(wrapper.text()).toContain('打印和气球队列都空着')
  })

  test('stat cards link to their sections, 队伍数 goes to /teams', async () => {
    teams = [{ id: 't1' }]
    const wrapper = await mountPage()
    await flush()
    await flush()

    const cards = wrapper.findAll('.stat-card').map((c) => c.attributes('href'))
    expect(cards).toEqual(['/auth-tasks', '/jobs', '/jobs', '/teams'])
  })
})

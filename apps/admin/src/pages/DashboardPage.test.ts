import { beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
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

    const wrapper = mount(DashboardPage, { global: { plugins: [createPinia()] } })
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
    const wrapper = mount(DashboardPage, { global: { plugins: [createPinia()] } })
    await flush()
    await flush()

    expect(getPaths).toContain('/admin/api/auth-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/print-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/balloon-tasks?status=pending')
    expect(getPaths).toContain('/admin/api/teams')
  })

  test('shows the friendly all-clear copy when nothing is pending', async () => {
    const wrapper = mount(DashboardPage, { global: { plugins: [createPinia()] } })
    await flush()
    await flush()

    expect(wrapper.text()).toContain('现在一切正常，没有待办事项')
  })
})

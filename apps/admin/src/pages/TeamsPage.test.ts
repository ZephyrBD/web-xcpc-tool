import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'
import type { DjTeam } from '@/pages/TeamsPage.vue'

// bun 的模块 mock 是进程级的，会漏到后续文件（App.test 会挂载真实路由页），
// 先留一份未被污染的命名空间，本文件跑完恢复。
const pristineElementPlus = { ...elementPlus }
const messageMock = {
  error: mock(() => ({})),
  success: mock(() => ({})),
}
mock.module('element-plus', () => ({
  ...pristineElementPlus,
  ElMessage: { ...pristineElementPlus.ElMessage, ...messageMock },
}))

const { default: TeamsPage } = await import('./TeamsPage.vue')

afterAll(() => {
  mock.module('element-plus', () => ({ ...pristineElementPlus }))
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let teams: DjTeam[] = []
// The contest id comes from 设置 → 比赛设置 now, so sync reads it from GET /admin/api/settings.
let settingsContestId = 'c1'
/** Non-null makes GET /admin/api/settings fail with this Chinese error. */
let settingsError: string | null = null
let settingsErrorStatus = 500
let syncResult:
  | { count: number }
  | { error?: string; message?: string; status: number }
  | null = null
/** Non-null makes GET /admin/api/teams fail with this Chinese error. */
let teamsError: string | null = null
const calls: Array<{ method: string; path: string; body: unknown; contentType?: string }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/wxt/, '')
    const method = init?.method ?? 'GET'
    let body: unknown = null
    let contentType: string | undefined
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    if (init?.body instanceof FormData) body = '[FormData]'
    const headers = (init?.headers ?? {}) as Record<string, string>
    contentType = headers['Content-Type']
    calls.push({ method, path, body, contentType })

    if (method === 'GET' && path === '/admin/api/teams') {
      if (teamsError) {
        return new Response(JSON.stringify({ error: teamsError }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(teams), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET' && path === '/admin/api/settings') {
      if (settingsError) {
        return new Response(JSON.stringify({ error: settingsError }), {
          status: settingsErrorStatus,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          domjudge: { baseUrl: 'http://dj.old', adminUser: 'djadmin', timeoutSeconds: 10 },
          balloon: { contestId: settingsContestId, pollIntervalSeconds: 30, locked: !!settingsContestId },
          print: { tokenMasked: '' },
          teamLogin: { start: '', end: '' },
          admin: { username: 'admin' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (method === 'POST' && path === '/admin/api/teams/sync') {
      if (syncResult && !('count' in syncResult)) {
        const { error, message, status } = syncResult
        return new Response(JSON.stringify({ ...(error ? { error } : {}), ...(message ? { message } : {}) }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(syncResult ?? { count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

function makeTeam(id: string, overrides: Partial<DjTeam> = {}): DjTeam {
  return {
    id,
    icpc_id: id.toUpperCase(),
    name: `队伍${id}`,
    members: ['张三', '李四'],
    location: { description: `机房 ${id}` },
    ...overrides,
  }
}

function mountPage() {
  return mount(TeamsPage, { global: { plugins: [createPinia()] } })
}

function findButton(wrapper: ReturnType<typeof mountPage>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))!
}

describe('TeamsPage', () => {
  beforeEach(() => {
    localStorage.clear()
    messageMock.error.mockClear()
    messageMock.success.mockClear()
    teams = [makeTeam('t1'), makeTeam('t2', { display_name: '展示名t2', members: undefined, location: undefined })]
    settingsContestId = 'c1'
    settingsError = null
    settingsErrorStatus = 500
    syncResult = { count: 2 }
    teamsError = null
    calls.length = 0
    mockFetch()
  })

  test('renders the team list without any password column', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    expect(wrapper.text()).toContain('T1')
    expect(wrapper.text()).toContain('队伍t1')
    expect(wrapper.text()).toContain('机房 t1')
    expect(wrapper.text()).toContain('张三、李四')
    expect(wrapper.text()).toContain('展示名t2')
    const tableText = wrapper.find('.el-table').text().toLowerCase()
    expect(tableText).not.toContain('password')
    expect(tableText).not.toContain('密码')
  })

  test('empty team list shows a friendly empty state', async () => {
    teams = []
    const wrapper = mountPage()
    await flush()
    await flush()
    expect(wrapper.text()).toContain('还没有队伍')
  })

  test('no contest id input: the id lives in 设置 → 比赛设置', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    expect(wrapper.find('input[placeholder*="比赛 ID"]').exists()).toBe(false)
    // 剩下的文本框只有 ElPagination 的页码框：位于分页条内，不在工具栏里。
    expect(wrapper.find('.teams-toolbar').findAll('input').length).toBe(0)
    expect(wrapper.text()).not.toContain('比赛 ID')
  })

  test('sync button posts the configured contestId and toasts the count', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = findButton(wrapper, '从 DOMjudge 同步')
    await btn.trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).not.toHaveBeenCalled()
    const syncCall = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/teams/sync')
    expect(syncCall).toBeDefined()
    expect(syncCall!.body).toEqual({ contestId: 'c1' })
    expect(messageMock.success).toHaveBeenCalledWith(expect.stringContaining('2'))
    expect(calls.some((c) => c.method === 'GET' && c.path === '/admin/api/teams')).toBe(true)
  })

  test('sync in a contest without a configured id shows a hint and does not call the API', async () => {
    settingsContestId = ''
    const wrapper = mountPage()
    await flush()
    await flush()

    await findButton(wrapper, '从 DOMjudge 同步').trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalledWith(expect.stringContaining('设置'))
    expect(calls.some((c) => c.path === '/admin/api/teams/sync')).toBe(false)
  })

  test('sync failure surfaces the server message and still refreshes the list', async () => {
    syncResult = { error: 'domjudge sync failed', status: 502 }
    const wrapper = mountPage()
    await flush()
    await flush()

    const getsBefore = calls.filter((c) => c.method === 'GET').length
    await findButton(wrapper, '从 DOMjudge 同步').trigger('click')
    await flush()
    await flush()

    // 服务端说了什么就展示什么，通用文案只在服务端什么都没给时兜底。
    expect(messageMock.error).toHaveBeenCalledWith('domjudge sync failed')
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(getsBefore)
  })

  test('sync failure prefers the server message field over error', async () => {
    syncResult = { error: 'sync_failed', message: 'DOMjudge 暂时连不上，请稍后重试', status: 502 }
    const wrapper = mountPage()
    await flush()
    await flush()

    await findButton(wrapper, '从 DOMjudge 同步').trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalledWith('DOMjudge 暂时连不上，请稍后重试')
  })

  test('sync failure with an empty body falls back to the friendly copy', async () => {
    syncResult = { status: 502 }
    const wrapper = mountPage()
    await flush()
    await flush()

    await findButton(wrapper, '从 DOMjudge 同步').trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalledWith('同步没成功，请检查 DOMjudge 是否可用后再试')
  })

  test('a settings failure while reading the contest id is not mistaken for a missing id', async () => {
    settingsError = '读取设置失败，请稍后重试'
    settingsErrorStatus = 500
    const wrapper = mountPage()
    await flush()
    await flush()

    await findButton(wrapper, '从 DOMjudge 同步').trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalledWith('读取设置失败，请稍后重试')
    expect(messageMock.error).not.toHaveBeenCalledWith(expect.stringContaining('还没有设置比赛 ID'))
    expect(calls.some((c) => c.path === '/admin/api/teams/sync')).toBe(false)
  })

  test('the list load failure also surfaces the server message', async () => {
    teamsError = '队伍数据损坏，请联系管理员'
    const wrapper = mountPage()
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalledWith('队伍数据损坏，请联系管理员')
  })

  test('paginates: 25 teams show 20 rows on page 1 and the rest on page 2', async () => {
    teams = Array.from({ length: 25 }, (_, i) => makeTeam(`t${i + 1}`))
    const wrapper = mountPage()
    await flush()
    await flush()

    const rows = () => wrapper.findAll('.el-table__body tbody tr').map((r) => r.text())
    expect(rows().length).toBe(20)
    expect(wrapper.text()).toContain('25')

    const { ElPagination } = await import('element-plus')
    const pagination = wrapper.findComponent(ElPagination)
    expect(pagination.exists()).toBe(true)
    pagination.vm.$emit('update:current-page', 2)
    await flush()

    const page2 = rows()
    expect(page2.length).toBe(5)
    expect(page2[0]).toContain('t21')
  })

  test('switching page size to 50 shows all teams on one page', async () => {
    teams = Array.from({ length: 25 }, (_, i) => makeTeam(`t${i + 1}`))
    const wrapper = mountPage()
    await flush()
    await flush()

    const { ElPagination } = await import('element-plus')
    wrapper.findComponent(ElPagination).vm.$emit('update:page-size', 50)
    await flush()

    expect(wrapper.findAll('.el-table__body tbody tr').length).toBe(25)
  })
})

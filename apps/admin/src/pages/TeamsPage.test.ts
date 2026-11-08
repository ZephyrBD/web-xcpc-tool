import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'
import type { DjTeam } from '../../../server/src/domjudge/client'

const messageMock = {
  error: mock(() => ({})),
  success: mock(() => ({})),
}
mock.module('element-plus', () => ({
  ...elementPlus,
  ElMessage: { ...elementPlus.ElMessage, ...messageMock },
}))

const { default: TeamsPage } = await import('./TeamsPage.vue')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let teams: DjTeam[] = []
let syncResult: { count: number } | { error: string; status: number } | null = null
let importResult: { imported: number; skipped: number } | { ok: false; reason: string; status: number } | null = null
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
      return new Response(JSON.stringify(teams), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'POST' && path === '/admin/api/teams/sync') {
      if (syncResult && 'error' in syncResult) {
        return new Response(JSON.stringify({ error: syncResult.error }), {
          status: syncResult.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(syncResult ?? { count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'POST' && path === '/admin/api/teams/import-excel') {
      if (importResult && 'ok' in importResult) {
        return new Response(JSON.stringify({ ok: false, reason: importResult.reason }), {
          status: importResult.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(importResult ?? { imported: 0, skipped: 0 }), {
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
    syncResult = { count: 2 }
    importResult = { imported: 3, skipped: 1 }
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

  test('sync button posts contestId from the input and toasts the count', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const input = wrapper.find('input[type="text"]')
    await input.setValue('c1')
    const btn = findButton(wrapper, '从 DOMjudge 同步')
    await btn.trigger('click')
    await flush()
    await flush()

    const syncCall = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/teams/sync')
    expect(syncCall).toBeDefined()
    expect(syncCall!.body).toEqual({ contestId: 'c1' })
    expect(messageMock.success).toHaveBeenCalledWith(expect.stringContaining('2'))
    expect(calls.some((c) => c.method === 'GET' && c.path === '/admin/api/teams')).toBe(true)
  })

  test('sync without a contest id shows a validation error and does not call the API', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = findButton(wrapper, '从 DOMjudge 同步')
    await btn.trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalled()
    expect(calls.some((c) => c.path === '/admin/api/teams/sync')).toBe(false)
  })

  test('sync failure shows a friendly error and still refreshes the list', async () => {
    syncResult = { error: 'domjudge sync failed', status: 502 }
    const wrapper = mountPage()
    await flush()
    await flush()

    await wrapper.find('input[type="text"]').setValue('c1')
    const getsBefore = calls.filter((c) => c.method === 'GET').length
    await findButton(wrapper, '从 DOMjudge 同步').trigger('click')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalledWith('同步没成功，请检查 DOMjudge 是否可用后再试')
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(getsBefore)
  })

  test('uploading an excel file posts FormData field "file" and shows imported/skipped', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const file = new File(['fake-excel'], 'teams.xlsx', { type: 'application/vnd.ms-excel' })
    const input = wrapper.find('input[type="file"]').element as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file] })
    await wrapper.find('input[type="file"]').trigger('change')
    await flush()
    await flush()

    const up = calls.find((c) => c.method === 'POST' && c.path === '/admin/api/teams/import-excel')
    expect(up).toBeDefined()
    expect(up!.body).toBe('[FormData]')
    expect(up!.contentType).toBeUndefined()
    expect(messageMock.success).toHaveBeenCalledWith('成功导入 3 个队伍，跳过 1 条')
  })

  test('an invalid excel file surfaces the server reason as a friendly message', async () => {
    importResult = { ok: false, reason: 'invalid excel file', status: 400 }
    const wrapper = mountPage()
    await flush()
    await flush()

    const file = new File(['nope'], 'teams.xlsx', { type: 'application/vnd.ms-excel' })
    const input = wrapper.find('input[type="file"]').element as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file] })
    await wrapper.find('input[type="file"]').trigger('change')
    await flush()
    await flush()

    expect(messageMock.error).toHaveBeenCalled()
    expect(messageMock.success).not.toHaveBeenCalled()
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

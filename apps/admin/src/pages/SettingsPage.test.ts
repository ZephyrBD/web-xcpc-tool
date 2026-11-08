import { beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'

const { default: SettingsPage } = await import('./SettingsPage.vue')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const settingsView = {
  port: 8080,
  contextPath: '/cxtool',
  domjudge: { baseUrl: 'http://dj.old', adminUser: 'djadmin', timeoutSeconds: 10 },
  balloon: { contestId: 'c1', pollIntervalSeconds: 30 },
  print: { tokenMasked: 'abcd***' },
  admin: { username: 'admin' },
}

let putCalls: Array<{ path: string; body: unknown }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/cxtool/, '')
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/admin/api/settings') {
      return new Response(JSON.stringify(settingsView), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'PUT' && path === '/admin/api/settings') {
      const body = JSON.parse(String(init?.body))
      putCalls.push({ path, body })
      return new Response(JSON.stringify({ ...settingsView, note: '已保存，重启服务后生效' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

function mountPage() {
  return mount(SettingsPage, { global: { plugins: [createPinia()] } })
}

describe('SettingsPage', () => {
  beforeEach(() => {
    putCalls = []
    mockFetch()
  })

  test('renders prefilled from GET /admin/api/settings', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const inputs = wrapper.findAll('input')
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('http://dj.old')
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('djadmin')
    const placeholders = inputs.map((i) => (i.element as HTMLInputElement).placeholder).join('|')
    expect(placeholders).toContain('留空则不修改')
    expect(wrapper.text()).toContain('拼接规则')
  })

  test('save PUTs the edited settings without empty secrets', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const baseUrlInput = wrapper.findAll('input')[0]!
    await baseUrlInput.setValue('http://dj.new')

    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    expect(saveBtn).toBeDefined()
    await saveBtn.trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(1)
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect(body.domjudge.baseUrl).toBe('http://dj.new')
    expect(body.domjudge.adminUser).toBe('djadmin')
    expect('adminPassword' in body.domjudge).toBe(false)
    expect('print' in body).toBe(false)
    expect(body.balloon).toEqual({ contestId: 'c1', pollIntervalSeconds: 30 })
    expect(body.admin).toEqual({ username: 'admin' })
  })

  test('save PUTs secrets only when the user typed them', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    // Password inputs: index 2 (DOMjudge password) and the print token input.
    await wrapper.findAll('input')[2]!.setValue('new-dj-pass')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect(body.domjudge.adminPassword).toBe('new-dj-pass')
    expect('print' in body).toBe(false)
  })
})

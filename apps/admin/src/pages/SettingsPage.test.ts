import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'

const { default: SettingsPage } = await import('./SettingsPage.vue')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const settingsView = {
  port: 8080,
  contextPath: '/wxt',
  domjudge: { baseUrl: 'http://dj.old', adminUser: 'djadmin', timeoutSeconds: 10 },
  balloon: { contestId: 'c1', pollIntervalSeconds: 30 },
  print: { tokenMasked: 'abcd***' },
  teamLogin: { start: '', end: '' },
  admin: { username: 'admin' },
}

let putCalls: Array<{ path: string; body: unknown }> = []
let originalFetch: typeof fetch | null = null

function mockFetch() {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/wxt/, '')
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

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
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

  test('生成 fills the print token input with a non-empty changed value', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    // The print token is the second password-type input on the page
    // (after the DOMjudge admin password, before the tool password fields).
    const target = wrapper.findAll('input[type="password"]')[1]!

    const genBtn = wrapper.findAll('button').find((b) => b.text() === '生成')!
    expect(genBtn).toBeDefined()
    await genBtn.trigger('click')
    await flush()

    const value = (target.element as HTMLInputElement).value
    expect(value).not.toBe('')
    expect(value).toBe(formToken(wrapper))
    expect(value.length).toBeGreaterThanOrEqual(16)
    // Second click produces a different token.
    await genBtn.trigger('click')
    expect(formToken(wrapper)).not.toBe(value)
  })

  test('复制 button exists next to the token field', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const copyBtn = wrapper.findAll('button').find((b) => b.text() === '复制')!
    expect(copyBtn).toBeDefined()
  })

  test('save PUTs the generated token', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const genBtn = wrapper.findAll('button').find((b) => b.text() === '生成')!
    await genBtn.trigger('click')
    await flush()
    const generated = formToken(wrapper)
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect((body.print as { token: string }).token).toBe(generated)
  })

  test('renders ownership labels for DOMjudge vs tool accounts', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const text = wrapper.text()
    expect(text).toContain('DOMjudge 平台')
    expect(text).toContain('DOMjudge 管理员用户名')
    expect(text).toContain('DOMjudge 管理员密码')
    expect(text).toContain('本工具自己的管理员账号')
    expect(text).toContain('新密码')
    expect(text).toContain('确认新密码')
  })

  test('mismatched password confirmation shows inline error and skips the PUT', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const pwInputs = wrapper.findAll('input[type="password"]')
    await pwInputs[2]!.setValue('abc12345')
    await pwInputs[3]!.setValue('different')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(0)
    expect(wrapper.text()).toContain('两次输入的新密码不一致')
  })

  test('whitespace-only new password shows inline error and skips the PUT', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const pwInputs = wrapper.findAll('input[type="password"]')
    await pwInputs[2]!.setValue('   ')
    await pwInputs[3]!.setValue('   ')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(0)
    expect(wrapper.text()).toContain('密码不能是空白字符')
  })

  test('matching new password is included in the PUT body', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const pwInputs = wrapper.findAll('input[type="password"]')
    await pwInputs[2]!.setValue('abc12345')
    await pwInputs[3]!.setValue('abc12345')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(1)
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect((body.admin as Record<string, unknown>).password).toBe('abc12345')
    expect(JSON.stringify(body)).not.toContain('passwordHash')
  })

  test('blank password fields omit password from the PUT body', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(1)
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect('password' in (body.admin as Record<string, unknown>)).toBe(false)
  })

  test('登录时段 empty inputs PUT empty strings (不限制)', async () => {
    const wrapper = await mountPage()
    await flush()
    await flush()
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    expect(wrapper.text()).toContain('登录时段')
    expect(wrapper.text()).toContain('留空表示不限制')
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect(body.teamLogin).toEqual({ start: '', end: '' })
  })

  test('datetime-local values are saved as ISO datetimes', async () => {
    settingsView.teamLogin = { start: '2026-11-08T02:00:00.000Z', end: '2026-11-08T06:00:00.000Z' }
    const wrapper = await mountPage()
    await flush()
    await flush()

    const datetimes = wrapper.findAll('input[type="datetime-local"]')
    expect(datetimes.length).toBe(2)
    await datetimes[0]!.setValue('2026-11-08T10:00')
    await datetimes[1]!.setValue('2026-11-08T12:00')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存设置')!
    await saveBtn.trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, { start: string; end: string }>
    expect(Date.parse(body.teamLogin.start)).toBe(Date.parse('2026-11-08T10:00'))
    expect(Date.parse(body.teamLogin.end)).toBe(Date.parse('2026-11-08T12:00'))
    settingsView.teamLogin = { start: '', end: '' }
  })
})

function formToken(wrapper: ReturnType<typeof mountPage>): string {
  const passwordInputs = wrapper.findAll('input[type="password"]')
  return (passwordInputs[1]!.element as HTMLInputElement).value
}

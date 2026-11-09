import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'

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

const { default: SettingsPage } = await import('./SettingsPage.vue')

afterAll(() => {
  mock.module('element-plus', () => ({ ...pristineElementPlus }))
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function defaultView() {
  return {
    port: 8080,
    contextPath: '/wxt',
    domjudge: { baseUrl: 'http://dj.old', adminUser: 'djadmin', timeoutSeconds: 10 },
    balloon: { contestId: 'c1', pollIntervalSeconds: 30, locked: true },
    print: { tokenMasked: 'abcd***' },
    teamLogin: { start: '', end: '' },
    admin: { username: 'admin' },
    version: { hash: 'abc1234', year: new Date().getFullYear() },
  }
}

let settingsView = defaultView()

let putCalls: Array<{ path: string; body: unknown }> = []
let purgeCalls: Array<{ method: string; path: string }> = []
let putError: { status: number; body: unknown } | null = null
let purgeError: { status: number; body: unknown } | null = null
let purgeReport = {
  teams: 3,
  passwords: 2,
  teamCodes: 2,
  printTasks: 4,
  balloonTasks: 5,
  loginHistory: 6,
  loginRequests: 1,
  filesRemoved: 7,
}
let originalFetch: typeof fetch | null = null

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function mockFetch() {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname.replace(/^\/wxt/, '')
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/admin/api/settings') return json(settingsView)
    if (method === 'PUT' && path === '/admin/api/settings') {
      putCalls.push({ path, body: JSON.parse(String(init?.body)) })
      if (putError) return json(putError.body, putError.status)
      return json({ ...settingsView, note: '已保存，立即生效（端口与访问前缀例外，修改后需重启）' })
    }
    if (method === 'POST' && path === '/admin/api/data/purge') {
      purgeCalls.push({ method, path })
      if (purgeError) return json(purgeError.body, purgeError.status)
      // The purge clears the id, so the next GET is unlocked.
      settingsView = {
        ...settingsView,
        balloon: { contestId: '', pollIntervalSeconds: settingsView.balloon.pollIntervalSeconds, locked: false },
      }
      return json(purgeReport)
    }
    return json({ error: 'not found' }, 404)
  }) as unknown as typeof fetch
}

function mountPage() {
  return mount(SettingsPage, { global: { plugins: [createPinia()] } })
}

type Wrapper = ReturnType<typeof mountPage>

async function mountReady(): Promise<Wrapper> {
  const wrapper = mountPage()
  await flush()
  await flush()
  return wrapper
}

function findButton(wrapper: Wrapper, text: string) {
  const btn = wrapper.findAll('button').find((b) => b.text() === text)
  if (!btn) throw new Error(`button not found: ${text}`)
  return btn
}

function hasButton(wrapper: Wrapper, text: string): boolean {
  return wrapper.findAll('button').some((b) => b.text() === text)
}

/** The contest id input is the text input whose placeholder names a contest. */
function contestInput(wrapper: Wrapper) {
  const input = wrapper.findAll('input').find((i) =>
    ((i.element as HTMLInputElement).placeholder ?? '').includes('DOMjudge 比赛 ID'),
  )
  if (!input) throw new Error('contest id input not found')
  return input
}

/** The purge confirmation field asks the operator to type 清空. */
function purgeConfirmInput(wrapper: Wrapper) {
  const input = wrapper.findAll('input').find((i) =>
    ((i.element as HTMLInputElement).placeholder ?? '').includes('清空'),
  )
  if (!input) throw new Error('purge confirm field not found')
  return input
}

const purgeButtonText = '清空数据'

function saveButton(wrapper: Wrapper) {
  return findButton(wrapper, '保存设置')
}

function formToken(wrapper: Wrapper): string {
  // 打印令牌排在 DOMjudge 管理员密码之后。
  return (wrapper.findAll('input[type="password"]')[1]!.element as HTMLInputElement).value
}

async function purgeNow(wrapper: Wrapper): Promise<void> {
  await purgeConfirmInput(wrapper).setValue('清空')
  await flush()
  await findButton(wrapper, purgeButtonText).trigger('click')
  // POST → refresh() → GET → 重渲染：留足微任务与宏任务的拍子。
  for (let i = 0; i < 6; i++) await flush()
}

/** A locked page keeps the purge block mounted, so counts and errors stay readable. */
async function purgePreservingUi(wrapper: Wrapper): Promise<void> {
  await purgeConfirmInput(wrapper).setValue('清空')
  await flush()
  await findButton(wrapper, purgeButtonText).trigger('click')
  await flush()
  await flush()
}

describe('SettingsPage', () => {
  beforeEach(() => {
    settingsView = defaultView()
    putCalls = []
    purgeCalls = []
    putError = null
    purgeError = null
    purgeReport = {
      teams: 3,
      passwords: 2,
      teamCodes: 2,
      printTasks: 4,
      balloonTasks: 5,
      loginHistory: 6,
      loginRequests: 1,
      filesRemoved: 7,
    }
    messageMock.error.mockClear()
    messageMock.success.mockClear()
    mockFetch()
  })

  test('renders prefilled from GET /admin/api/settings', async () => {
    const wrapper = await mountReady()
    const inputs = wrapper.findAll('input')
    // 比赛设置卡片在最前（比赛 ID / 轮询间隔），DOMjudge 连接随后。
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('c1')
    const domjudge = wrapper.findAll('.settings-card').find((c) => c.text().includes('拼接规则'))!
    const djInputs = domjudge.findAll('input')
    expect((djInputs[0]!.element as HTMLInputElement).value).toBe('http://dj.old')
    expect((djInputs[1]!.element as HTMLInputElement).value).toBe('djadmin')
    const placeholders = wrapper.findAll('input').map((i) => (i.element as HTMLInputElement).placeholder).join('|')
    expect(placeholders).toContain('留空则不修改')
  })

  test('比赛设置 is one card holding the contest id, poll interval and login window', async () => {
    const wrapper = await mountReady()
    const cards = wrapper.findAll('.settings-card').filter((c) => c.find('.card-title').text() === '比赛设置')
    expect(cards.length).toBe(1)
    const card = cards[0]!
    expect(card.text()).toContain('比赛 ID')
    expect(card.text()).toContain('轮询间隔')
    expect(card.text()).toContain('登录时段')
    expect(card.find('input[type="datetime-local"]').exists()).toBe(true)
    expect(card.find('input[placeholder*="DOMjudge 比赛 ID"]').exists()).toBe(true)
    // 登录时段不再单占一张卡片。
    const ownCard = wrapper.findAll('.settings-card').filter((c) => c.find('.card-title').text() === '登录时段')
    expect(ownCard.length).toBe(0)
  })

  test('locked contest id is read-only, shows the hint and the purge button', async () => {
    const wrapper = await mountReady()
    const input = contestInput(wrapper)
    expect((input.element as HTMLInputElement).readOnly).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('c1')

    const text = wrapper.text()
    expect(text).toContain('比赛 ID 已锁定')
    expect(text).toContain('如需更换请先清空比赛数据')
    expect(hasButton(wrapper, purgeButtonText)).toBe(true)
  })

  test('an empty contest id stays editable and hides the purge button', async () => {
    settingsView.balloon = { contestId: '', pollIntervalSeconds: 30, locked: false }
    const wrapper = await mountReady()
    const input = contestInput(wrapper)
    expect((input.element as HTMLInputElement).readOnly).toBe(false)
    expect((input.element as HTMLInputElement).value).toBe('')

    await input.setValue('c9')
    expect((input.element as HTMLInputElement).value).toBe('c9')
    // 还没有数据可清空。
    expect(hasButton(wrapper, purgeButtonText)).toBe(false)
  })

  test('save PUTs a freshly entered contest id when it was empty', async () => {
    settingsView.balloon = { contestId: '', pollIntervalSeconds: 30, locked: false }
    const wrapper = await mountReady()
    await contestInput(wrapper).setValue('c9')
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect(body.balloon).toEqual({ contestId: 'c9', pollIntervalSeconds: 30 })
  })

  test('save PUTs the edited settings without empty secrets', async () => {
    const wrapper = await mountReady()
    const domjudge = wrapper.findAll('.settings-card').find((c) => c.text().includes('拼接规则'))!
    await domjudge.findAll('input')[0]!.setValue('http://dj.new')

    await saveButton(wrapper).trigger('click')
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
    const wrapper = await mountReady()
    // 第一个 password 输入是 DOMjudge 管理员密码。
    await wrapper.findAll('input[type="password"]')[0]!.setValue('new-dj-pass')
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect(body.domjudge.adminPassword).toBe('new-dj-pass')
    expect('print' in body).toBe(false)
  })

  test('生成 fills the print token input with a non-empty changed value', async () => {
    const wrapper = await mountReady()
    const target = wrapper.findAll('input[type="password"]')[1]!

    const genBtn = findButton(wrapper, '生成')
    await genBtn.trigger('click')
    await flush()

    const value = (target.element as HTMLInputElement).value
    expect(value).not.toBe('')
    expect(value).toBe(formToken(wrapper))
    expect(value.length).toBeGreaterThanOrEqual(16)
    // 第二次生成得到不同令牌。
    await genBtn.trigger('click')
    expect(formToken(wrapper)).not.toBe(value)
  })

  test('复制 button exists next to the token field', async () => {
    const wrapper = await mountReady()
    expect(hasButton(wrapper, '复制')).toBe(true)
  })

  test('save PUTs the generated token', async () => {
    const wrapper = await mountReady()
    await findButton(wrapper, '生成').trigger('click')
    await flush()
    const generated = formToken(wrapper)
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect((body.print as { token: string }).token).toBe(generated)
  })

  test('renders ownership labels for DOMjudge vs tool accounts', async () => {
    const wrapper = await mountReady()
    const text = wrapper.text()
    expect(text).toContain('DOMjudge 平台')
    expect(text).toContain('DOMjudge 管理员用户名')
    expect(text).toContain('DOMjudge 管理员密码')
    expect(text).toContain('本工具自己的管理员账号')
    expect(text).toContain('新密码')
    expect(text).toContain('确认新密码')
  })

  test('mismatched password confirmation shows inline error and skips the PUT', async () => {
    const wrapper = await mountReady()
    const pwInputs = wrapper.findAll('input[type="password"]')
    // [0] DOMjudge 密码, [1] 打印令牌, [2] 新密码, [3] 确认新密码。
    await pwInputs[2]!.setValue('abc12345')
    await pwInputs[3]!.setValue('different')
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(0)
    expect(wrapper.text()).toContain('两次输入的新密码不一致')
  })

  test('whitespace-only new password shows inline error and skips the PUT', async () => {
    const wrapper = await mountReady()
    const pwInputs = wrapper.findAll('input[type="password"]')
    await pwInputs[2]!.setValue('   ')
    await pwInputs[3]!.setValue('   ')
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(0)
    expect(wrapper.text()).toContain('密码不能是空白字符')
  })

  test('matching new password is included in the PUT body', async () => {
    const wrapper = await mountReady()
    const pwInputs = wrapper.findAll('input[type="password"]')
    await pwInputs[2]!.setValue('abc12345')
    await pwInputs[3]!.setValue('abc12345')
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(1)
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect((body.admin as Record<string, unknown>).password).toBe('abc12345')
    expect(JSON.stringify(body)).not.toContain('passwordHash')
  })

  test('blank password fields omit password from the PUT body', async () => {
    const wrapper = await mountReady()
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(1)
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect('password' in (body.admin as Record<string, unknown>)).toBe(false)
  })

  test('登录时段 empty inputs PUT empty strings (不限制)', async () => {
    const wrapper = await mountReady()
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(wrapper.text()).toContain('登录时段')
    expect(wrapper.text()).toContain('留空表示不限制')
    const body = putCalls[0]!.body as Record<string, Record<string, unknown>>
    expect(body.teamLogin).toEqual({ start: '', end: '' })
  })

  test('datetime-local values are saved as ISO datetimes', async () => {
    settingsView.teamLogin = { start: '2026-11-08T02:00:00.000Z', end: '2026-11-08T06:00:00.000Z' }
    const wrapper = await mountReady()

    const datetimes = wrapper.findAll('input[type="datetime-local"]')
    expect(datetimes.length).toBe(2)
    await datetimes[0]!.setValue('2026-11-08T10:00')
    await datetimes[1]!.setValue('2026-11-08T12:00')
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, { start: string; end: string }>
    expect(Date.parse(body.teamLogin.start)).toBe(Date.parse('2026-11-08T10:00'))
    expect(Date.parse(body.teamLogin.end)).toBe(Date.parse('2026-11-08T12:00'))
  })

  test('清除时段 empties both datetime inputs and the next save PUTs empty strings', async () => {
    settingsView.teamLogin = { start: '2026-11-08T02:00:00.000Z', end: '2026-11-08T06:00:00.000Z' }
    const wrapper = await mountReady()

    const datetimes = wrapper.findAll('input[type="datetime-local"]')
    expect((datetimes[0]!.element as HTMLInputElement).value).not.toBe('')

    await findButton(wrapper, '清除时段').trigger('click')
    await flush()

    expect((datetimes[0]!.element as HTMLInputElement).value).toBe('')
    expect((datetimes[1]!.element as HTMLInputElement).value).toBe('')

    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    const body = putCalls[0]!.body as Record<string, { start: string; end: string }>
    expect(body.teamLogin).toEqual({ start: '', end: '' })
  })

  test('清除时段 is disabled while both fields are already empty', async () => {
    const wrapper = await mountReady()
    expect(findButton(wrapper, '清除时段').attributes('disabled')).toBeDefined()
  })

  test('版本信息 section shows the studio copyright and version hash', async () => {
    const wrapper = await mountReady()
    const section = wrapper.find('.version-card')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('版本信息')
    expect(section.text()).toContain('Modding Craft ZBD Studio')
    expect(section.text()).toContain('Version: abc1234')
  })

  test('the purge confirm button stays disabled until the exact word 清空 is typed', async () => {
    const wrapper = await mountReady()
    expect(findButton(wrapper, purgeButtonText).attributes('disabled')).toBeDefined()
    // 未确认前不发清空请求。
    expect(purgeCalls.length).toBe(0)

    const confirm = purgeConfirmInput(wrapper)
    await confirm.setValue('清 空')
    await flush()
    expect(findButton(wrapper, purgeButtonText).attributes('disabled')).toBeDefined()

    await confirm.setValue('清空数据')
    await flush()
    expect(findButton(wrapper, purgeButtonText).attributes('disabled')).toBeDefined()

    await confirm.setValue('清空')
    await flush()
    expect(findButton(wrapper, purgeButtonText).attributes('disabled')).toBeUndefined()
    // 只输入不点击，也不会触发。
    expect(purgeCalls.length).toBe(0)
  })

  test('the purge card lists what is deleted and what is kept', async () => {
    const wrapper = await mountReady()
    const text = wrapper.text()
    for (const item of [
      '队伍列表',
      '队伍账号密码',
      '队伍码',
      '登录历史',
      '审批记录',
      '打印任务',
      '留档',
      '气球任务',
      '把比赛 ID 置空',
      'secret.key',
    ]) {
      expect(text).toContain(item)
    }
  })

  test('typing 清空 and confirming POSTs the purge, then shows the deleted counts', async () => {
    const wrapper = await mountReady()
    await purgeNow(wrapper)

    expect(purgeCalls.length).toBe(1)
    expect(purgeCalls[0]!.method).toBe('POST')
    expect(purgeCalls[0]!.path).toBe('/admin/api/data/purge')
    expect(messageMock.success).toHaveBeenCalledWith('数据已清空，比赛 ID 已解锁')

    // 清空后解锁：比赛 ID 可编辑、已置空，清空区收起。
    await findButton(wrapper, '重新读取设置').trigger('click')
    await flush()
    await flush()
    const input = contestInput(wrapper)
    expect((input.element as HTMLInputElement).readOnly).toBe(false)
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('.purge-block').exists()).toBe(false)
  })

  test('the purge counts render on the same tick as the response', async () => {
    // 清空成功后页面会立即刷新并收起清空区；条数必须跟随返回值同步渲染，
    // 否则管理员永远看不到「删除了多少东西」。
    const wrapper = await mountReady()
    await purgeConfirmInput(wrapper).setValue('清空')
    await flush()
    await findButton(wrapper, purgeButtonText).trigger('click')
    await flush()

    const result = wrapper.find('.purge-result')
    expect(result.exists()).toBe(true)
    const resultText = result.text()
    expect(resultText).toContain('队伍 3 个')
    expect(resultText).toContain('账号密码 2 条')
    expect(resultText).toContain('队伍码 2 条')
    expect(resultText).toContain('登录历史 6 条')
    expect(resultText).toContain('审批记录 1 条')
    expect(resultText).toContain('打印任务 4 条')
    expect(resultText).toContain('气球任务 5 条')
    expect(resultText).toContain('留档文件 7 个')
  })

  test('a failed purge shows the server Chinese error, never a generic one', async () => {
    purgeError = { status: 500, body: { error: '清空数据失败，已清空部分数据，请再次点击清空' } }
    const wrapper = await mountReady()
    await purgePreservingUi(wrapper)

    expect(wrapper.find('.purge-block .field-error').text()).toContain(
      '清空数据失败，已清空部分数据，请再次点击清空',
    )
  })

  test('a 403 from PUT shows the server locked message as-is', async () => {
    putError = {
      status: 403,
      body: { error: 'contest id locked', message: '比赛 ID 已锁定，设置后不可修改；如需更换请先清空比赛数据' },
    }
    const wrapper = await mountReady()
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(putCalls.length).toBe(1)
    expect(wrapper.find('.save-error').text()).toContain(
      '比赛 ID 已锁定，设置后不可修改；如需更换请先清空比赛数据',
    )
    expect(messageMock.error).toHaveBeenCalledWith(
      '比赛 ID 已锁定，设置后不可修改；如需更换请先清空比赛数据',
    )
    expect(wrapper.text()).not.toContain('保存没成功')
  })

  test('a 400 from PUT surfaces the server error field', async () => {
    putError = { status: 400, body: { error: '配置格式不正确，请检查各字段后重试' } }
    const wrapper = await mountReady()
    await saveButton(wrapper).trigger('click')
    await flush()
    await flush()

    expect(wrapper.find('.save-error').text()).toContain('配置格式不正确，请检查各字段后重试')
  })

  test('no copy claims the save needs a restart; only the port / prefix / JWT note remains', async () => {
    const wrapper = await mountReady()
    const text = wrapper.text()
    expect(text).not.toContain('重启服务才生效')
    expect(text).not.toContain('保存后重启生效')
    expect(text).toContain('端口')
    expect(text).toContain('访问前缀')
    expect(text).toContain('JWT')
    expect(text).toContain('重启')
  })
})

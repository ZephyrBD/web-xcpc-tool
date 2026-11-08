import { beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import LoginPage from './LoginPage.vue'
import { useSessionStore } from '@/stores/session'
import { getToken } from '@/api'
import { routes } from '@/router'

function makeEnv() {
  const pinia = createPinia()
  const router = createRouter({ history: createMemoryHistory(), routes })
  return { pinia, router }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fillAndSubmit(wrapper: ReturnType<typeof mount>, username: string, password: string) {
  wrapper.find('input[name="username"]').setValue(username)
  wrapper.find('input[name="password"]').setValue(password)
  return wrapper.find('form').trigger('submit')
}

describe('LoginPage', () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    localStorage.clear()
    fetchCalls = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ error: 'mock' }), { status: 500 })
    }) as unknown as typeof fetch
  })

  test('submitting calls session.login which posts to /wxt/admin/api/login and stores the token', async () => {
    const { pinia, router } = makeEnv()
    await router.push('/')
    await router.isReady()
    const session = useSessionStore(pinia)
    const loginArgs: Array<[string, string]> = []
    const original = session.login
    session.login = async (u: string, p: string) => {
      loginArgs.push([u, p])
      await original(u, p)
    }

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ token: 'jwt-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const wrapper = mount(LoginPage, { global: { plugins: [pinia, router] } })
    await fillAndSubmit(wrapper, 'admin', 'secret-pw')
    await flush()

    expect(loginArgs).toEqual([['admin', 'secret-pw']])
    expect(fetchCalls.length).toBe(1)
    expect(new URL(fetchCalls[0].url).pathname).toBe('/wxt/admin/api/login')
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({ username: 'admin', password: 'secret-pw' })
    expect(getToken()).toBe('jwt-123')
    expect(router.currentRoute.value.path).toBe('/')
  })

  test('a 401 shows friendly inline copy instead of redirecting', async () => {
    const { pinia, router } = makeEnv()
    await router.push('/')
    await router.isReady()

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: '用户名或密码不对' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const wrapper = mount(LoginPage, { global: { plugins: [pinia, router] } })
    await fillAndSubmit(wrapper, 'admin', 'wrong')
    await flush()

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe('用户名或密码不对，再试一次？')
  })

  test('a 429 shows the rate-limit copy', async () => {
    const { pinia, router } = makeEnv()
    await router.push('/')
    await router.isReady()

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })) as unknown as typeof fetch

    const wrapper = mount(LoginPage, { global: { plugins: [pinia, router] } })
    await fillAndSubmit(wrapper, 'admin', 'wrong')
    await flush()

    expect(wrapper.find('[role="alert"]').text()).toBe('尝试太频繁了，请歇几分钟再来。')
  })
})

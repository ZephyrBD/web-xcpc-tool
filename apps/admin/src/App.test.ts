import { beforeEach, describe, expect, test } from 'bun:test'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAppRouter } from './router'
import { useSessionStore } from './stores/session'
import { clearToken, setToken } from './api'

// DashboardPage opens an SSE connection on mount; bun has no EventSource.
class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}
;(globalThis as Record<string, unknown>).EventSource ??= FakeEventSource

function mountApp() {
  const router = createAppRouter(createMemoryHistory())
  const pinia = createPinia()
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router],
    },
  })
  return { wrapper, pinia, router }
}

describe('App', () => {
  beforeEach(() => {
    clearToken()
    localStorage.removeItem('cxtool_token')
  })

  test('renders nav shell with links for the five routes', async () => {
    setToken('tok')
    const { wrapper, router } = mountApp()
    await router.push('/')
    await router.isReady()
    await wrapper.vm.$nextTick()

    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'))
    for (const route of ['/', '/team-codes', '/jobs', '/teams', '/api-list', '/help', '/settings']) {
      expect(hrefs).toContain(route)
    }
  })

  test('router guard redirects unauthenticated visits to /login', async () => {
    const { router } = mountApp()
    await router.push('/')
    await router.isReady()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  test('/login renders standalone: no nav shell, no page header', async () => {
    const { wrapper, router } = mountApp()
    await router.push('/login')
    await router.isReady()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.admin-layout').exists()).toBe(false)
    expect(wrapper.find('.layout-header').exists()).toBe(false)
    expect(wrapper.find('.login-page').exists()).toBe(true)
  })

  test('shows 退出 button and no 登录 link when authenticated; logout returns to login', async () => {
    setToken('tok')
    const { wrapper, pinia, router } = mountApp()
    useSessionStore(pinia)
    await router.push('/')
    await router.isReady()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.logout-btn').exists()).toBe(true)
    expect(wrapper.find('.login-link').exists()).toBe(false)

    await wrapper.find('.logout-btn').trigger('click')
    await flushPromises()
    const session = useSessionStore(pinia)
    expect(session.token).toBeNull()
    expect(router.currentRoute.value.path).toBe('/login')
    // 登录页是独立页面，不再渲染导航壳
    expect(wrapper.find('.logout-btn').exists()).toBe(false)
    expect(wrapper.find('.login-page').exists()).toBe(true)
  })
})

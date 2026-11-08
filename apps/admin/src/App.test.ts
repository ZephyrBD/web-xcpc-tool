import { beforeEach, describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import App from './App.vue'
import { routes } from './router'
import { useSessionStore } from './stores/session'
import { clearToken, setToken } from './api'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  })
}

function mountApp() {
  const router = makeRouter()
  const pinia = createPinia()
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router],
    },
  })
  return { wrapper, pinia }
}

describe('App', () => {
  beforeEach(() => {
    clearToken()
    localStorage.removeItem('cxtool_token')
  })

  test('renders nav shell with links for the five routes', async () => {
    const router = makeRouter()
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), router],
      },
    })

    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'))
    for (const route of ['/', '/login', '/team-codes', '/jobs', '/teams']) {
      expect(hrefs).toContain(route)
    }
  })

  test('shows 登录 link and no 退出 button when not authenticated', async () => {
    const { wrapper } = mountApp()
    expect(wrapper.find('.login-link').exists()).toBe(true)
    expect(wrapper.find('.logout-btn').exists()).toBe(false)
  })

  test('shows 退出 button and no 登录 link when authenticated; logout returns to login', async () => {
    setToken('tok')
    const { wrapper, pinia } = mountApp()
    useSessionStore(pinia)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.logout-btn').exists()).toBe(true)
    expect(wrapper.find('.login-link').exists()).toBe(false)

    await wrapper.find('.logout-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.login-link').exists()).toBe(true)
    expect(wrapper.find('.logout-btn').exists()).toBe(false)
  })
})

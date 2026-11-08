import { describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import App from './App.vue'
import { routes } from './router'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  })
}

describe('App', () => {
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
    for (const route of ['/', '/login', '/auth-tasks', '/jobs', '/teams']) {
      expect(hrefs).toContain(route)
    }
  })
})

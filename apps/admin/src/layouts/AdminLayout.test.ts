import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia } from 'pinia'
import AdminLayout from './AdminLayout.vue'
import { createAppRouter } from '@/router'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const versionPayload = {
  version: { hash: 'abc1234', year: new Date().getFullYear() },
}

let originalFetch: typeof fetch | null = null

function mockFetch(payload: unknown, status = 200): void {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

async function mountLayout() {
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  await router.isReady()
  const wrapper = mount(AdminLayout, {
    global: { plugins: [router, createPinia()] },
  })
  await flushPromises()
  return wrapper
}

describe('AdminLayout version footer', () => {
  beforeEach(() => {
    localStorage.removeItem('cxtool_token')
  })

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
    originalFetch = null
  })

  test('renders the copyright footer once the settings load', async () => {
    mockFetch(versionPayload)
    const wrapper = await mountLayout()
    const footer = wrapper.find('.layout-footer')
    expect(footer.exists()).toBe(true)
    expect(footer.text()).toContain('Copyright (c) 2018~')
    expect(footer.text()).toContain('Modding Craft ZBD Studio')
    expect(footer.text()).toContain('Version: abc1234')
  })

  test('omits the footer when the settings request fails', async () => {
    mockFetch({ message: 'boom' }, 500)
    const wrapper = await mountLayout()
    expect(wrapper.find('.layout-footer').exists()).toBe(false)
  })
})

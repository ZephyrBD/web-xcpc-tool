import { describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'

const { default: ApiListPage } = await import('./ApiListPage.vue')

describe('ApiListPage', () => {
  test('renders groups with known endpoint paths', () => {
    const wrapper = mount(ApiListPage, { global: { plugins: [createPinia()] } })
    expect(wrapper.text()).toContain('认证')
    expect(wrapper.text()).toContain('DOMjudge 代理')
    expect(wrapper.text()).toContain('管理端 API')
    expect(wrapper.text()).toContain('/dj/verify')
    expect(wrapper.text()).toContain('/dj/print')
    expect(wrapper.text()).toContain('/admin/api/teams')
    expect(wrapper.text()).toContain('/admin/api/settings')
  })
})

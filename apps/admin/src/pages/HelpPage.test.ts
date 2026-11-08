import { describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'

const { default: HelpPage } = await import('./HelpPage.vue')

describe('HelpPage', () => {
  test('renders the print callback contract with exact field names', () => {
    const wrapper = mount(HelpPage)
    const text = wrapper.text()
    expect(text).toContain('打印回调对接')
    expect(text).toContain('/cxtool/dj/print')
    expect(text).toContain('org.domjudge.print-token')
    expect(text).toContain('location')
    expect(text).toContain('teamname')
    expect(text).toContain('teamid')
    expect(text).toContain('original')
    expect(text).toContain('file')
    expect(text).toContain('curl')
  })

  test('renders the verify, DOMjudge config, and balloon sections', () => {
    const wrapper = mount(HelpPage)
    const text = wrapper.text()
    expect(text).toContain('队伍认证')
    expect(text).toContain('/dj/verify')
    expect(text).toContain('examNum')
    expect(text).toContain('DOMjudge 对接配置')
    expect(text).toContain('拼接规则')
    expect(text).toContain('气球流程')
    expect(text).toContain('SSE')
  })
})

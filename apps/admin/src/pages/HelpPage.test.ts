import { describe, expect, test } from 'bun:test'
import { mount } from '@vue/test-utils'

const { default: HelpPage } = await import('./HelpPage.vue')

describe('HelpPage', () => {
  test('renders the print callback contract with exact field names', () => {
    const wrapper = mount(HelpPage)
    const text = wrapper.text()
    expect(text).toContain('打印回调对接')
    expect(text).toContain('/wxt/print')
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
    expect(text).toContain('队伍码登录')
    expect(text).toContain('/wxt/public/verify')
    expect(text).toContain('X-DOMjudge-Login')
    expect(text).toContain('队伍码')
    expect(text).toContain('OMS 检测')
    expect(text).not.toContain('examNum')
    // 登录审批流程：等待页 + 登录审批页同意 + 仅当次有效
    expect(text).toContain('登录时段之外（未开始或已结束）队伍输入队伍码会进入等待页')
    expect(text).toContain('「认证管理 → 登录审批」中同意后该队伍自动完成登录')
    expect(text).toContain('审批仅当次有效')
    expect(text).toContain('DOMjudge 对接配置')
    expect(text).toContain('拼接规则')
    expect(text).toContain('气球流程')
    expect(text).toContain('SSE')
  })

  test('documents the contest lock, restart-only fields, log file and proxy headers', () => {
    const wrapper = mount(HelpPage)
    const text = wrapper.text()
    // 比赛 ID 锁定 + 唯一解锁 = 清空数据
    expect(text).toContain('比赛 ID 写一次即锁定')
    expect(text).toContain('输入确认词「清空」')
    expect(text).toContain('secret.key 保留')
    // 气球数据源与 stale 语义
    expect(text).toContain('/contests/{id}/balloons')
    expect(text).toContain('已隐藏')
    expect(text).toContain('balloon not found')
    // 路径布局：工具挂 /wxt，DOMjudge 走站点根路径
    expect(text).toContain('站点根路径')
    // baseUrl 带路径前缀支持
    expect(text).toContain('路径前缀')
    // 升级不迁移旧数据
    expect(text).toContain('升级不迁移旧数据')
    // 重启项只有端口 / JWT
    expect(text).toContain('需要重启并重新登录的只有两项')
    // 日志位置、格式与脱敏
    expect(text).toContain('data/logs/latest.log')
    expect(text).toContain('[I]')
    expect(text).toContain('********')
    // nginx 必须转发 Host 与 X-Forwarded-Proto
    expect(text).toContain('X-Forwarded-Proto')
    expect(text).toContain('cross-origin forbidden')
    // 不再引用旧实现
    expect(text).not.toContain('旧 Java')
  })
})

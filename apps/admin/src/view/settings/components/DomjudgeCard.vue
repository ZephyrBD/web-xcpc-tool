<script setup lang="ts">
import ElInput from '@/components/el/ElInput.vue'
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

defineProps<{ form: SettingsFormStore }>()

defineOptions({ name: 'DomjudgeCard' })
</script>

<template>
  <section class="settings_card">
    <h2 class="card_title">DOMjudge 连接</h2>
    <span class="field_help">
      这里填写的是 <b>DOMjudge 平台</b>的管理员账号（用于本工具调用 DOMjudge 的 API，如同步队伍、拉取判题结果），
      不是本工具自己的登录账号。
    </span>
    <label class="field">
      <span class="field_label">Base URL</span>
      <ElInput v-model="form.form.domjudgeBaseUrl" placeholder="https://domjudge.example.com" />
      <span class="field_help">
        指向 <b>DOMjudge 本身</b>的地址，不带 <code>/api</code> 后缀。拼接规则：本工具按
        <code>baseUrl + /api/v4/contests/...</code> 调 DOMjudge API；队伍浏览器访问的
        DOMjudge 页面走站点根路径 <code>/</code> 反代到 baseUrl（自带路径前缀时会自动剥掉）。
      </span>
    </label>
    <label class="field">
      <span class="field_label">DOMjudge 管理员用户名</span>
      <ElInput v-model="form.form.domjudgeAdminUser" placeholder="DOMjudge 平台的管理员账号" />
    </label>
    <label class="field">
      <span class="field_label">DOMjudge 管理员密码</span>
      <ElInput
        v-model="form.form.domjudgeAdminPassword"
        type="password"
        show-password
        placeholder="留空则不修改"
      />
    </label>
  </section>
</template>

<style scoped lang="scss">
@use './card_shared' as *;
</style>

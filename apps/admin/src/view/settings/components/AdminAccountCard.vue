<script setup lang="ts">
import ElInput from '@/components/el/ElInput.vue'
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

defineProps<{ form: SettingsFormStore }>()

defineOptions({ name: 'AdminAccountCard' })
</script>

<template>
  <section class="settings_card">
    <h2 class="card_title">管理端账号</h2>
    <span class="field_help">
      这是<b>本工具自己的管理员账号</b>（登录本管理台用），与 DOMjudge 平台的账号无关。
    </span>
    <label class="field">
      <span class="field_label">用户名</span>
      <ElInput v-model="form.form.adminUsername" placeholder="本工具管理台登录用户名" />
    </label>
    <label class="field">
      <span class="field_label">新密码</span>
      <ElInput
        v-model="form.form.adminPassword"
        type="password"
        show-password
        placeholder="留空则不修改"
      />
    </label>
    <label class="field">
      <span class="field_label">确认新密码</span>
      <ElInput
        v-model="form.form.adminPasswordConfirm"
        type="password"
        show-password
        placeholder="再次输入新密码"
      />
      <span v-if="form.adminPasswordError.value" class="field_error">{{ form.adminPasswordError.value }}</span>
      <span v-else class="field_help">用户名与密码保存后立即生效，下次登录使用新账号。</span>
    </label>
  </section>
</template>

<style scoped lang="scss">
@use './card_shared' as *;
</style>

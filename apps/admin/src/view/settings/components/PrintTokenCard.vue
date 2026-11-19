<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElInput from '@/components/el/ElInput.vue'
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

defineProps<{ form: SettingsFormStore }>()

defineOptions({ name: 'PrintTokenCard' })
</script>

<template>
  <section class="settings_card">
    <h2 class="card_title">打印回调 Token</h2>
    <label class="field">
      <span class="field_label">Token</span>
      <ElInput v-model="form.form.printToken" type="password" show-password placeholder="留空则不修改" />
      <div class="token_actions">
        <ElButton size="small" @click="form.generateToken">生成</ElButton>
        <ElButton size="small" @click="form.copyToken">复制</ElButton>
      </div>
      <span class="field_help">
        当前：{{ form.printTokenMasked.value || '未设置' }}。生成一个随机令牌，需要同步填到
        DOMjudge 的打印配置里（header <code>org.domjudge.print-token</code>）。
      </span>
    </label>
  </section>
</template>

<style scoped lang="scss">
@use './card_shared' as *;
</style>

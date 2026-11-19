<script setup lang="ts">
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

defineProps<{ form: SettingsFormStore }>()

defineOptions({ name: 'VersionCard' })
</script>

<template>
  <section v-if="form.versionInfo.value" class="settings_card version_card" aria-label="版本信息">
    <h2 class="card_title">版本信息</h2>
    <p class="version_line">
      Copyright (c) 2018~{{ form.versionInfo.value.year }} Modding Craft ZBD Studio, Version: {{ form.versionInfo.value.hash }}
    </p>
  </section>
</template>

<style scoped lang="scss">
@use './card_shared' as *;

.version_line {
  margin: 0;
  font-size: var(--text-13);
  color: var(--text-muted);
}
</style>

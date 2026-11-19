<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import { useSettingsForm } from '@/view/settings/composables/useSettingsForm'
import { usePurge } from '@/view/settings/composables/usePurge'
import ContestCard from '@/view/settings/components/ContestCard.vue'
import DomjudgeCard from '@/view/settings/components/DomjudgeCard.vue'
import PrintTokenCard from '@/view/settings/components/PrintTokenCard.vue'
import AdminAccountCard from '@/view/settings/components/AdminAccountCard.vue'
import VersionCard from '@/view/settings/components/VersionCard.vue'
defineOptions({ name: 'Settings' })

const form = useSettingsForm()
// 保存成功后旧的清空结果不再代表当前状态。
const purge = usePurge(form.form, form.pullSettings, (msg) => (form.refreshError.value = msg))

function onSave(): void {
  void form.save(purge.resetReport)
}
</script>

<template>
  <div class="settings page_fill">
    <div class="settings_grid">
      <ContestCard :form="form" :purge="purge" />
      <DomjudgeCard :form="form" />
      <PrintTokenCard :form="form" />
      <AdminAccountCard :form="form" />
    </div>

    <div class="settings_footer">
      <ElButton type="primary" :loading="form.saving.value" :disabled="!form.loaded.value" @click="onSave">保存设置</ElButton>
      <span class="footer_note">
        保存后立即生效；端口与 JWT 密钥例外，修改后需重启并重新登录。
      </span>
    </div>
    <p v-if="form.saveError.value" class="field_error save_error">{{ form.saveError.value }}</p>
    <p v-if="form.refreshError.value" class="refresh_error" role="alert">{{ form.refreshError.value }}</p>
    <p v-if="form.loading.value" class="footer_note">正在读取当前设置…</p>

    <VersionCard :form="form" />
  </div>
</template>

<style scoped lang="scss">
@use './components/card_shared' as *;

.settings_grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 960px) {
  .settings_grid {
    grid-template-columns: 1fr;
  }
}

/* 比赛设置是本页的主卡片：跨两列并带品牌色描边；宽屏下其余三卡两列均分。 */
.settings_grid > :deep(.contest_card) {
  grid-column: 1 / -1;
}

@media (min-width: 961px) {
  /* 三张下级卡片在两列网格里均分高度，避免被主卡片挤扁。 */
  .settings_grid > :deep(.settings_card:not(.contest_card)) {
    min-height: 100%;
  }
}

.settings_footer {
  margin-top: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.footer_note {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.save_error {
  margin: 8px 0 0;
}

.refresh_error {
  margin: 8px 0 0;
  font-size: var(--text-13);
  color: var(--danger-text);
  line-height: 1.6;
}
</style>

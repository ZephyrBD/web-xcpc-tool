<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElInput from '@/components/el/ElInput.vue'
import PurgeSection from '@/view/settings/components/PurgeSection.vue'
import type { PurgeStore } from '@/view/settings/composables/usePurge'
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

defineProps<{ form: SettingsFormStore; purge: PurgeStore }>()

defineOptions({ name: 'ContestCard' })
</script>

<template>
  <section class="settings_card contest_card">
    <h2 class="card_title">比赛设置</h2>
    <span class="field_help">
      填写本场比赛的 DOMjudge 比赛 ID 与气球轮询间隔，并设置队伍码登录的允许时段。
    </span>

    <h3 class="group_title">比赛绑定</h3>
    <label class="field">
      <span class="field_label">比赛 ID（contestId）</span>
      <ElInput
        v-model="form.form.balloonContestId"
        placeholder="DOMjudge 比赛 ID"
        :readonly="form.contestLocked.value"
      />
      <span v-if="form.contestLocked.value" class="lock_hint">
        <span class="lock_badge">已锁定</span>
        比赛 ID 已锁定，如下一场比赛请先清空数据
      </span>
      <span v-else class="field_help">
        保存后即锁定；气球任务会绑定到这场比赛上，想换比赛要先清空数据。
      </span>
    </label>
    <label class="field">
      <span class="field_label">轮询间隔（秒）</span>
      <ElInput
        v-model.number="form.form.balloonPollIntervalSeconds"
        type="number"
        :min="1"
        @input="form.pollIntervalTouched.value = true"
      />
      <span v-if="form.showPollIntervalError.value" class="field_error poll_error">轮询间隔需为正整数</span>
    </label>

    <div class="card_divider" role="separator"></div>

    <h3 class="group_title">队伍码登录时段</h3>
    <span class="field_help">留空表示不限制；登录时段外队伍码无法登入。</span>
    <div class="login_window_row">
      <label class="field">
        <span class="field_label">开始时间</span>
        <input v-model="form.form.teamLoginStart" class="datetime_input" type="datetime-local" />
      </label>
      <label class="field">
        <span class="field_label">结束时间</span>
        <input v-model="form.form.teamLoginEnd" class="datetime_input" type="datetime-local" />
      </label>
      <div class="token_actions">
        <ElButton
          size="small"
          :disabled="form.form.teamLoginStart === '' && form.form.teamLoginEnd === ''"
          @click="form.clearTeamLogin"
        >清除时段</ElButton>
      </div>
    </div>

    <PurgeSection :form="form" :purge="purge" />
  </section>
</template>

<style scoped lang="scss">
@use './card_shared' as *;

.contest_card {
  border-color: color-mix(in srgb, var(--brand-blue) 35%, transparent);
  background: color-mix(in srgb, var(--brand-blue) 5%, var(--bg-alt));
}

.contest_card .card_title {
  color: var(--brand-blue);
  font-size: var(--text-17);
}

.lock_hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.6;
}

.lock_badge {
  flex-shrink: 0;
  padding: 1px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--brand-orange);
  border: 1px solid color-mix(in srgb, var(--brand-orange) 35%, transparent);
  background: color-mix(in srgb, var(--brand-orange) 12%, transparent);
}

.login_window_row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.login_window_row .field {
  flex: 1 1 200px;
}

.login_window_row .token_actions {
  padding-bottom: 4px;
}

.datetime_input {
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg);
  padding: 6px 10px;
  font-size: var(--text-15);
  color: var(--text);
  font-family: var(--font-body);
}

</style>

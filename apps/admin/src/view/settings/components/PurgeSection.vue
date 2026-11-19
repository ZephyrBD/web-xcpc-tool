<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElInput from '@/components/el/ElInput.vue'
import type { PurgeStore } from '@/view/settings/composables/usePurge'
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

defineProps<{ form: SettingsFormStore; purge: PurgeStore }>()

defineOptions({ name: 'PurgeSection' })
</script>

<template>
  <div>
    <template v-if="form.contestLocked.value">
      <div class="card_divider" role="separator"></div>

      <h3 class="group_title">危险操作</h3>
      <button
        type="button"
        class="purge_toggle"
        :aria-expanded="purge.purgeExpanded.value"
        @click="purge.purgeExpanded.value = !purge.purgeExpanded.value"
      >
        <span>危险操作 · 清空数据</span>
        <span class="purge_toggle_action">{{ purge.purgeExpanded.value ? '收起' : '展开' }}</span>
      </button>
      <div v-if="purge.purgeExpanded.value" class="purge_block">
        <p class="field_help">清空后比赛 ID 解锁，可以重新配置另一场比赛。此操作不可撤销。</p>
        <ul class="purge_list">
          <li>
            <span class="purge_tag purge_tag--danger">删除</span>
            队伍列表、队伍账号密码、队伍码、登录历史、审批记录、打印任务与留档源码/PDF、气球任务，并把比赛 ID 置空
          </li>
          <li>
            <span class="purge_tag purge_tag--keep">保留</span>
            其余设置（DOMjudge 连接、打印令牌、登录时段、管理端账号）、secret.key
          </li>
        </ul>
        <label class="field">
          <span class="field_label">请输入「{{ purge.PURGE_WORD }}」以确认</span>
          <ElInput v-model="purge.purgeConfirm.value" :placeholder="`输入${purge.PURGE_WORD}以启用按钮`" />
          <span v-if="purge.purgeConfirm.value.trim() !== '' && !purge.purgeReady.value" class="purge_confirm_hint">
            请输入「{{ purge.PURGE_WORD }}」两个中文字，才能启用按钮
          </span>
        </label>
        <div class="token_actions">
          <ElButton
            type="danger"
            :loading="purge.purging.value"
            :disabled="!purge.purgeReady.value"
            @click="purge.purge"
          >清空数据</ElButton>
        </div>
        <p v-if="purge.purgeError.value" class="field_error">{{ purge.purgeError.value }}</p>
      </div>
    </template>
    <!-- 清空结果独立成浅色条：刷新解锁后危险操作区整体收起，条数仍然可见。 -->
    <div v-if="purge.purgeReport.value" class="purge_result">
      <p class="purge_result_title">已清空：</p>
      <p class="purge_result_line">
        队伍 {{ purge.purgeReport.value.teams }} 个 · 账号密码 {{ purge.purgeReport.value.passwords }} 条 · 队伍码
        {{ purge.purgeReport.value.teamCodes }} 条 · 登录历史 {{ purge.purgeReport.value.loginHistory }} 条 · 审批记录
        {{ purge.purgeReport.value.loginRequests }} 条 · 打印任务 {{ purge.purgeReport.value.printTasks }} 条 · 气球任务
        {{ purge.purgeReport.value.balloonTasks }} 条 · 留档文件 {{ purge.purgeReport.value.filesRemoved }} 个
      </p>
      <p v-if="!form.purgeIdRefilled.value" class="purge_result_hint">比赛 ID 已置空，可以填写下一场比赛了。</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use './card_shared' as *;

.purge_toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  border: 1px solid color-mix(in srgb, var(--brand-red) 30%, transparent);
  background: color-mix(in srgb, var(--brand-red) 6%, transparent);
  color: var(--brand-red);
  font-family: var(--font-body);
  font-size: var(--text-13);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.purge_toggle:hover {
  background: color-mix(in srgb, var(--brand-red) 12%, transparent);
}

.purge_toggle_action {
  font-weight: 400;
  color: var(--text-muted);
}

.purge_block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: var(--radius-card);
  border: 1px solid color-mix(in srgb, var(--brand-red) 30%, transparent);
  background: color-mix(in srgb, var(--brand-red) 6%, transparent);
}

.purge_list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.7;
}

.purge_tag {
  display: inline-block;
  margin-right: 8px;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  border: 1px solid transparent;
}

.purge_tag--danger {
  color: var(--brand-red);
  border-color: color-mix(in srgb, var(--brand-red) 35%, transparent);
  background: color-mix(in srgb, var(--brand-red) 12%, transparent);
}

.purge_tag--keep {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.purge_result {
  margin-top: 2px;
  padding: 12px 14px;
  border-radius: var(--radius-control);
  border: 1px solid color-mix(in srgb, var(--brand-green) 30%, transparent);
  background: color-mix(in srgb, var(--brand-green) 8%, transparent);
}

.purge_result_title {
  margin: 0 0 4px;
  font-size: var(--text-15);
  font-weight: 600;
  color: var(--brand-green);
}

.purge_result_line {
  margin: 0;
  font-size: var(--text-13);
  color: var(--text);
  line-height: 1.7;
}

.purge_result_hint {
  margin: 6px 0 0;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.purge_confirm_hint {
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.6;
}
</style>

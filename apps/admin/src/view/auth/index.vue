<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { messageError } from '@/lib/feedback'
import ElTabPane from '@/components/el/ElTabPane.vue'
import ElTabs from '@/components/el/ElTabs.vue'
import { apiFetch } from '@/api'
import { useTeamCodes } from '@/view/auth/composables/useTeamCodes'
import { useProvision } from '@/view/auth/composables/useProvision'
import TeamCodesPane from '@/view/auth/components/TeamCodesPane.vue'
import HistoryPane from '@/view/auth/components/HistoryPane.vue'
import ProvisionDialog from '@/view/auth/components/ProvisionDialog.vue'
import LoginRequestsCard from '@/view/auth/components/LoginRequestsCard.vue'
import type { LoginHistoryEntry } from '@/types'
defineOptions({ name: 'Auth' })

const activeTab = ref<'codes' | 'history'>('codes')

const codes = useTeamCodes()
const provision = useProvision(codes.refresh, () => codes.rows.value)

const history = ref<LoginHistoryEntry[]>([])

async function refreshHistory(): Promise<void> {
  try {
    history.value = await apiFetch<LoginHistoryEntry[]>('/admin/api/login-history', { query: { limit: 100 } })
  } catch {
    messageError('登录历史加载失败，请刷新重试')
  }
}

function onTabChange(): void {
  if (activeTab.value === 'history' && history.value.length === 0) void refreshHistory()
}

onMounted(() => void codes.refresh())
</script>

<template>
  <div class="auth_page page_fill">
    <LoginRequestsCard />
    <ElTabs v-model="activeTab" class="code_tabs" @tab-change="onTabChange">
      <ElTabPane label="队伍码" name="codes">
        <TeamCodesPane :codes="codes" :provision="provision" />
      </ElTabPane>

      <ElTabPane label="登录历史" name="history">
        <HistoryPane :history="history" />
      </ElTabPane>
    </ElTabs>

    <ProvisionDialog :provision="provision" />
  </div>
</template>

<style scoped lang="scss">
.code_tabs {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* Tab content stretches to the leftover viewport height; tables scroll
   internally and the pagination footer stays visible inside the fill area. */
.code_tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.code_tabs :deep(.el-tab-pane) {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
</style>

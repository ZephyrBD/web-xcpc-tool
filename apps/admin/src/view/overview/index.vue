<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { apiFetch } from '@/api'
import { useSse } from '@/composables/useSse'
import type { BalloonTask, LoginHistoryEntry, PrintTask, TeamCodeRow } from '@/types'
import StatCards from '@/view/overview/components/StatCards.vue'
import RecentLoginsPanel from '@/view/overview/components/RecentLoginsPanel.vue'
import PendingJobsPanel from '@/view/overview/components/PendingJobsPanel.vue'
defineOptions({ name: 'Overview' })

const teamCodeRows = ref<TeamCodeRow[]>([])
const loginHistory = ref<LoginHistoryEntry[]>([])
const printTasks = ref<PrintTask[]>([])
const balloonTasks = ref<BalloonTask[]>([])
const loaded = ref(false)

async function refresh(): Promise<void> {
  // 气球服务可能未启用（503）等：单项失败显示 “—” 而不是拖垮整页。
  const [codes, history, print, balloon] = await Promise.allSettled([
    apiFetch<TeamCodeRow[]>('/admin/api/team-codes'),
    apiFetch<LoginHistoryEntry[]>('/admin/api/login-history', { query: { limit: 5 } }),
    apiFetch<PrintTask[]>('/admin/api/print-tasks', { query: { status: 'pending' } }),
    apiFetch<BalloonTask[]>('/admin/api/balloon-tasks', { query: { status: 'pending' } }),
  ])
  teamCodeRows.value = codes.status === 'fulfilled' && Array.isArray(codes.value) ? codes.value : []
  loginHistory.value = history.status === 'fulfilled' && Array.isArray(history.value) ? history.value : []
  printTasks.value = print.status === 'fulfilled' && Array.isArray(print.value) ? print.value : []
  balloonTasks.value = balloon.status === 'fulfilled' && Array.isArray(balloon.value) ? balloon.value : []
  loaded.value = true
}

// SSE 变更采用 300ms 防抖合并刷新：一次事件风暴只触发一次请求。
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 300)
}

useSse(() => scheduleRefresh())

const cards = computed(() => [
  {
    label: '已发队伍码',
    value: teamCodeRows.value.length ? `${teamCodeRows.value.filter((r) => r.teamCode).length}/${teamCodeRows.value.length}` : null,
    accent: 'var(--brand-purple)',
    to: '/auth',
  },
  { label: '待打任务', value: printTasks.value.length, accent: 'var(--brand-orange)', to: '/jobs' },
  { label: '待发气球', value: balloonTasks.value.length, accent: 'var(--brand-green)', to: '/jobs' },
  { label: '最近登录', value: loginHistory.value.length || null, accent: 'var(--brand-blue)', to: '/auth' },
])

const allClear = computed(
  () =>
    loaded.value &&
    printTasks.value.length === 0 &&
    balloonTasks.value.length === 0,
)

onMounted(() => void refresh())
onUnmounted(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
})
</script>

<template>
  <div class="dash page_fill">
    <p v-if="allClear" class="dash_clear">现在一切正常，没有待办事项 🎉</p>
    <StatCards :cards="cards" />

    <div class="dash_panels">
      <RecentLoginsPanel :history="loginHistory" />
      <PendingJobsPanel :print-tasks="printTasks" :balloon-tasks="balloonTasks" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.dash_clear {
  margin: 0 0 20px;
  font-size: var(--text-15);
  color: var(--text-muted);
  flex-shrink: 0;
}

.dash_panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-top: 20px;
  flex: 1;
  min-height: 0;
}

@media (max-width: 768px) {
  .dash_panels {
    grid-template-columns: 1fr;
  }
}
</style>

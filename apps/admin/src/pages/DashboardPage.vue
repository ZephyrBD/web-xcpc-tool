<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { apiFetch } from '@/api'
import { useSse } from '@/composables/useSse'
import { loginHistoryLabel } from '@/types'
import type { BalloonTask, LoginHistoryEntry, PrintTask, TeamCodeRow } from '@/types'

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

const recentLogins = computed(() => loginHistory.value.slice(0, 5))

interface JobRow {
  kind: 'print' | 'balloon'
  title: string
  teamName: string
  createdAt: string
}

const pendingJobs = computed<JobRow[]>(() => {
  const rows: JobRow[] = [
    ...printTasks.value.map((t) => ({
      kind: 'print' as const,
      title: t.originalFilename,
      teamName: t.teamName,
      createdAt: t.createdAt,
    })),
    ...balloonTasks.value.map((t) => ({
      kind: 'balloon' as const,
      title: `题目 ${t.problemLabel}`,
      teamName: t.teamName,
      createdAt: t.createdAt,
    })),
  ]
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 5)
})

const allClear = computed(
  () =>
    loaded.value &&
    printTasks.value.length === 0 &&
    balloonTasks.value.length === 0,
)

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => void refresh())
onUnmounted(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
})
</script>

<template>
  <div class="dash page-fill">
    <p v-if="allClear" class="dash-clear">现在一切正常，没有待办事项 🎉</p>
    <div class="dash-grid">
      <RouterLink
        v-for="card in cards"
        :key="card.label"
        :to="card.to"
        class="stat-card"
        :style="{ '--card-accent': card.accent }"
      >
        <span class="stat-dot" aria-hidden="true"></span>
        <span class="stat-value">{{ card.value ?? '—' }}</span>
        <span class="stat-label">{{ card.label }}</span>
      </RouterLink>
    </div>

    <div class="dash-panels">
      <section class="dash-panel">
        <div class="panel-head">
          <h2 class="panel-title">最近登录</h2>
          <RouterLink to="/auth" class="panel-link">查看全部 →</RouterLink>
        </div>
        <ul v-if="recentLogins.length" class="panel-list">
          <li v-for="entry in recentLogins" :key="entry.at" class="panel-row">
            <span class="row-main">{{ loginHistoryLabel(entry) }}</span>
            <span class="row-sub">{{ formatTime(entry.at) }}</span>
          </li>
        </ul>
        <p v-else class="panel-empty">还没有队伍登录，静悄悄的 🙂</p>
      </section>

      <section class="dash-panel">
        <div class="panel-head">
          <h2 class="panel-title">最新任务</h2>
          <RouterLink to="/jobs" class="panel-link">查看全部 →</RouterLink>
        </div>
        <ul v-if="pendingJobs.length" class="panel-list">
          <li v-for="(job, i) in pendingJobs" :key="`${job.kind}-${i}`" class="panel-row">
            <span class="job-pill" :class="job.kind === 'print' ? 'job-pill--print' : 'job-pill--balloon'">
              {{ job.kind === 'print' ? '打印' : '气球' }}
            </span>
            <span class="row-main">{{ job.title }}</span>
            <span class="row-team">{{ job.teamName }}</span>
            <span class="row-sub">{{ formatTime(job.createdAt) }}</span>
          </li>
        </ul>
        <p v-else class="panel-empty">打印和气球队列都空着，随时候命 🙂</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dash-clear {
  margin: 0 0 20px;
  font-size: var(--text-15);
  color: var(--text-muted);
  flex-shrink: 0;
}

.dash-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
  flex-shrink: 0;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 24px;
  border: 1px solid var(--border);
  border-top: 3px solid var(--card-accent);
  border-radius: var(--radius-card);
  background: var(--bg);
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.15s ease;
}

.stat-card:hover {
  box-shadow: var(--shadow-card);
}

.stat-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--card-accent);
}

.stat-value {
  font-family: var(--font-heading);
  font-size: var(--text-44);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.stat-label {
  font-size: var(--text-15);
  color: var(--text-muted);
}

.dash-panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-top: 20px;
  flex: 1;
  min-height: 0;
}

.dash-panel {
  padding: 20px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg);
  overflow: auto;
  min-height: 0;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-title {
  font-size: var(--text-20);
}

.panel-link {
  font-size: var(--text-13);
  text-decoration: none;
  color: var(--text-muted);
}

.panel-link:hover {
  color: var(--accent);
}

.panel-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.panel-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  font-size: var(--text-15);
}

.panel-row:first-child {
  border-top: none;
}

.row-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-team {
  color: var(--text-muted);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  color: var(--text-muted);
  font-size: var(--text-13);
  flex-shrink: 0;
}

.job-pill {
  flex-shrink: 0;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--text-13);
  border: 1px solid transparent;
}

.job-pill--print {
  color: var(--brand-orange);
  border-color: color-mix(in srgb, var(--brand-orange) 35%, transparent);
  background: color-mix(in srgb, var(--brand-orange) 12%, transparent);
}

.job-pill--balloon {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.panel-empty {
  margin: 0;
  padding: 16px 0 4px;
  font-size: var(--text-15);
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .dash-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dash-panels {
    grid-template-columns: 1fr;
  }

  .row-team {
    display: none;
  }
}
</style>

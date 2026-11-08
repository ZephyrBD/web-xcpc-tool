<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { apiFetch } from '@/api'
import { useSse } from '@/composables/useSse'
import type { AuthTask } from '@/types'

const pendingAuth = ref<number | null>(null)
const pendingPrint = ref<number | null>(null)
const pendingBalloon = ref<number | null>(null)
const teamCount = ref<number | null>(null)
const loaded = ref(false)

async function refresh(): Promise<void> {
  // 气球服务可能未启用（503）等：单项失败显示 “—” 而不是拖垮整页。
  const [auth, print, balloon, teams] = await Promise.allSettled([
    apiFetch<AuthTask[]>('/admin/api/auth-tasks', { query: { status: 'pending' } }),
    apiFetch<unknown[]>('/admin/api/print-tasks', { query: { status: 'pending' } }),
    apiFetch<unknown[]>('/admin/api/balloon-tasks', { query: { status: 'pending' } }),
    apiFetch<unknown[]>('/admin/api/teams'),
  ])
  pendingAuth.value = auth.status === 'fulfilled' ? auth.value.length : null
  pendingPrint.value = print.status === 'fulfilled' ? print.value.length : null
  pendingBalloon.value = balloon.status === 'fulfilled' ? balloon.value.length : null
  teamCount.value = teams.status === 'fulfilled' ? teams.value.length : null
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
  { label: '待审认证', value: pendingAuth.value, accent: 'var(--brand-purple)' },
  { label: '待打任务', value: pendingPrint.value, accent: 'var(--brand-orange)' },
  { label: '待发气球', value: pendingBalloon.value, accent: 'var(--brand-green)' },
  { label: '队伍数', value: teamCount.value, accent: 'var(--brand-blue)' },
])

const allClear = computed(
  () =>
    loaded.value &&
    pendingAuth.value === 0 &&
    pendingPrint.value === 0 &&
    pendingBalloon.value === 0,
)

onMounted(() => void refresh())
onUnmounted(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
})
</script>

<template>
  <div class="dash">
    <p v-if="allClear" class="dash-clear">现在一切正常，没有待办事项 🎉</p>
    <div class="dash-grid">
      <div
        v-for="card in cards"
        :key="card.label"
        class="stat-card"
        :style="{ '--card-accent': card.accent }"
      >
        <span class="stat-dot" aria-hidden="true"></span>
        <span class="stat-value">{{ card.value ?? '—' }}</span>
        <span class="stat-label">{{ card.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash-clear {
  margin: 0 0 20px;
  font-size: var(--text-15);
  color: var(--text-muted);
}

.dash-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
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

@media (max-width: 768px) {
  .dash-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import type { BalloonTask, PrintTask } from '@/types'

const props = defineProps<{ printTasks: PrintTask[]; balloonTasks: BalloonTask[] }>()

defineOptions({ name: 'PendingJobsPanel' })

interface JobRow {
  kind: 'print' | 'balloon'
  title: string
  teamName: string
  createdAt: string
}

const pendingJobs = computed<JobRow[]>(() => {
  const rows: JobRow[] = [
    ...props.printTasks.map((t) => ({
      kind: 'print' as const,
      title: t.originalFilename,
      teamName: t.teamName,
      createdAt: t.createdAt,
    })),
    ...props.balloonTasks.map((t) => ({
      kind: 'balloon' as const,
      title: `题目 ${t.problemLabel}`,
      teamName: t.teamName,
      createdAt: t.createdAt,
    })),
  ]
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 5)
})

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <section class="dash_panel">
    <div class="panel_head">
      <h2 class="panel_title">最新任务</h2>
      <RouterLink to="/jobs" class="panel_link">查看全部 →</RouterLink>
    </div>
    <ul v-if="pendingJobs.length" class="panel_list">
      <li v-for="(job, i) in pendingJobs" :key="`${job.kind}-${i}`" class="panel_row">
        <span class="job_pill" :class="job.kind === 'print' ? 'job_pill--print' : 'job_pill--balloon'">
          {{ job.kind === 'print' ? '打印' : '气球' }}
        </span>
        <span class="row_main">{{ job.title }}</span>
        <span class="row_team">{{ job.teamName }}</span>
        <span class="row_sub">{{ formatTime(job.createdAt) }}</span>
      </li>
    </ul>
    <p v-else class="panel_empty">打印和气球队列都空着，随时候命 🙂</p>
  </section>
</template>

<style scoped lang="scss">
.dash_panel {
  padding: 20px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg);
  overflow: auto;
  min-height: 0;
}

.panel_head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel_title {
  font-size: var(--text-20);
}

.panel_link {
  font-size: var(--text-13);
  text-decoration: none;
  color: var(--text-muted);
}

.panel_link:hover {
  color: var(--accent);
}

.panel_list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.panel_row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  font-size: var(--text-15);
}

.panel_row:first-child {
  border-top: none;
}

.row_main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row_team {
  color: var(--text-muted);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row_sub {
  color: var(--text-muted);
  font-size: var(--text-13);
  flex-shrink: 0;
}

.job_pill {
  flex-shrink: 0;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--text-13);
  border: 1px solid transparent;
}

.job_pill--print {
  color: var(--brand-orange);
  border-color: color-mix(in srgb, var(--brand-orange) 35%, transparent);
  background: color-mix(in srgb, var(--brand-orange) 12%, transparent);
}

.job_pill--balloon {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.panel_empty {
  margin: 0;
  padding: 16px 0 4px;
  font-size: var(--text-15);
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .row_team {
    display: none;
  }
}
</style>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElButton, ElMessage, ElTable, ElTableColumn, ElTabPane, ElTabs } from 'element-plus'
import { apiFetch } from '@/api'
import { useSse } from '@/composables/useSse'
import type { BalloonTask, PrintTask } from '@/types'

const activeTab = ref('print')
const printTasks = ref<PrintTask[]>([])
const balloonTasks = ref<BalloonTask[]>([])

async function refreshPrint(): Promise<void> {
  try {
    printTasks.value = await apiFetch<PrintTask[]>('/admin/api/print-tasks')
  } catch {
    // 轮询失败不打断页面，下一条 SSE 事件会再触发刷新。
  }
}

async function refreshBalloon(): Promise<void> {
  try {
    balloonTasks.value = await apiFetch<BalloonTask[]>('/admin/api/balloon-tasks')
  } catch {
    // 同上：气球服务可能未启用（503），静默等待下次刷新。
  }
}

async function refresh(): Promise<void> {
  await Promise.all([refreshPrint(), refreshBalloon()])
}

// SSE 变更按事件类型分流到对应 Tab 的列表，各自 300ms 防抖合并刷新。
let printTimer: ReturnType<typeof setTimeout> | null = null
let balloonTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh(event: 'print-task' | 'balloon-task'): void {
  const which = event === 'print-task' ? 'print' : 'balloon'
  const timer = which === 'print' ? printTimer : balloonTimer
  if (timer) clearTimeout(timer)
  const set = () => {
    if (which === 'print') printTimer = null
    else balloonTimer = null
  }
  const t = setTimeout(() => {
    set()
    void (which === 'print' ? refreshPrint() : refreshBalloon())
  }, 300)
  if (which === 'print') printTimer = t
  else balloonTimer = t
}

useSse((event) => {
  if (event === 'print-task' || event === 'balloon-task') scheduleRefresh(event)
})

const printStatusLabels: Record<string, string> = {
  pending: '待打印',
  printed: '已打印',
  failed: '打印失败',
}

const balloonStatusLabels: Record<string, string> = {
  pending: '待派送',
  delivered: '已派送',
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

async function ackPrint(row: PrintTask, status: 'printed' | 'failed'): Promise<void> {
  try {
    await apiFetch(`/admin/api/print-tasks/${row.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  } catch {
    ElMessage.error('操作没成功，请再试一次')
  } finally {
    await refreshPrint()
  }
}

async function ackBalloon(row: BalloonTask): Promise<void> {
  try {
    await apiFetch(`/admin/api/balloon-tasks/${row.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  } catch {
    ElMessage.error('操作没成功，请再试一次')
  } finally {
    await refreshBalloon()
  }
}

onMounted(() => void refresh())
onUnmounted(() => {
  if (printTimer) clearTimeout(printTimer)
  if (balloonTimer) clearTimeout(balloonTimer)
})
</script>

<template>
  <div class="jobs">
    <el-tabs v-model="activeTab" class="jobs-tabs">
      <el-tab-pane label="打印任务" name="print">
        <el-table v-if="printTasks.length" :data="printTasks">
          <el-table-column prop="location" label="位置" min-width="110" />
          <el-table-column prop="teamName" label="队伍" min-width="140" />
          <el-table-column prop="originalFilename" label="文件名" min-width="180" show-overflow-tooltip />
          <el-table-column label="状态" min-width="110">
            <template #default="{ row }">
              <span class="pill" :class="`pill--${row.status}`">
                {{ printStatusLabels[row.status as string] ?? row.status }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="提交时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="170">
            <template #default="{ row }">
              <template v-if="row.status === 'pending'">
                <el-button size="small" type="primary" @click="ackPrint(row as PrintTask, 'printed')">标记已打</el-button>
                <el-button size="small" type="danger" plain @click="ackPrint(row as PrintTask, 'failed')">标记失败</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="empty-state">
          <svg class="empty-art" viewBox="0 0 160 110" aria-hidden="true">
            <circle cx="80" cy="52" r="38" fill="var(--brand-orange)" opacity="0.15" />
            <rect x="50" y="34" width="60" height="34" rx="8" fill="var(--brand-orange)" opacity="0.85" />
            <rect x="60" y="58" width="40" height="22" rx="4" fill="var(--brand-blue)" opacity="0.85" />
            <rect x="66" y="64" width="28" height="4" rx="2" fill="var(--bg)" opacity="0.9" />
            <rect x="66" y="72" width="20" height="4" rx="2" fill="var(--bg)" opacity="0.6" />
            <circle cx="30" cy="30" r="5" fill="var(--brand-green)" opacity="0.7" />
            <circle cx="132" cy="76" r="4" fill="var(--brand-blue)" opacity="0.7" />
          </svg>
          <p class="empty-copy">打印队列空空的</p>
        </div>
      </el-tab-pane>
      <el-tab-pane label="气球任务" name="balloon">
        <el-table v-if="balloonTasks.length" :data="balloonTasks">
          <el-table-column prop="problemLabel" label="题目" min-width="90" />
          <el-table-column prop="teamName" label="队伍" min-width="150" />
          <el-table-column label="位置" min-width="110">
            <template #default="{ row }">{{ row.location ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="110">
            <template #default="{ row }">
              <span class="pill" :class="`pill--${row.status}`">
                {{ balloonStatusLabels[row.status as string] ?? row.status }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="产生时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="110">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending'"
                size="small"
                type="primary"
                @click="ackBalloon(row as BalloonTask)"
              >标记已送</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="empty-state">
          <svg class="empty-art" viewBox="0 0 160 110" aria-hidden="true">
            <circle cx="80" cy="44" r="26" fill="var(--brand-green)" opacity="0.2" />
            <ellipse cx="80" cy="44" rx="20" ry="25" fill="var(--brand-green)" opacity="0.85" />
            <path d="M80 69 q-4 6 0 10 q4 -4 0 -10" fill="var(--brand-orange)" opacity="0.9" />
            <circle cx="36" cy="66" r="5" fill="var(--brand-orange)" opacity="0.7" />
            <circle cx="126" cy="30" r="4" fill="var(--brand-blue)" opacity="0.7" />
          </svg>
          <p class="empty-copy">还没有气球要送</p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--text-13);
  border: 1px solid transparent;
}

.pill--pending {
  color: var(--brand-orange);
  border-color: color-mix(in srgb, var(--brand-orange) 35%, transparent);
  background: color-mix(in srgb, var(--brand-orange) 12%, transparent);
}

.pill--printed,
.pill--delivered {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.pill--failed {
  color: var(--brand-red);
  border-color: color-mix(in srgb, var(--brand-red) 35%, transparent);
  background: color-mix(in srgb, var(--brand-red) 12%, transparent);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
}

.empty-art {
  width: 160px;
  height: 110px;
}

.empty-copy {
  margin: 0;
  font-size: var(--text-15);
  color: var(--text-muted);
}
</style>

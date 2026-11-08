<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElButton, ElMessage, ElPagination, ElSwitch, ElTable, ElTableColumn, ElTabPane, ElTabs } from 'element-plus'
import { apiFetch } from '@/api'
import { useSse } from '@/composables/useSse'
import { usePagination } from '@/composables/usePagination'
import { printPdfTask } from '@/utils/printPdf'
import { printBalloonTask } from '@/utils/printBalloon'
import type { BalloonTask, PrintTask } from '@/types'

const activeTab = ref('print')
const printTasks = ref<PrintTask[]>([])
const balloonTasks = ref<BalloonTask[]>([])
const { page: printPage, pageSize: printPageSize, paged: pagedPrintTasks } = usePagination(printTasks)
const { page: balloonPage, pageSize: balloonPageSize, paged: pagedBalloonTasks } = usePagination(balloonTasks)

// 收到新任务自动打印：本地开关，默认关。打印走弹窗窗口（window.open），
// 若被弹窗拦截或浏览器因缺少用户手势忽略打印请求，管理员可手动点「打印」。
const AUTO_PRINT_KEY = 'cxtool_autoprint'
const autoPrint = ref(localStorage.getItem(AUTO_PRINT_KEY) === '1')
watch(autoPrint, (v) => localStorage.setItem(AUTO_PRINT_KEY, v ? '1' : '0'))

// 已见过的任务 id：只有随 SSE 新出现的待打任务才自动打印，避免 refresh()
// 重新拉列表时对老任务重复触发。浏览器要求打印通常有用户手势，SSE 触发的
// 自动打印可能被静默忽略——属已知限制。
const knownPrintIds = new Set<string>()

// 收到新气球自动打印：与打印任务同样的机制，独立开关与去重集合。
const AUTO_BALLOON_KEY = 'cxtool_autoprint_balloon'
const autoPrintBalloon = ref(localStorage.getItem(AUTO_BALLOON_KEY) === '1')
watch(autoPrintBalloon, (v) => localStorage.setItem(AUTO_BALLOON_KEY, v ? '1' : '0'))
const knownBalloonIds = new Set<string>()

async function refreshPrint(): Promise<void> {
  try {
    printTasks.value = await apiFetch<PrintTask[]>('/admin/api/print-tasks')
    for (const t of printTasks.value) knownPrintIds.add(t.id)
  } catch {
    // 轮询失败不打断页面，下一条 SSE 事件会再触发刷新。
  }
}

async function refreshBalloon(): Promise<void> {
  try {
    balloonTasks.value = await apiFetch<BalloonTask[]>('/admin/api/balloon-tasks')
    for (const t of balloonTasks.value) knownBalloonIds.add(t.id)
  } catch {
    // 同上：气球服务可能未启用（503），静默等待下次刷新。
  }
}

async function refresh(): Promise<void> {
  await Promise.all([refreshPrint(), refreshBalloon()])
}

/** Print + auto-ack: the ack fires only when the browser confirms the print
 * via afterprint (Chromium dispatches it on the TOP window for iframe
 * print() calls — never on button click alone); a confirmation timeout
 * resolves false and must not ack. */
async function printAndAckPrintTask(id: string): Promise<void> {
  const confirmed = await printPdfTask(id, apiFetch)
  if (!confirmed) return
  await apiFetch(`/admin/api/print-tasks/${id}/ack`, {
    method: 'POST',
    body: JSON.stringify({ status: 'printed' }),
  })
  await refreshPrint()
}

async function printAndAckBalloonTask(task: BalloonTask): Promise<void> {
  const confirmed = await printBalloonTask(task, apiFetch)
  if (!confirmed) return
  await apiFetch(`/admin/api/balloon-tasks/${task.id}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  await refreshBalloon()
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

useSse((event, data) => {
  if (event === 'print-task') {
    const t = data as PrintTask
    if (t?.id && !knownPrintIds.has(t.id)) {
      knownPrintIds.add(t.id)
      if (autoPrint.value && t.status === 'pending') {
        void printAndAckPrintTask(t.id).catch(() => ElMessage.error('自动打印没成功，请手动打印'))
      }
    }
  }
  if (event === 'balloon-task') {
    const t = data as BalloonTask
    if (t?.id && !knownBalloonIds.has(t.id)) {
      knownBalloonIds.add(t.id)
      if (autoPrintBalloon.value && t.status === 'pending') {
        void printAndAckBalloonTask(t).catch(() => ElMessage.error('自动打印没成功，请手动打印'))
      }
    }
  }
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

async function printRow(row: PrintTask): Promise<void> {
  try {
    await printAndAckPrintTask(row.id)
  } catch (e) {
    // 弹窗拦截有专属提示；其余失败走通用文案（错误细节可能在内部日志里）
    ElMessage.error(
      e instanceof Error && e.message.includes('弹窗') ? e.message : '打印没成功，请再试一次',
    )
  }
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

async function printBalloonRow(row: BalloonTask): Promise<void> {
  try {
    await printAndAckBalloonTask(row)
  } catch (e) {
    ElMessage.error(
      e instanceof Error && e.message.includes('弹窗') ? e.message : '打印没成功，请再试一次',
    )
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
  <div class="jobs page-fill">
    <el-tabs v-model="activeTab" class="jobs-tabs">
      <el-tab-pane label="打印任务" name="print">
        <div class="print-toolbar">
          <el-switch v-model="autoPrint" active-text="收到新任务自动打印" />
        </div>
        <div v-if="printTasks.length" class="table-fill-wrap">
        <el-table :data="pagedPrintTasks" height="100%">
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
          <el-table-column label="操作" min-width="240">
            <template #default="{ row }">
              <template v-if="row.status === 'pending'">
                <el-button size="small" @click="printRow(row as PrintTask)">打印</el-button>
                <el-button size="small" type="primary" @click="ackPrint(row as PrintTask, 'printed')">标记已打</el-button>
                <el-button size="small" type="danger" plain @click="ackPrint(row as PrintTask, 'failed')">标记失败</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          class="table-pagination"
          v-model:current-page="printPage"
          v-model:page-size="printPageSize"
          :total="printTasks.length"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
        />
        </div>
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
        <div class="print-toolbar">
          <el-switch v-model="autoPrintBalloon" active-text="收到新气球自动打印" />
        </div>
        <div v-if="balloonTasks.length" class="table-fill-wrap">
        <el-table :data="pagedBalloonTasks" height="100%">
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
          <el-table-column label="操作" min-width="170">
            <template #default="{ row }">
              <template v-if="row.status === 'pending'">
                <el-button size="small" @click="printBalloonRow(row as BalloonTask)">打印</el-button>
                <el-button size="small" type="primary" @click="ackBalloon(row as BalloonTask)">标记已送</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          class="table-pagination"
          v-model:current-page="balloonPage"
          v-model:page-size="balloonPageSize"
          :total="balloonTasks.length"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
        />
        </div>
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
.jobs-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.jobs-tabs :deep(.el-tabs__header) {
  flex-shrink: 0;
}

.jobs-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.jobs-tabs :deep(.el-tab-pane) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.table-pagination {
  margin-top: 12px;
  justify-content: flex-end;
}

.print-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
  flex-shrink: 0;
}

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
  justify-content: center;
  gap: 12px;
  padding: 40px 0;
  flex: 1;
  min-height: 0;
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

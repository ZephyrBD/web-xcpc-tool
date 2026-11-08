<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElButton, ElEmpty, ElMessageBox, ElTable, ElTableColumn } from 'element-plus'
import { apiFetch } from '@/api'
import { useSse } from '@/composables/useSse'
import type { AuthTask, AuthTaskStatus } from '@/types'

const tasks = ref<AuthTask[]>([])
const loading = ref(false)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    tasks.value = await apiFetch<AuthTask[]>('/admin/api/auth-tasks')
  } finally {
    loading.value = false
  }
}

// SSE 变更采用 300ms 防抖合并刷新（而非逐条去重）：
// 一次推送风暴只会触发一次请求，列表始终以服务端为准。
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 300)
}

useSse(() => scheduleRefresh())

const statusLabels: Record<AuthTaskStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  'auto-done': '自动通过',
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

async function onApprove(row: AuthTask): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认批准学号 ${row.examNum} 的认证申请？`, '批准认证任务', {
      confirmButtonText: '批准',
      cancelButtonText: '取消',
      type: 'success',
    })
  } catch {
    return
  }
  await apiFetch(`/admin/api/auth-tasks/${row.id}/approve`, { method: 'POST' })
  await refresh()
}

async function onReject(row: AuthTask): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认拒绝学号 ${row.examNum} 的认证申请？`, '拒绝认证任务', {
      confirmButtonText: '拒绝',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  await apiFetch(`/admin/api/auth-tasks/${row.id}/reject`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  await refresh()
}

onMounted(() => void refresh())
</script>

<template>
  <div class="auth-tasks">
    <el-table v-if="tasks.length" :data="tasks" class="task-table">
      <el-table-column prop="examNum" label="学号" min-width="120" />
      <el-table-column label="客户端" min-width="140">
        <template #default="{ row }">{{ row.clientId ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="strategy" label="识别策略" min-width="110" />
      <el-table-column label="状态" min-width="100">
        <template #default="{ row }">
          <span class="pill" :class="`pill--${row.status}`">{{ statusLabels[row.status as AuthTaskStatus] }}</span>
        </template>
      </el-table-column>
      <el-table-column label="提交时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="150">
        <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <el-button size="small" type="primary" @click="onApprove(row as AuthTask)">批准</el-button>
            <el-button size="small" type="danger" plain @click="onReject(row as AuthTask)">拒绝</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="当前没有认证任务，一切正常 🙂" />
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

.pill--approved {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.pill--rejected {
  color: var(--brand-red);
  border-color: color-mix(in srgb, var(--brand-red) 35%, transparent);
  background: color-mix(in srgb, var(--brand-red) 12%, transparent);
}

.pill--auto-done {
  color: var(--brand-blue);
  border-color: color-mix(in srgb, var(--brand-blue) 35%, transparent);
  background: color-mix(in srgb, var(--brand-blue) 12%, transparent);
}
</style>

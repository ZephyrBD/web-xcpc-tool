<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElButton, ElCollapse, ElCollapseItem, ElMessage, ElMessageBox, ElTable, ElTableColumn, ElTag } from 'element-plus'
import { apiFetch } from '@/api'
import type { LoginRequest, LoginRequestsResponse, LoginRequestStatus } from '@/types'

const pending = ref<LoginRequest[]>([])
const recent = ref<LoginRequest[]>([])
const loading = ref(false)
const decidingId = ref<string | null>(null)

/** 已处理记录的状态文案：同意后签发登录态 → 已使用；被拒 → 已拒绝。 */
const recentStatusLabels: Record<Exclude<LoginRequestStatus, 'pending'>, string> = {
  approved: '已同意',
  rejected: '已拒绝',
  claimed: '已使用',
}

const recentStatusTags: Record<Exclude<LoginRequestStatus, 'pending'>, 'success' | 'danger' | 'info'> = {
  approved: 'success',
  rejected: 'danger',
  claimed: 'info',
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const data = await apiFetch<LoginRequestsResponse>('/admin/api/login-requests')
    pending.value = data.pending
    recent.value = data.recent
  } catch {
    ElMessage.error('登录请求加载失败，请刷新重试')
  } finally {
    loading.value = false
  }
}

async function decide(row: LoginRequest, decision: 'approved' | 'rejected'): Promise<void> {
  const label = decision === 'approved' ? '同意' : '拒绝'
  try {
    await ElMessageBox.confirm(
      decision === 'approved'
        ? `同意队伍 ${row.teamName || row.icpcId} 的登录请求？同意后队伍会立即登录，一次性有效。`
        : `拒绝队伍 ${row.teamName || row.icpcId} 的登录请求？该队伍需要重新输入队伍码发起申请。`,
      `${label}登录请求`,
      { confirmButtonText: label, cancelButtonText: '取消', type: decision === 'approved' ? 'info' : 'warning' },
    )
  } catch {
    return
  }
  decidingId.value = row.id
  try {
    await apiFetch<LoginRequest>(`/admin/api/login-requests/${encodeURIComponent(row.id)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    ElMessage.success(decision === 'approved' ? `已同意 ${row.teamName || row.icpcId} 的登录` : `已拒绝 ${row.teamName || row.icpcId} 的登录请求`)
  } catch {
    ElMessage.error('操作没成功，请再试一次')
  } finally {
    decidingId.value = null
    await refresh()
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

function recentLabel(status: LoginRequestStatus): string {
  return status === 'pending' ? '待审批' : recentStatusLabels[status]
}

onMounted(() => void refresh())
</script>

<template>
  <section class="login-approval-card">
    <div class="approval-toolbar">
      <div class="approval-title-group">
        <h2 class="approval-title">登录审批</h2>
        <span class="approval-summary">
          待审批 {{ pending.length }} 个 · 队伍在登录时段外输入队伍码后，会在这里等待同意
        </span>
      </div>
      <ElButton size="small" :loading="loading" @click="refresh">刷新</ElButton>
    </div>

    <div v-if="pending.length" class="approval-table-wrap">
      <el-table :data="pending" size="small">
        <el-table-column label="队伍名" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ (row as LoginRequest).teamName || '—' }}</template>
        </el-table-column>
        <el-table-column label="队伍码" min-width="160">
          <template #default="{ row }">
            <code class="code-text">{{ (row as LoginRequest).teamCode }}</code>
          </template>
        </el-table-column>
        <el-table-column label="申请时间" min-width="180">
          <template #default="{ row }">{{ formatTime((row as LoginRequest).requestedAt) }}</template>
        </el-table-column>
        <el-table-column label="IP" min-width="130">
          <template #default="{ row }">
            <code class="code-text">{{ (row as LoginRequest).ip ?? '—' }}</code>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="170">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              :loading="decidingId === (row as LoginRequest).id"
              @click="decide(row as LoginRequest, 'approved')"
            >同意</el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :disabled="decidingId === (row as LoginRequest).id"
              @click="decide(row as LoginRequest, 'rejected')"
            >拒绝</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <p v-else class="approval-empty">暂无待审批的登录请求</p>

    <ElCollapse v-if="recent.length" class="approval-recent">
      <ElCollapseItem title="最近处理" name="recent">
        <el-table :data="recent" size="small">
          <el-table-column label="队伍名" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ (row as LoginRequest).teamName || '—' }}</template>
          </el-table-column>
          <el-table-column label="队伍码" min-width="150">
            <template #default="{ row }">
              <code class="code-text">{{ (row as LoginRequest).teamCode }}</code>
            </template>
          </el-table-column>
          <el-table-column label="申请时间" min-width="170">
            <template #default="{ row }">{{ formatTime((row as LoginRequest).requestedAt) }}</template>
          </el-table-column>
          <el-table-column label="处理时间" min-width="170">
            <template #default="{ row }">
              {{ (row as LoginRequest).decidedAt ? formatTime((row as LoginRequest).decidedAt!) : '—' }}
            </template>
          </el-table-column>
          <el-table-column label="状态" min-width="110">
            <template #default="{ row }">
              <ElTag
                size="small"
                :type="(row as LoginRequest).status === 'pending' ? 'warning' : recentStatusTags[(row as LoginRequest).status as Exclude<LoginRequestStatus, 'pending'>]"
              >{{ recentLabel((row as LoginRequest).status) }}</ElTag>
            </template>
          </el-table-column>
        </el-table>
      </ElCollapseItem>
    </ElCollapse>
  </section>
</template>

<style scoped>
.login-approval-card {
  flex: none;
  margin-bottom: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-lg, 10px);
  border: 1px solid color-mix(in srgb, var(--brand-green) 30%, transparent);
  background: color-mix(in srgb, var(--brand-green) 6%, transparent);
}

.approval-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.approval-title-group {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.approval-title {
  margin: 0;
  font-size: var(--text-15);
}

.approval-summary {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.approval-table-wrap {
  max-height: 260px;
  overflow-y: auto;
}

.approval-empty {
  margin: 8px 0 4px;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.approval-recent {
  margin-top: 8px;
  border-top: none;
}

.code-text {
  font-family: var(--font-mono);
  font-size: 13px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>

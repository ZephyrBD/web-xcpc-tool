<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { confirmDialog, messageError, messageSuccess } from '@/lib/feedback'
import ElButton from '@/components/el/ElButton.vue'
import ElCollapse from '@/components/el/ElCollapse.vue'
import ElCollapseItem from '@/components/el/ElCollapseItem.vue'
import ElTable from '@/components/el/ElTable.vue'
import ElTableColumn from '@/components/el/ElTableColumn.vue'
import ElTag from '@/components/el/ElTag.vue'
import { apiFetch, ApiError } from '@/api'
import { useSse } from '@/composables/useSse'
import type { LoginRequest, LoginRequestsResponse, LoginRequestStatus } from '@/types'
defineOptions({ name: 'LoginRequestsCard' })

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
    messageError('登录请求加载失败，请刷新重试')
  } finally {
    loading.value = false
  }
}

async function decide(row: LoginRequest, decision: 'approved' | 'rejected'): Promise<void> {
  const label = decision === 'approved' ? '同意' : '拒绝'
  const who = row.teamName || row.icpcId
  try {
    await confirmDialog(
      decision === 'approved'
        ? `同意队伍 ${who} 的登录请求？同意后队伍会立即登录，仅当次有效。`
        : `拒绝队伍 ${who} 的登录请求？该队伍需要重新输入队伍码发起申请。`,
      `${label}登录请求`,
      { confirmButtonText: label, cancelButtonText: '取消', type: 'warning' },
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
    messageSuccess(decision === 'approved' ? `已同意 ${who} 的登录` : `已拒绝 ${who} 的登录请求`)
  } catch (e) {
    // 404：该请求已被处理（被拒/已同意/已使用），列表刷新后会自然消失。
    messageError(e instanceof ApiError && e.status === 404 ? '该请求已被处理' : '操作没成功，请再试一次')
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

// 新申请由服务端 SSE 实时推送：与 JobsPage 一致，300ms 防抖合并连续事件后刷新。
// 刷新失败不打断页面，下一次事件或手动「刷新」会再拉一次。
let sseTimer: ReturnType<typeof setTimeout> | null = null
useSse((event) => {
  if (event !== 'login-request') return
  if (sseTimer) clearTimeout(sseTimer)
  sseTimer = setTimeout(() => {
    sseTimer = null
    void refresh()
  }, 300)
})

onMounted(() => void refresh())
onUnmounted(() => {
  if (sseTimer) clearTimeout(sseTimer)
})
</script>

<template>
  <section class="login_approval_card">
    <div class="approval_toolbar">
      <div class="approval_title-group">
        <h2 class="approval_title">登录审批</h2>
        <span class="approval_summary">
          待审批 {{ pending.length }} 个 · 队伍在登录时段外输入队伍码后，会在这里等待同意
        </span>
      </div>
      <ElButton size="small" :loading="loading" @click="refresh">刷新</ElButton>
    </div>

    <div v-if="pending.length" class="approval_table_wrap">
      <ElTable :data="pending" size="small">
        <ElTableColumn label="队伍名" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ (row as LoginRequest).teamName || '—' }}</template>
        </ElTableColumn>
        <ElTableColumn label="队伍码" min-width="160">
          <template #default="{ row }">
            <code class="code_text">{{ (row as LoginRequest).teamCode }}</code>
          </template>
        </ElTableColumn>
        <ElTableColumn label="申请时间" min-width="180">
          <template #default="{ row }">{{ formatTime((row as LoginRequest).requestedAt) }}</template>
        </ElTableColumn>
        <ElTableColumn label="IP" min-width="130">
          <template #default="{ row }">
            <code class="code_text">{{ (row as LoginRequest).ip ?? '—' }}</code>
          </template>
        </ElTableColumn>
        <ElTableColumn label="操作" min-width="170">
          <template #default="{ row }">
            <ElButton
              size="small"
              type="primary"
              :loading="decidingId === (row as LoginRequest).id"
              :disabled="decidingId !== null"
              @click="decide(row as LoginRequest, 'approved')"
            >同意</ElButton>
            <ElButton
              size="small"
              type="danger"
              plain
              :disabled="decidingId !== null"
              @click="decide(row as LoginRequest, 'rejected')"
            >拒绝</ElButton>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>
    <p v-else class="approval_empty">暂无待审批的登录请求</p>

    <ElCollapse v-if="recent.length" class="approval_recent">
      <ElCollapseItem title="最近处理" name="recent">
        <ElTable :data="recent" size="small">
          <ElTableColumn label="队伍名" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ (row as LoginRequest).teamName || '—' }}</template>
          </ElTableColumn>
          <ElTableColumn label="队伍码" min-width="150">
            <template #default="{ row }">
              <code class="code_text">{{ (row as LoginRequest).teamCode }}</code>
            </template>
          </ElTableColumn>
          <ElTableColumn label="申请时间" min-width="170">
            <template #default="{ row }">{{ formatTime((row as LoginRequest).requestedAt) }}</template>
          </ElTableColumn>
          <ElTableColumn label="处理时间" min-width="170">
            <template #default="{ row }">
              {{ (row as LoginRequest).decidedAt ? formatTime((row as LoginRequest).decidedAt!) : '—' }}
            </template>
          </ElTableColumn>
          <ElTableColumn label="状态" min-width="110">
            <template #default="{ row }">
              <ElTag
                size="small"
                :type="(row as LoginRequest).status === 'pending' ? 'warning' : recentStatusTags[(row as LoginRequest).status as Exclude<LoginRequestStatus, 'pending'>]"
              >{{ recentLabel((row as LoginRequest).status) }}</ElTag>
            </template>
          </ElTableColumn>
        </ElTable>
      </ElCollapseItem>
    </ElCollapse>
  </section>
</template>

<style scoped lang="scss">
.login_approval_card {
  flex: none;
  margin-bottom: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-lg, 10px);
  border: 1px solid color-mix(in srgb, var(--brand-green) 30%, transparent);
  background: color-mix(in srgb, var(--brand-green) 6%, transparent);
}

.approval_toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.approval_title-group {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.approval_title {
  margin: 0;
  font-size: var(--text-15);
}

.approval_summary {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.approval_table_wrap {
  max-height: 260px;
  overflow-y: auto;
}

.approval_empty {
  margin: 8px 0 4px;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.approval_recent {
  margin-top: 8px;
  border-top: none;
}

.code_text {
  font-family: var(--font-mono);
  font-size: 13px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>

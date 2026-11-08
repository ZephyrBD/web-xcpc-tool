<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElButton, ElDialog, ElEmpty, ElMessage, ElMessageBox, ElPagination, ElProgress, ElTable, ElTableColumn, ElTabPane, ElTabs } from 'element-plus'
import { apiFetch } from '@/api'
import { usePagination } from '@/composables/usePagination'
import type { LoginHistoryEntry, TeamCodeRow, TeamCodesResponse } from '@/types'

const activeTab = ref<'codes' | 'history'>('codes')

const rows = ref<TeamCodeRow[]>([])
const unassigned = ref(0)
const history = ref<LoginHistoryEntry[]>([])
const loading = ref(false)
const historyLoading = ref(false)

const { page, pageSize, paged: pagedRows } = usePagination(rows)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const data = await apiFetch<TeamCodesResponse>('/admin/api/team-codes')
    rows.value = data.rows
    unassigned.value = data.unassigned
  } catch {
    ElMessage.error('队伍码列表加载失败，请刷新重试')
  } finally {
    loading.value = false
  }
}

async function refreshHistory(): Promise<void> {
  historyLoading.value = true
  try {
    history.value = await apiFetch<LoginHistoryEntry[]>('/admin/api/login-history', { query: { limit: 100 } })
  } catch {
    ElMessage.error('登录历史加载失败，请刷新重试')
  } finally {
    historyLoading.value = false
  }
}

async function onGenerate(row: TeamCodeRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定为队伍 ${row.name || row.icpcId} 重新生成队伍码？旧队伍码将立即失效。`, '重新生成队伍码', {
      confirmButtonText: '重新生成',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    const { teamCode } = await apiFetch<{ icpcId: string; teamCode: string }>('/admin/api/team-codes/generate', {
      method: 'POST',
      body: JSON.stringify({ icpcId: row.icpcId }),
    })
    await refresh()
    ElMessageBox.alert(teamCode, '新的队伍码', { confirmButtonText: '我已保存', center: true })
  } catch {
    ElMessage.error('生成没成功，请再试一次')
  }
}

const generatingAll = ref(false)

async function onGenerateAll(): Promise<void> {
  generatingAll.value = true
  try {
    const { count } = await apiFetch<{ count: number }>('/admin/api/team-codes/generate', {
      method: 'POST',
      body: JSON.stringify({ all: true }),
    })
    ElMessage.success(count > 0 ? `已为 ${count} 个未分配队伍生成队伍码` : '所有队伍都已有队伍码')
    await refresh()
  } catch {
    ElMessage.error('批量生成没成功，请再试一次')
  } finally {
    generatingAll.value = false
  }
}

const exporting = ref(false)

async function onExport(): Promise<void> {
  try {
    await ElMessageBox.confirm('导出内容包含 DOMjudge 密码，请妥善保管。', '导出队伍码 CSV', {
      confirmButtonText: '导出',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  exporting.value = true
  try {
    const blob = await apiFetch<Blob>('/admin/api/team-codes/export', { blob: true })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `team-codes-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('已导出 CSV（包含 DOMjudge 密码，请妥善保管）')
  } catch {
    ElMessage.error('导出没成功，请再试一次')
  } finally {
    exporting.value = false
  }
}

interface ProvisionResult {
  icpcId: string
  name: string
  status: 'ok' | 'skip' | 'fail'
  reason?: string
}

const provDialog = ref(false)
const provRunning = ref(false)
const provCancelled = ref(false)
const provTargets = ref<TeamCodeRow[]>([])
const provResults = ref<ProvisionResult[]>([])

const provProgress = computed(() =>
  provTargets.value.length === 0 ? 0 : Math.round((provResults.value.length / provTargets.value.length) * 100),
)
const provOk = computed(() => provResults.value.filter((r) => r.status === 'ok').length)
const provSkip = computed(() => provResults.value.filter((r) => r.status === 'skip').length)
const provFail = computed(() => provResults.value.filter((r) => r.status === 'fail').length)
const provCurrent = computed(() => provTargets.value[provResults.value.length] ?? null)
const allFailSameReason = computed(() => {
  const fails = provResults.value.filter((r) => r.status === 'fail')
  return fails.length > 0 && fails.every((f) => f.reason === fails[0].reason)
})

function friendlyReason(reason: string): string {
  if (reason.includes('not found')) return 'DOMjudge 中没有该用户名的账号'
  if (reason.includes('refusing non-team')) return '该账号不是纯队伍账号，已跳过'
  return reason
}

async function provisionOne(row: TeamCodeRow): Promise<ProvisionResult> {
  try {
    const { provisioned, skipped, errors } = await apiFetch<{
      provisioned: number
      skipped: number
      errors: Array<{ icpcId: string; reason: string }>
    }>('/admin/api/team-codes/provision', {
      method: 'POST',
      body: JSON.stringify({ icpcId: row.icpcId }),
    })
    const reason = errors[0]?.reason
    if (provisioned > 0) return { icpcId: row.icpcId, name: row.name, status: 'ok' }
    return {
      icpcId: row.icpcId,
      name: row.name,
      status: skipped > 0 ? 'skip' : 'fail',
      reason: reason ? friendlyReason(reason) : '未知原因',
    }
  } catch {
    return { icpcId: row.icpcId, name: row.name, status: 'fail', reason: '请求失败，请检查 DOMjudge 是否可用' }
  }
}

async function onProvision(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '会通过 DOMjudge API 重置这些队伍的密码（没有队伍码或没有密码的队伍都会被配置），确定继续吗？',
      '一键配置密码',
      {
        confirmButtonText: '配置',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  // targets come from a fresh list so we don't provision stale rows
  await refresh()
  const targets = rows.value.filter((t) => t.icpcId !== '' && (!t.teamCode || !t.hasPassword))
  if (targets.length === 0) {
    ElMessage.info('所有队伍都已配置好了')
    return
  }
  provTargets.value = targets
  provResults.value = []
  provCancelled.value = false
  provRunning.value = true
  provDialog.value = true
  try {
    for (const t of targets) {
      if (provCancelled.value) break
      provResults.value.push(await provisionOne(t))
    }
  } finally {
    provRunning.value = false
    await refresh()
  }
}

function cancelProvision(): void {
  provCancelled.value = true
}

async function onCopy(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败，请手动复制')
  }
}

function onTabChange(): void {
  if (activeTab.value === 'history' && history.value.length === 0) void refreshHistory()
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => void refresh())
</script>

<template>
  <div class="team-codes page-fill">
    <ElTabs v-model="activeTab" class="code-tabs" @tab-change="onTabChange">
      <ElTabPane label="队伍码" name="codes">
        <div class="tab-toolbar">
          <span class="toolbar-summary">已发队伍码 {{ rows.length }} / {{ rows.length + unassigned }}</span>
          <div class="toolbar-actions">
            <ElButton :loading="generatingAll" @click="onGenerateAll">为未分配队伍批量生成</ElButton>
            <ElButton type="warning" :disabled="provRunning" @click="onProvision">一键配置密码</ElButton>
            <ElButton type="primary" :loading="exporting" @click="onExport">导出 CSV</ElButton>
          </div>
        </div>
        <p class="export-warn">导出内容包含 DOMjudge 密码，请妥善保管。</p>
        <p v-if="unassigned > 0" class="export-warn">还有 {{ unassigned }} 个队伍未分配队伍码（不含非队伍账号），可用「为未分配队伍批量生成」补齐。</p>

        <div v-if="rows.length" class="table-fill-wrap">
          <el-table :data="pagedRows" height="100%">
            <el-table-column label="队伍名" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ (row as TeamCodeRow).name || '—' }}</template>
            </el-table-column>
            <el-table-column prop="icpcId" label="ICPC_ID" min-width="110" />
            <el-table-column label="队伍码" min-width="200">
              <template #default="{ row }">
                <code class="code-text">{{ (row as TeamCodeRow).teamCode }}</code>
                <el-button size="small" text type="primary" @click="onCopy((row as TeamCodeRow).teamCode!)">复制</el-button>
              </template>
            </el-table-column>
            <el-table-column label="有密码" min-width="90">
              <template #default="{ row }">{{ (row as TeamCodeRow).hasPassword ? '是' : '否' }}</template>
            </el-table-column>
            <el-table-column label="操作" min-width="120">
              <template #default="{ row }">
                <el-button size="small" @click="onGenerate(row as TeamCodeRow)">重新生成</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            class="table-pagination"
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="rows.length"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
          />
        </div>
        <el-empty v-else-if="unassigned > 0" description="所有队伍都还没有队伍码，用上方「为未分配队伍批量生成」一键分配" />
        <el-empty v-else description="还没有队伍，先在「队伍」页从 DOMjudge 同步或导入 Excel" />
      </ElTabPane>

      <ElTabPane label="登录历史" name="history">
        <div v-if="history.length" class="table-fill-wrap">
          <el-table :data="history" height="100%">
            <el-table-column label="时间" min-width="180">
              <template #default="{ row }">{{ formatTime((row as LoginHistoryEntry).at) }}</template>
            </el-table-column>
            <el-table-column label="队伍" min-width="140">
              <template #default="{ row }">{{ (row as LoginHistoryEntry).icpcId }}</template>
            </el-table-column>
            <el-table-column label="队伍码" min-width="160">
              <template #default="{ row }">
                <code class="code-text">{{ (row as LoginHistoryEntry).teamCode }}</code>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-empty v-else description="还没有队伍登录记录，队伍通过队伍码登录后会出现在这里 🙂" />
      </ElTabPane>
    </ElTabs>

    <ElDialog
      v-model="provDialog"
      title="一键配置密码"
      width="560px"
      :close-on-click-modal="!provRunning"
      :close-on-press-escape="!provRunning"
      :show-close="!provRunning"
    >
      <ElProgress :percentage="provProgress" :status="provRunning ? undefined : 'success'" />
      <p class="prov-current">
        <template v-if="provRunning && provCurrent">
          正在配置：{{ provCurrent.icpcId }} / {{ provCurrent.name }}（第 {{ provResults.length + 1 }} / 共 {{ provTargets.length }} 支）
        </template>
        <template v-else-if="provCancelled">已取消，配置中止</template>
        <template v-else>配置完成</template>
      </p>
      <p class="prov-counters">成功 {{ provOk }} · 跳过 {{ provSkip }} · 失败 {{ provFail }}</p>
      <p v-if="!provRunning && provFail > 0 && allFailSameReason" class="prov-hint">
        如全部失败，请检查 DOMjudge 账号是否具备用户管理(Admin)权限
      </p>
      <div v-if="provResults.length" class="prov-list">
        <p v-for="r in provResults" :key="r.icpcId" class="prov-line" :class="'prov-' + r.status">
          <span class="prov-mark">{{ r.status === 'ok' ? '✓' : r.status === 'skip' ? '⊘' : '✗' }}</span>
          {{ r.icpcId }} {{ r.name }}<template v-if="r.reason"> — {{ r.reason }}</template>
        </p>
      </div>
      <template #footer>
        <ElButton v-if="provRunning" @click="cancelProvision">取消</ElButton>
        <ElButton v-else type="primary" @click="provDialog = false">关闭</ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<style scoped>
.code-tabs {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* Tab content stretches to the leftover viewport height; tables scroll
   internally and the pagination footer stays visible inside the fill area. */
.code-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.code-tabs :deep(.el-tab-pane) {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tab-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.toolbar-summary {
  font-size: var(--text-15);
  color: var(--text-muted);
}

.toolbar-actions {
  display: flex;
  gap: 8px;
}

.export-warn {
  margin: 8px 0 0;
  font-size: var(--text-13);
  color: var(--brand-orange);
}

.code-text {
  font-family: var(--font-mono);
  font-size: 13px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
}

.table-pagination {
  margin-top: 12px;
  justify-content: flex-end;
  flex: none;
}

.prov-current {
  margin: 12px 0 4px;
  font-size: var(--text-15);
}

.prov-counters {
  margin: 0 0 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.prov-hint {
  margin: 0 0 8px;
  font-size: var(--text-13);
  color: var(--brand-orange);
}

.prov-list {
  max-height: 260px;
  overflow-y: auto;
  border-top: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
  padding-top: 8px;
}

.prov-line {
  margin: 0;
  font-size: var(--text-13);
  line-height: 1.8;
  word-break: break-all;
}

.prov-mark {
  display: inline-block;
  width: 1.4em;
  text-align: center;
}

.prov-ok {
  color: var(--brand-green, #2e7d32);
}

.prov-skip {
  color: var(--text-muted);
}

.prov-fail {
  color: var(--brand-orange);
}
</style>

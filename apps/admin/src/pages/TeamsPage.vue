<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElButton, ElMessage, ElPagination, ElTable, ElTableColumn } from 'element-plus'
import { apiFetch } from '@/api'
import { usePagination } from '@/composables/usePagination'

export type DjTeam = {
  id: string
  icpc_id?: string
  name: string
  display_name?: string
  members?: string[]
  location?: { description?: string }
}

const teams = ref<DjTeam[]>([])
const { page, pageSize, paged: pagedTeams } = usePagination(teams)
const syncing = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function refresh(): Promise<void> {
  try {
    teams.value = await apiFetch<DjTeam[]>('/admin/api/teams')
  } catch {
    ElMessage.error('队伍列表加载失败，请刷新重试')
  }
}

/** 比赛 ID 只在「设置 → 比赛设置」维护一处；同步时按需读取，避免两处输入不一致。 */
async function configuredContestId(): Promise<string> {
  try {
    const s = await apiFetch<{ balloon?: { contestId?: string } }>('/admin/api/settings')
    return s.balloon?.contestId?.trim() ?? ''
  } catch {
    return ''
  }
}

async function sync(): Promise<void> {
  const cid = await configuredContestId()
  if (!cid) {
    ElMessage.error('还没有设置比赛 ID，请先到「设置 → 比赛设置」填写')
    return
  }
  syncing.value = true
  try {
    const { count } = await apiFetch<{ count: number }>('/admin/api/teams/sync', {
      method: 'POST',
      body: JSON.stringify({ contestId: cid }),
    })
    ElMessage.success(`同步完成，共 ${count} 个队伍`)
  } catch {
    ElMessage.error('同步没成功，请检查 DOMjudge 是否可用后再试')
  } finally {
    syncing.value = false
    await refresh()
  }
}

function pickFile(): void {
  fileInput.value?.click()
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (file) await upload(file)
}

async function onFileChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) await upload(file)
  const el = e.target as HTMLInputElement | null
  if (el) el.value = ''
}

async function upload(file: File): Promise<void> {
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    const result = await apiFetch<{ imported: number; skipped: number }>(
      '/admin/api/teams/import-excel',
      { method: 'POST', body: form },
    )
    ElMessage.success(`成功导入 ${result.imported} 个队伍，跳过 ${result.skipped} 条`)
  } catch (err) {
    const reason =
      err && typeof err === 'object' && 'body' in err && err.body && typeof err.body === 'object' && 'reason' in err.body
        ? String((err.body as { reason?: unknown }).reason)
        : null
    ElMessage.error(reason ? `导入失败：${reason}` : '导入没成功，请确认文件是有效的 Excel 后再试')
  } finally {
    uploading.value = false
    await refresh()
  }
}

function displayName(row: DjTeam): string {
  return row.display_name?.trim() || row.name
}

function membersText(row: DjTeam): string {
  return row.members?.filter(Boolean).join('、') || '—'
}

function locationText(row: DjTeam): string {
  return row.location?.description?.trim() || '—'
}

onMounted(() => void refresh())
</script>

<template>
  <div class="teams page-fill">
    <div class="teams-toolbar">
      <div class="toolbar-left">
        <ElButton type="primary" :loading="syncing" @click="sync">从 DOMjudge 同步</ElButton>
      </div>
      <div
        class="upload-zone"
        @click="pickFile"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <input
          ref="fileInput"
          class="upload-input"
          type="file"
          accept=".xlsx,.xls"
          :disabled="uploading"
          @change="onFileChange"
        />
        <p class="upload-title">拖拽 Excel 到这里，或点击选择文件</p>
        <p class="upload-hint">模板：第一行是表头，两列分别为 ICPC_ID、PASSWORD；每行一个队伍</p>
      </div>
    </div>

    <div v-if="teams.length" class="table-fill-wrap">
      <el-table :data="pagedTeams" height="100%">
      <el-table-column prop="icpc_id" label="ICPC ID" min-width="110">
        <template #default="{ row }">{{ row.icpc_id ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="队伍" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ displayName(row as DjTeam) }}</template>
      </el-table-column>
      <el-table-column label="成员" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ membersText(row as DjTeam) }}</template>
      </el-table-column>
      <el-table-column label="位置" min-width="130">
        <template #default="{ row }">{{ locationText(row as DjTeam) }}</template>
      </el-table-column>
    </el-table>
    </div>
    <el-pagination
      v-if="teams.length"
      class="table-pagination"
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :total="teams.length"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next"
    />
    <div v-else class="empty-state">
      <svg class="empty-art" viewBox="0 0 160 110" aria-hidden="true">
        <circle cx="80" cy="52" r="38" fill="var(--brand-blue)" opacity="0.15" />
        <rect x="52" y="36" width="26" height="34" rx="6" fill="var(--brand-blue)" opacity="0.85" />
        <rect x="84" y="36" width="26" height="34" rx="6" fill="var(--brand-blue)" opacity="0.5" />
        <circle cx="65" cy="47" r="4" fill="var(--bg)" opacity="0.9" />
        <circle cx="97" cy="47" r="4" fill="var(--bg)" opacity="0.9" />
        <rect x="60" y="58" width="40" height="4" rx="2" fill="var(--bg)" opacity="0.7" />
        <circle cx="30" cy="76" r="4" fill="var(--brand-orange)" opacity="0.7" />
        <circle cx="132" cy="32" r="4" fill="var(--brand-green)" opacity="0.7" />
      </svg>
      <p class="empty-copy">还没有队伍，试试从 DOMjudge 同步</p>
    </div>
  </div>
</template>

<style scoped>
.teams {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.table-pagination {
  flex-shrink: 0;
  justify-content: flex-end;
}

.teams-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: stretch;
}

.toolbar-left {
  display: flex;
  gap: 8px;
  align-items: center;
}

.upload-zone {
  flex: 1;
  min-width: 260px;
  padding: 12px 16px;
  border: 1px dashed color-mix(in srgb, var(--brand-blue) 45%, transparent);
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--brand-blue) 6%, transparent);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.upload-zone:hover {
  border-color: var(--brand-blue);
  background: color-mix(in srgb, var(--brand-blue) 12%, transparent);
}

.upload-input {
  display: none;
}

.upload-title {
  margin: 0;
  font-size: var(--text-15);
  color: var(--brand-blue);
}

.upload-hint {
  margin: 4px 0 0;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 64px 0;
}

.empty-art {
  width: 160px;
  height: 110px;
}

.empty-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-15);
}
</style>

<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElPagination from '@/components/el/ElPagination.vue'
import ElSwitch from '@/components/el/ElSwitch.vue'
import ElTable from '@/components/el/ElTable.vue'
import ElTableColumn from '@/components/el/ElTableColumn.vue'
import { formatTime } from '@/view/jobs/composables/formatTime'
import type { PrintTasksStore } from '@/view/jobs/composables/usePrintTasks'
import type { PrintTask } from '@/types'

defineProps<{ store: PrintTasksStore }>()

defineOptions({ name: 'PrintTasksPane' })

const printStatusLabels: Record<string, string> = {
  pending: '待打印',
  printed: '已打印',
  failed: '打印失败',
}
</script>

<template>
  <div class="print_toolbar">
    <ElSwitch v-model="store.autoPrint.value" active-text="收到新任务自动打印" />
  </div>
  <div v-if="store.printTasks.value.length" class="table_fill_wrap">
    <ElTable :data="store.pagedPrintTasks.value" height="100%">
      <ElTableColumn prop="location" label="位置" min-width="110" />
      <ElTableColumn prop="teamName" label="队伍" min-width="140" />
      <ElTableColumn prop="originalFilename" label="文件名" min-width="180" show-overflow-tooltip />
      <ElTableColumn label="状态" min-width="110">
        <template #default="{ row }">
          <span class="pill" :class="`pill--${row.status}`">
            {{ printStatusLabels[row.status as string] ?? row.status }}
          </span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="提交时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </ElTableColumn>
      <ElTableColumn label="操作" min-width="240">
        <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <ElButton size="small" @click="store.printRow(row as PrintTask)">打印</ElButton>
            <ElButton size="small" type="primary" @click="store.ackPrint(row as PrintTask, 'printed')">标记已打</ElButton>
            <ElButton size="small" type="danger" plain @click="store.ackPrint(row as PrintTask, 'failed')">标记失败</ElButton>
          </template>
        </template>
      </ElTableColumn>
    </ElTable>
    <ElPagination
      class="table_pagination"
      v-model:current-page="store.printPage.value"
      v-model:page-size="store.printPageSize.value"
      :total="store.printTasks.value.length"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next"
    />
  </div>
  <div v-else class="empty_state">
    <svg class="empty_art" viewBox="0 0 160 110" aria-hidden="true">
      <circle cx="80" cy="52" r="38" fill="var(--brand-orange)" opacity="0.15" />
      <rect x="50" y="34" width="60" height="34" rx="8" fill="var(--brand-orange)" opacity="0.85" />
      <rect x="60" y="58" width="40" height="22" rx="4" fill="var(--brand-blue)" opacity="0.85" />
      <rect x="66" y="64" width="28" height="4" rx="2" fill="var(--bg)" opacity="0.9" />
      <rect x="66" y="72" width="20" height="4" rx="2" fill="var(--bg)" opacity="0.6" />
      <circle cx="30" cy="30" r="5" fill="var(--brand-green)" opacity="0.7" />
      <circle cx="132" cy="76" r="4" fill="var(--brand-blue)" opacity="0.7" />
    </svg>
    <p class="empty_copy">打印队列空空的</p>
  </div>
</template>

<style scoped lang="scss">
.table_pagination {
  margin-top: 12px;
  justify-content: flex-end;
}

.print_toolbar {
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

.pill--printed {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.pill--failed {
  color: var(--brand-red);
  border-color: color-mix(in srgb, var(--brand-red) 35%, transparent);
  background: color-mix(in srgb, var(--brand-red) 12%, transparent);
}

.empty_state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 0;
  flex: 1;
  min-height: 0;
}

.empty_art {
  width: 160px;
  height: 110px;
}

.empty_copy {
  margin: 0;
  font-size: var(--text-15);
  color: var(--text-muted);
}
</style>

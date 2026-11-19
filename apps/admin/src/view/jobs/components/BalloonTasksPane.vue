<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElPagination from '@/components/el/ElPagination.vue'
import ElSwitch from '@/components/el/ElSwitch.vue'
import ElTable from '@/components/el/ElTable.vue'
import ElTableColumn from '@/components/el/ElTableColumn.vue'
import { formatTime } from '@/view/jobs/composables/formatTime'
import type { BalloonTasksStore } from '@/view/jobs/composables/useBalloonTasks'
import type { BalloonTask } from '@/types'

defineProps<{ store: BalloonTasksStore }>()

defineOptions({ name: 'BalloonTasksPane' })

const balloonStatusLabels: Record<string, string> = {
  pending: '待派送',
  delivered: '已派送',
}
</script>

<template>
  <div class="print_toolbar">
    <ElSwitch v-model="store.autoPrintBalloon.value" active-text="收到新气球自动打印" />
  </div>
  <div v-if="store.balloonTasks.value.length" class="table_fill_wrap">
    <ElTable :data="store.pagedBalloonTasks.value" height="100%">
      <ElTableColumn prop="problemLabel" label="题目" min-width="90" />
      <ElTableColumn prop="teamName" label="队伍" min-width="150" />
      <ElTableColumn label="气球 ID" min-width="90">
        <template #default="{ row }">{{ (row as BalloonTask).balloonId ?? '—' }}</template>
      </ElTableColumn>
      <ElTableColumn label="位置" min-width="110">
        <template #default="{ row }">{{ row.location ?? '—' }}</template>
      </ElTableColumn>
      <ElTableColumn label="状态" min-width="110">
        <template #default="{ row }">
          <span class="pill" :class="`pill--${row.stale ? 'stale' : row.status}`">
            {{ row.stale ? '已隐藏' : (balloonStatusLabels[row.status as string] ?? row.status) }}
          </span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="产生时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </ElTableColumn>
      <ElTableColumn label="操作" min-width="170">
        <template #default="{ row }">
          <template v-if="row.status === 'pending' && !row.stale">
            <ElButton size="small" @click="store.printBalloonRow(row as BalloonTask)">打印</ElButton>
            <ElButton size="small" type="primary" @click="store.ackBalloon(row as BalloonTask)">标记已送</ElButton>
          </template>
        </template>
      </ElTableColumn>
    </ElTable>
    <ElPagination
      class="table_pagination"
      v-model:current-page="store.balloonPage.value"
      v-model:page-size="store.balloonPageSize.value"
      :total="store.balloonTasks.value.length"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next"
    />
  </div>
  <div v-else class="empty_state">
    <svg class="empty_art" viewBox="0 0 160 110" aria-hidden="true">
      <circle cx="80" cy="44" r="26" fill="var(--brand-green)" opacity="0.2" />
      <ellipse cx="80" cy="44" rx="20" ry="25" fill="var(--brand-green)" opacity="0.85" />
      <path d="M80 69 q-4 6 0 10 q4 -4 0 -10" fill="var(--brand-orange)" opacity="0.9" />
      <circle cx="36" cy="66" r="5" fill="var(--brand-orange)" opacity="0.7" />
      <circle cx="126" cy="30" r="4" fill="var(--brand-blue)" opacity="0.7" />
    </svg>
    <p class="empty_copy">还没有气球要送</p>
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

.pill--delivered {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

/* Balloon gone from DOMjudge's list (freeze/removal): status is unchanged. */
.pill--stale {
  color: var(--text-muted);
  border-color: var(--border);
  background: var(--bg-alt);
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

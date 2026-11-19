<script setup lang="ts">
import ElEmpty from '@/components/el/ElEmpty.vue'
import ElTable from '@/components/el/ElTable.vue'
import ElTableColumn from '@/components/el/ElTableColumn.vue'
import { loginHistoryLabel } from '@/types'
import type { LoginHistoryEntry } from '@/types'

defineProps<{ history: LoginHistoryEntry[] }>()

defineOptions({ name: 'HistoryPane' })

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <div>
    <div v-if="history.length" class="table_fill_wrap">
      <ElTable :data="history" height="100%">
        <ElTableColumn label="时间" min-width="180">
          <template #default="{ row }">{{ formatTime((row as LoginHistoryEntry).at) }}</template>
        </ElTableColumn>
        <ElTableColumn label="队伍" min-width="140">
          <template #default="{ row }">{{ loginHistoryLabel(row as LoginHistoryEntry) }}</template>
        </ElTableColumn>
        <ElTableColumn label="队伍码" min-width="160">
          <template #default="{ row }">
            <code class="code_text">{{ (row as LoginHistoryEntry).teamCode }}</code>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>
    <ElEmpty v-else description="还没有队伍登录记录，队伍通过队伍码登录后会出现在这里 🙂" />
  </div>
</template>

<style scoped lang="scss">
.code_text {
  font-family: var(--font-mono);
  font-size: 13px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>

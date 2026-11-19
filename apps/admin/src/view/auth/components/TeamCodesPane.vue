<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElEmpty from '@/components/el/ElEmpty.vue'
import ElPagination from '@/components/el/ElPagination.vue'
import ElTable from '@/components/el/ElTable.vue'
import ElTableColumn from '@/components/el/ElTableColumn.vue'
import type { ProvisionStore } from '@/view/auth/composables/useProvision'
import type { TeamCodesStore } from '@/view/auth/composables/useTeamCodes'
import type { TeamCodeRow } from '@/types'

defineProps<{ codes: TeamCodesStore; provision: ProvisionStore }>()

defineOptions({ name: 'TeamCodesPane' })
</script>

<template>
  <div>
    <div class="tab_toolbar">
      <span class="toolbar_summary">已发队伍码 {{ codes.rows.value.length }} / {{ codes.rows.value.length + codes.unassigned.value }}</span>
      <div class="toolbar_actions">
        <ElButton :loading="codes.generatingAll.value" @click="codes.onGenerateAll">为未分配队伍批量生成</ElButton>
        <ElButton type="warning" :disabled="provision.provRunning.value" @click="provision.onProvision">一键配置密码</ElButton>
        <ElButton type="primary" :loading="codes.exporting.value" @click="codes.onExport">导出 CSV</ElButton>
      </div>
    </div>
    <p class="export_warn">导出内容包含 DOMjudge 密码，请妥善保管。</p>
    <p v-if="codes.unassigned.value > 0" class="export_warn">
      还有 {{ codes.unassigned.value }} 个队伍未分配队伍码（不含非队伍账号），可用「为未分配队伍批量生成」补齐。
    </p>

    <div v-if="codes.rows.value.length" class="table_fill_wrap">
      <ElTable :data="codes.pagedRows.value" height="100%">
        <ElTableColumn label="队伍名" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ (row as TeamCodeRow).name || '—' }}</template>
        </ElTableColumn>
        <ElTableColumn prop="icpcId" label="ICPC_ID" min-width="110" />
        <ElTableColumn label="队伍码" min-width="200">
          <template #default="{ row }">
            <code class="code_text">{{ (row as TeamCodeRow).teamCode }}</code>
            <ElButton size="small" text type="primary" @click="codes.onCopy((row as TeamCodeRow).teamCode!)">复制</ElButton>
          </template>
        </ElTableColumn>
        <ElTableColumn label="用户名" min-width="140">
          <template #default="{ row }">
            <code class="code_text">{{ (row as TeamCodeRow).djUsername ?? '—' }}</code>
          </template>
        </ElTableColumn>
        <ElTableColumn label="有密码" min-width="90">
          <template #default="{ row }">{{ (row as TeamCodeRow).hasPassword ? '是' : '否' }}</template>
        </ElTableColumn>
        <ElTableColumn label="操作" min-width="120">
          <template #default="{ row }">
            <ElButton size="small" @click="codes.onGenerate(row as TeamCodeRow)">重新生成</ElButton>
          </template>
        </ElTableColumn>
      </ElTable>
      <ElPagination
        class="table_pagination"
        v-model:current-page="codes.page.value"
        v-model:page-size="codes.pageSize.value"
        :total="codes.rows.value.length"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
      />
    </div>
    <ElEmpty v-else-if="codes.unassigned.value > 0" description="所有队伍都还没有队伍码，用上方「为未分配队伍批量生成」一键分配" />
    <ElEmpty v-else description="还没有队伍，先在「队伍」页从 DOMjudge 同步" />
  </div>
</template>

<style scoped lang="scss">
.tab_toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.toolbar_summary {
  font-size: var(--text-15);
  color: var(--text-muted);
}

.toolbar_actions {
  display: flex;
  gap: 8px;
}

.export_warn {
  margin: 8px 0 0;
  font-size: var(--text-13);
  color: var(--brand-orange);
}

.code_text {
  font-family: var(--font-mono);
  font-size: 13px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
}

.table_pagination {
  margin-top: 12px;
  justify-content: flex-end;
  flex: none;
}
</style>

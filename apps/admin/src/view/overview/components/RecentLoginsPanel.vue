<script setup lang="ts">
import { computed } from 'vue'
import { loginHistoryLabel } from '@/types'
import type { LoginHistoryEntry } from '@/types'

const props = defineProps<{ history: LoginHistoryEntry[] }>()

defineOptions({ name: 'RecentLoginsPanel' })

const recentLogins = computed(() => props.history.slice(0, 5))

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <section class="dash_panel">
    <div class="panel_head">
      <h2 class="panel_title">最近登录</h2>
      <RouterLink to="/auth" class="panel_link">查看全部 →</RouterLink>
    </div>
    <ul v-if="recentLogins.length" class="panel_list">
      <li v-for="entry in recentLogins" :key="entry.at" class="panel_row">
        <span class="row_main">{{ loginHistoryLabel(entry) }}</span>
        <span class="row_sub">{{ formatTime(entry.at) }}</span>
      </li>
    </ul>
    <p v-else class="panel_empty">还没有队伍登录，静悄悄的 🙂</p>
  </section>
</template>

<style scoped lang="scss">
.dash_panel {
  padding: 20px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg);
  overflow: auto;
  min-height: 0;
}

.panel_head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel_title {
  font-size: var(--text-20);
}

.panel_link {
  font-size: var(--text-13);
  text-decoration: none;
  color: var(--text-muted);
}

.panel_link:hover {
  color: var(--accent);
}

.panel_list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.panel_row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  font-size: var(--text-15);
}

.panel_row:first-child {
  border-top: none;
}

.row_main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row_sub {
  color: var(--text-muted);
  font-size: var(--text-13);
  flex-shrink: 0;
}

.panel_empty {
  margin: 0;
  padding: 16px 0 4px;
  font-size: var(--text-15);
  color: var(--text-muted);
}
</style>

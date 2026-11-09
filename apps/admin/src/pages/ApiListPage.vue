<script setup lang="ts">
interface ApiEntry {
  method: 'GET' | 'POST' | 'PUT' | 'ALL'
  path: string
  desc: string
}

interface ApiGroup {
  title: string
  note?: string
  accent: string
  entries: ApiEntry[]
}

const groups: ApiGroup[] = [
  {
    title: '认证',
    accent: 'var(--brand-purple)',
    entries: [
      { method: 'GET', path: '/wxt/public/verify', desc: '队伍码登录入口，校验队伍码与登录时段后签发 cxtool-token 并跳转 DOMjudge 反代' },
      { method: 'GET', path: '/wxt/public/verify/wait', desc: '登录时段之外的等待页' },
      { method: 'GET', path: '/wxt/public/verify/status', desc: '等待页轮询审批状态' },
      { method: 'GET', path: '/wxt/public/verify/claim', desc: '审批通过后领取登录态并完成跳转' },
    ],
  },
  {
    title: 'DOMjudge 代理',
    accent: 'var(--brand-blue)',
    note: 'DOMjudge 全量反向代理在站点根路径 /：需携带有效的 cxtool-token Cookie（由 /wxt/public/verify 签发）；baseUrl 自带路径前缀时转发前会自动剥掉。',
    entries: [{ method: 'ALL', path: '/*', desc: '全量反代到 domjudge.baseUrl（不含 /api/v4 前缀，自动剥去 baseUrl 的路径前缀）' }],
  },
  {
    title: '回调',
    accent: 'var(--brand-orange)',
    note: '由 DOMjudge 打印服务回调，需在请求中携带配置的 print token。',
    entries: [{ method: 'POST', path: '/wxt/print', desc: 'DOMjudge 打印回调，入队打印任务并推送给管理端' }],
  },
  {
    title: '管理端 API',
    accent: 'var(--brand-green)',
    note: '除 /admin/api/login 外均需 Bearer 管理端 token；SSE 需在查询参数里带 token（?token=...）。',
    entries: [
      { method: 'POST', path: '/admin/api/login', desc: '管理端登录，签发 Bearer token' },
      { method: 'GET', path: '/admin/api/events', desc: 'SSE 事件流：认证 / 打印 / 气球任务实时推送' },
      { method: 'GET', path: '/admin/api/team-codes', desc: '队伍与队伍码列表（不含密码）' },
      { method: 'POST', path: '/admin/api/team-codes/generate', desc: '为指定队伍（icpcId）或所有未分配队伍（all:true）生成队伍码' },
      { method: 'GET', path: '/admin/api/team-codes/export', desc: '导出队伍码 CSV（含 DOMjudge 密码，管理员专用）' },
      { method: 'GET', path: '/admin/api/login-history', desc: '队伍码登录历史，最新在前，可 ?limit= 限制条数' },
      { method: 'GET', path: '/admin/api/login-requests', desc: '登录审批请求：pending 待审批 / recent 最近处理' },
      { method: 'POST', path: '/admin/api/login-requests/:id/decision', desc: '同意（approved）或拒绝（rejected）一条待审批登录请求' },
      { method: 'GET', path: '/admin/api/print-tasks', desc: '打印任务列表，可按 status 过滤' },
      { method: 'POST', path: '/admin/api/print-tasks/:id/ack', desc: '标记打印任务为已打 / 失败' },
      { method: 'GET', path: '/admin/api/print-tasks/:id/pdf', desc: '下载待打印的 PDF（内联预览）' },
      { method: 'GET', path: '/admin/api/balloon-tasks', desc: '气球任务列表，可按 status 过滤' },
      { method: 'POST', path: '/admin/api/balloon-tasks/:id/ack', desc: '标记气球任务为已派送' },
      { method: 'GET', path: '/admin/api/teams', desc: '队伍列表（来自 DOMjudge 同步 / Excel 导入）' },
      { method: 'POST', path: '/admin/api/teams/sync', desc: '从 DOMjudge 按 contestId 同步队伍' },
      { method: 'POST', path: '/admin/api/teams/import-excel', desc: '上传 Excel 批量导入队伍' },
      { method: 'GET', path: '/admin/api/settings', desc: '读取当前设置（密码与 token 只返回掩码，比赛 ID 带 locked 标记）' },
      { method: 'PUT', path: '/admin/api/settings', desc: '部分更新设置，立即生效（密码留空表示不修改；端口 / JWT 密钥需重启；修改比赛 ID 返回 403）' },
      { method: 'POST', path: '/admin/api/data/purge', desc: '清空已拉取的队伍、账号密码、队伍码、登录历史、审批记录、打印任务与留档文件、气球任务，并把比赛 ID 置空；保留其余设置与 secret.key，跨站请求会被拒绝' },
    ],
  },
]
</script>

<template>
  <div class="api-list page-fill">
    <section v-for="group in groups" :key="group.title" class="api-group">
      <h2 class="group-title" :style="{ color: group.accent }">{{ group.title }}</h2>
      <p v-if="group.note" class="group-note">{{ group.note }}</p>
      <ul class="api-rows">
        <li v-for="entry in group.entries" :key="entry.path + entry.method" class="api-row">
          <span class="method-pill" :class="`method--${entry.method.toLowerCase()}`">{{ entry.method }}</span>
          <code class="api-path">{{ entry.path }}</code>
          <span class="api-desc">{{ entry.desc }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.api-group {
  margin-bottom: 28px;
}

.group-title {
  margin: 0 0 10px;
  font-size: var(--text-17);
  font-weight: 600;
}

.group-note {
  margin: 0 0 10px;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.api-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.api-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}

.api-row + .api-row {
  border-top: 1px solid var(--border);
}

.method-pill {
  flex-shrink: 0;
  width: 44px;
  text-align: center;
  padding: 2px 0;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
  border: 1px solid transparent;
}

.method--get {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.method--post {
  color: var(--brand-orange);
  border-color: color-mix(in srgb, var(--brand-orange) 35%, transparent);
  background: color-mix(in srgb, var(--brand-orange) 12%, transparent);
}

.method--put {
  color: var(--brand-purple);
  border-color: color-mix(in srgb, var(--brand-purple) 35%, transparent);
  background: color-mix(in srgb, var(--brand-purple) 12%, transparent);
}

.method--all {
  color: var(--brand-blue);
  border-color: color-mix(in srgb, var(--brand-blue) 35%, transparent);
  background: color-mix(in srgb, var(--brand-blue) 12%, transparent);
}

.api-path {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  flex-shrink: 0;
}

.api-desc {
  font-size: var(--text-13);
  color: var(--text-muted);
}
</style>

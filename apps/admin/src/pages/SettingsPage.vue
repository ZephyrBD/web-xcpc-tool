<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElButton, ElInput, ElMessage } from 'element-plus'
import { apiFetch } from '@/api'

interface SettingsView {
  domjudge: { baseUrl: string; adminUser: string; timeoutSeconds: number }
  balloon: { contestId: string; pollIntervalSeconds: number }
  print: { tokenMasked: string }
  teamLogin?: { start: string; end: string }
  admin: { username: string }
  version?: { hash: string; year: number }
}

const form = reactive({
  domjudgeBaseUrl: '',
  domjudgeAdminUser: '',
  domjudgeAdminPassword: '',
  balloonContestId: '',
  balloonPollIntervalSeconds: 30,
  printToken: '',
  teamLoginStart: '',
  teamLoginEnd: '',
  adminUsername: '',
  adminPassword: '',
  adminPasswordConfirm: '',
})

const loading = ref(false)
const saving = ref(false)
const printTokenMasked = ref('')
const adminPasswordError = ref('')
const versionInfo = ref<NonNullable<SettingsView['version']> | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const s = await apiFetch<SettingsView>('/admin/api/settings')
    form.domjudgeBaseUrl = s.domjudge.baseUrl
    form.domjudgeAdminUser = s.domjudge.adminUser
    form.balloonContestId = s.balloon.contestId
    form.balloonPollIntervalSeconds = s.balloon.pollIntervalSeconds
    form.adminUsername = s.admin.username
    printTokenMasked.value = s.print.tokenMasked
    form.teamLoginStart = isoToLocalInput(s.teamLogin?.start ?? '')
    form.teamLoginEnd = isoToLocalInput(s.teamLogin?.end ?? '')
    versionInfo.value = s.version ?? null
  } catch {
    ElMessage.error('设置加载失败，请刷新重试')
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (form.adminPassword !== form.adminPasswordConfirm) {
    adminPasswordError.value = '两次输入的新密码不一致，请检查后重新输入'
    return
  }
  // 留空表示不修改；只有输入了非空白但纯空格的内容才拦截。
  if (form.adminPassword !== '' && form.adminPassword.trim() === '') {
    adminPasswordError.value = '密码不能是空白字符，建议至少 6 个字符'
    return
  }
  adminPasswordError.value = ''
  saving.value = true
  try {
    await apiFetch<{ note?: string }>('/admin/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        domjudge: {
          baseUrl: form.domjudgeBaseUrl,
          adminUser: form.domjudgeAdminUser,
          // 密码留空表示不修改，不把空串发给服务端。
          ...(form.domjudgeAdminPassword ? { adminPassword: form.domjudgeAdminPassword } : {}),
        },
        balloon: {
          contestId: form.balloonContestId,
          pollIntervalSeconds: form.balloonPollIntervalSeconds,
        },
        ...(form.printToken ? { print: { token: form.printToken } } : {}),
        teamLogin: {
          start: form.teamLoginStart ? localInputToIso(form.teamLoginStart) : '',
          end: form.teamLoginEnd ? localInputToIso(form.teamLoginEnd) : '',
        },
        admin: {
          username: form.adminUsername,
          ...(form.adminPassword ? { password: form.adminPassword } : {}),
        },
      }),
    })
    form.domjudgeAdminPassword = ''
    form.printToken = ''
    form.adminPassword = ''
    form.adminPasswordConfirm = ''
    await refresh()
    ElMessage.success('已保存，立即生效（端口与访问前缀例外，修改后需重启）')
  } catch {
    ElMessage.error('保存没成功，请检查填写内容后再试')
  } finally {
    saving.value = false
  }
}

/** ISO datetime → value for <input type="datetime-local"> (local time); '' passes through. */
function isoToLocalInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value → ISO string (UTC); '' passes through. */
function localInputToIso(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toISOString()
}

function randomToken(): string {  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[parseInt(bits.slice(i * 6, i * 6 + 6), 2)];
  return out;
}

async function generateToken(): Promise<void> {
  form.printToken = randomToken();
}

/** 清空登录时段，保存后服务端按留空 = 不限制处理。 */
function clearTeamLogin(): void {
  form.teamLoginStart = ''
  form.teamLoginEnd = ''
}

async function copyToken(): Promise<void> {
  if (!form.printToken) return;
  try {
    await navigator.clipboard.writeText(form.printToken);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败，请手动复制');
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="settings page-fill">
    <div class="settings-grid">
      <section class="settings-card">
        <h2 class="card-title">DOMjudge 连接</h2>
        <span class="field-help">
          这里填写的是 <b>DOMjudge 平台</b>的管理员账号（用于本工具调用 DOMjudge 的 API，如同步队伍、拉取判题结果），
          不是本工具自己的登录账号。
        </span>
        <label class="field">
          <span class="field-label">Base URL</span>
          <ElInput v-model="form.domjudgeBaseUrl" placeholder="https://domjudge.example.com" />
          <span class="field-help">
            指向 <b>DOMjudge 本身</b>的地址，不带 <code>/api</code> 后缀。拼接规则：本工具按
            <code>baseUrl + /api/v4/contests/...</code> 调 DOMjudge API；队伍浏览器访问的
            DOMjudge 页面则通过本工具的 <code>/wxt/dj/...</code> 反代到
            <code>baseUrl + /...</code>。
          </span>
        </label>
        <label class="field">
          <span class="field-label">DOMjudge 管理员用户名</span>
          <ElInput v-model="form.domjudgeAdminUser" placeholder="DOMjudge 平台的管理员账号" />
        </label>
        <label class="field">
          <span class="field-label">DOMjudge 管理员密码</span>
          <ElInput
            v-model="form.domjudgeAdminPassword"
            type="password"
            show-password
            placeholder="留空则不修改"
          />
        </label>
      </section>

      <section class="settings-card">
        <h2 class="card-title">气球服务</h2>
        <label class="field">
          <span class="field-label">比赛 ID（contestId）</span>
          <ElInput v-model="form.balloonContestId" placeholder="DOMjudge 比赛 ID" />
        </label>
        <label class="field">
          <span class="field-label">轮询间隔（秒）</span>
          <ElInput v-model.number="form.balloonPollIntervalSeconds" type="number" :min="1" />
        </label>
      </section>

      <section class="settings-card">
        <h2 class="card-title">打印回调 Token</h2>
        <label class="field">
          <span class="field-label">Token</span>
          <ElInput v-model="form.printToken" type="password" show-password placeholder="留空则不修改" />
          <div class="token-actions">
            <ElButton size="small" @click="generateToken">生成</ElButton>
            <ElButton size="small" @click="copyToken">复制</ElButton>
          </div>
          <span class="field-help">
            当前：{{ printTokenMasked || '未设置' }}。生成一个随机令牌，保存后重启生效，需要同步填到
            DOMjudge 的打印配置里（header <code>org.domjudge.print-token</code>）。
          </span>
        </label>
      </section>

      <section class="settings-card">
        <h2 class="card-title">登录时段</h2>
        <span class="field-help">留空表示不限制；登录时段外队伍码无法登入。</span>
        <label class="field">
          <span class="field-label">开始时间</span>
          <input v-model="form.teamLoginStart" class="datetime-input" type="datetime-local" />
        </label>
        <label class="field">
          <span class="field-label">结束时间</span>
          <input v-model="form.teamLoginEnd" class="datetime-input" type="datetime-local" />
        </label>
        <div class="token-actions">
          <ElButton
            size="small"
            :disabled="form.teamLoginStart === '' && form.teamLoginEnd === ''"
            @click="clearTeamLogin"
          >清除时段</ElButton>
        </div>
      </section>

      <section class="settings-card">
        <h2 class="card-title">管理端账号</h2>
        <span class="field-help">
          这是<b>本工具自己的管理员账号</b>（登录本管理台用），与 DOMjudge 平台的账号无关。
        </span>
        <label class="field">
          <span class="field-label">用户名</span>
          <ElInput v-model="form.adminUsername" placeholder="本工具管理台登录用户名" />
        </label>
        <label class="field">
          <span class="field-label">新密码</span>
          <ElInput
            v-model="form.adminPassword"
            type="password"
            show-password
            placeholder="留空则不修改"
          />
        </label>
        <label class="field">
          <span class="field-label">确认新密码</span>
          <ElInput
            v-model="form.adminPasswordConfirm"
            type="password"
            show-password
            placeholder="再次输入新密码"
          />
          <span v-if="adminPasswordError" class="field-error">{{ adminPasswordError }}</span>
          <span v-else class="field-help">修改登录密码保存后，重启服务才会生效。</span>
        </label>
      </section>
    </div>

    <div class="settings-footer">
      <ElButton type="primary" :loading="saving" @click="save">保存设置</ElButton>
      <span class="footer-note">保存后写入 settings.json，重启服务才生效。</span>
    </div>

    <section v-if="versionInfo" class="settings-card version-card" aria-label="版本信息">
      <h2 class="card-title">版本信息</h2>
      <p class="version-line">
        Copyright (c) 2018~{{ versionInfo.year }} Modding Craft ZBD Studio, Version: {{ versionInfo.hash }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}

.settings-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-alt);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card-title {
  margin: 0;
  font-size: var(--text-15);
  font-weight: 600;
  color: var(--text);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.field-help {
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.6;
}

.field-error {
  font-size: var(--text-13);
  color: var(--el-color-danger, #f56c6c);
  line-height: 1.6;
}

.field-help code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 0 4px;
}

.token-actions {
  display: flex;
  gap: 8px;
}

.datetime-input {
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg);
  padding: 6px 10px;
  font-size: var(--text-15);
  color: var(--text);
  font-family: var(--font-body);
}

.settings-footer {
  margin-top: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.footer-note {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.version-card {
  grid-column: 1 / -1;
}

.version-line {
  margin: 0;
  font-size: var(--text-13);
  color: var(--text-muted);
}
</style>

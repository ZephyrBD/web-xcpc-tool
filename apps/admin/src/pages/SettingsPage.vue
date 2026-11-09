<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElButton, ElInput, ElMessage } from 'element-plus'
import { apiFetch } from '@/api'
import { serverMessage } from '@/lib/apiError'

interface SettingsView {
  domjudge: { baseUrl: string; adminUser: string; timeoutSeconds: number }
  balloon: { contestId: string; pollIntervalSeconds: number; locked?: boolean }
  print: { tokenMasked: string }
  teamLogin?: { start: string; end: string }
  admin: { username: string }
  version?: { hash: string; year: number }
}

/** POST /admin/api/data/purge 的返回：每类数据的删除条数与归档文件数。 */
interface PurgeReport {
  teams: number
  passwords: number
  teamCodes: number
  printTasks: number
  balloonTasks: number
  loginHistory: number
  loginRequests: number
  filesRemoved: number
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
const purging = ref(false)
/** 至少成功读到过一次配置：没读到就不允许保存，免得把表单默认值（空 Base URL 等）PUT 回去。 */
const loaded = ref(false)
/** 最近一次成功刷新的错误：刷新失败不清空编辑，只提示操作员手动刷新。 */
const refreshError = ref('')
/** 服务端判定比赛 ID 已写入（写一次后锁定），输入框改为只读。 */
const contestLocked = ref(false)
/** 保存失败时服务端返回的中文说明，原样展示，不吞成通用文案。 */
const saveError = ref('')
const printTokenMasked = ref('')
const adminPasswordError = ref('')
const versionInfo = ref<NonNullable<SettingsView['version']> | null>(null)

/** 清空数据的二次确认词：首尾空白不算，输入「清空」才解锁按钮。 */
const PURGE_WORD = '清空'
const purgeConfirm = ref('')
const purgeError = ref('')
const purgeReport = ref<PurgeReport | null>(null)
const purgeReady = computed(() => purgeConfirm.value.trim() === PURGE_WORD)

/** 轮询间隔必须是正整数：在提交前拦住，不把非法值丢给服务端换一个 400。 */
const pollIntervalValid = computed(() => {
  const v = form.balloonPollIntervalSeconds
  return typeof v === 'number' && Number.isInteger(v) && v > 0
})
/** 只有操作员动过这个字段才提示，加载出来的值不先吓人一跳。 */
const pollIntervalTouched = ref(false)
const showPollIntervalError = computed(() => pollIntervalTouched.value && !pollIntervalValid.value)

/** 比赛 ID 填了值：「已置空」的提示就不成立；再清空回空串时提示自动恢复。 */
const purgeIdRefilled = computed(() => form.balloonContestId.trim() !== '')

/**
 * 把表单快照下来：只和快照比较，不维护逐字段的 dirty 标记（漏标一个字段就会悄悄改掉
 * 操作员的输入）。快照在每次拿到服务端状态时更新。
 */
type Snapshot = typeof form

function snapshot(): Snapshot {
  return { ...form }
}

const baseline = ref<Snapshot | null>(null)

function applyBaseline(): void {
  baseline.value = snapshot()
  loaded.value = true
}

/**
 * 拉取设置并合并进表单。
 *
 * 保存或清空后不整体覆盖表单：服务端回写的是请求体里的值，而表单里可能还有别的卡片
 * 尚未保存的编辑。这里只覆盖「服务端已经落地」的字段，以及服务端派生、前端只读的内容
 * （比赛 ID 锁定状态、令牌掩码、版本信息）。返回是否成功。
 *
 * `errorFallback` 为空时不弹 toast、也不写页面级提示：调用方（保存）已经有自己的结论，
 * 两句话一起弹会自相矛盾。
 */
async function pullSettings(options: { merge: boolean; errorFallback?: string }): Promise<boolean> {
  loading.value = true
  if (options.errorFallback) refreshError.value = ''
  try {
    const s = await apiFetch<SettingsView>('/admin/api/settings')
    applySettings(s, options.merge ? baseline.value : null)
    return true
  } catch (e) {
    if (options.errorFallback) {
      refreshError.value = serverMessage(e, options.errorFallback)
      ElMessage.error(refreshError.value)
    }
    return false
  } finally {
    loading.value = false
  }
}

function applySettings(s: SettingsView, keep: Snapshot | null): void {
  const take = <K extends keyof Snapshot>(key: K, next: Snapshot[K]) => {
    // merge 模式下，操作员改过（与快照不一致）的字段保留原样，绝不覆盖。
    const edited = keep !== null && JSON.stringify(keep[key]) !== JSON.stringify(form[key])
    if (!edited) form[key] = next
  }
  const contestId = s.balloon.contestId
  take('domjudgeBaseUrl', s.domjudge.baseUrl)
  take('domjudgeAdminUser', s.domjudge.adminUser)
  take('balloonContestId', contestId)
  take('balloonPollIntervalSeconds', s.balloon.pollIntervalSeconds)
  take('adminUsername', s.admin.username)
  take('teamLoginStart', isoToLocalInput(s.teamLogin?.start ?? ''))
  take('teamLoginEnd', isoToLocalInput(s.teamLogin?.end ?? ''))

  // 服务端派生、前端只读的字段：始终以服务端为准。
  contestLocked.value = s.balloon.locked ?? contestId !== ''
  printTokenMasked.value = s.print.tokenMasked
  versionInfo.value = s.version ?? null

  applyBaseline()
}

function refresh(): Promise<boolean> {
  return pullSettings({ merge: false, errorFallback: '设置加载失败，请刷新重试' })
}

async function save(): Promise<void> {
  if (!loaded.value) return
  saveError.value = ''
  if (!pollIntervalValid.value) {
    pollIntervalTouched.value = true
    return
  }
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
    // 清空结果只服务于「刚清空完」的那次配置；保存成功后它就不再代表当前状态。
    purgeReport.value = null
    purgeError.value = ''
    // 只同步服务端派生状态（锁定、掩码、版本），不重读表单：别的卡片里还没保存的编辑必须留着。
    // 重读失败由这里统一说话：保存本身已经成功，不能再弹一句「设置加载失败」。
    const refreshed = await pullSettings({ merge: true })
    ElMessage.success('已保存，立即生效（端口与访问前缀例外，修改后需重启）')
    if (!refreshed) refreshError.value = '已保存，但设置未能重新读取，请手动刷新'
  } catch (e) {
    // 403 锁定的说明必须原样展示：管理员要据此知道先清空数据才能换比赛。
    const msg = serverMessage(e, '保存没成功，请检查填写内容后再试')
    saveError.value = msg
    ElMessage.error(msg)
  } finally {
    saving.value = false
  }
}

async function purge(): Promise<void> {
  if (!purgeReady.value || purging.value) return
  purgeError.value = ''
  purgeReport.value = null
  purging.value = true
  try {
    purgeReport.value = await apiFetch<PurgeReport>('/admin/api/data/purge', { method: 'POST' })
    purgeConfirm.value = ''
    ElMessage.success('数据已清空，比赛 ID 已解锁')
  } catch (e) {
    // 只有清空请求本身失败才算「清空没成功」。
    purgeError.value = serverMessage(e, '清空没成功，请稍后再试')
    purging.value = false
    return
  }
  // 清空已成功：随后按最新状态重渲染（比赛 ID 已置空、解锁）。刷新失败是另一回事，
  // 由 pullSettings 自己提示，绝不能反过来把清空说成失败。
  const refreshed = await pullSettings({ merge: false, errorFallback: '设置加载失败，请刷新重试' })
  if (!refreshed) refreshError.value = '已清空，但页面刷新失败，请手动刷新'
  purging.value = false
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

function randomToken(): string {
  const bytes = new Uint8Array(24);
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
      <section class="settings-card contest-card">
        <h2 class="card-title">比赛设置</h2>
        <span class="field-help">
          填写本场比赛的 DOMjudge 比赛 ID 与气球轮询间隔，并设置队伍码登录的允许时段。
        </span>
        <label class="field">
          <span class="field-label">比赛 ID（contestId）</span>
          <ElInput
            v-model="form.balloonContestId"
            placeholder="DOMjudge 比赛 ID"
            :readonly="contestLocked"
          />
          <span v-if="contestLocked" class="lock-hint">
            <span class="lock-badge">已锁定</span>
            比赛 ID 已锁定，如需更换请先清空比赛数据
          </span>
          <span v-else class="field-help">
            保存后即锁定；气球任务会绑定到这场比赛上，想换比赛要先清空数据。
          </span>
        </label>
        <label class="field">
          <span class="field-label">轮询间隔（秒）</span>
          <ElInput
            v-model.number="form.balloonPollIntervalSeconds"
            type="number"
            :min="1"
            @input="pollIntervalTouched = true"
          />
          <span v-if="showPollIntervalError" class="field-error poll-error">轮询间隔需为正整数</span>
        </label>

        <div class="card-divider" role="separator"></div>

        <span class="field-label">登录时段</span>
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

        <template v-if="contestLocked">
          <div class="card-divider" role="separator"></div>
          <div class="purge-block">
            <h3 class="purge-title">清空数据</h3>
            <p class="field-help">清空后比赛 ID 解锁，可以重新配置另一场比赛。此操作不可撤销。</p>
            <ul class="purge-list">
              <li>
                <span class="purge-tag purge-tag--danger">删除</span>
                队伍列表、队伍账号密码、队伍码、登录历史、审批记录、打印任务与留档源码/PDF、气球任务，并把比赛 ID 置空
              </li>
              <li>
                <span class="purge-tag purge-tag--keep">保留</span>
                其余设置（DOMjudge 连接、打印令牌、登录时段、管理端账号）、secret.key
              </li>
            </ul>
            <label class="field">
              <span class="field-label">请输入「{{ PURGE_WORD }}」以确认</span>
              <ElInput v-model="purgeConfirm" :placeholder="`输入${PURGE_WORD}以启用按钮`" />
              <span v-if="purgeConfirm.trim() !== '' && !purgeReady" class="purge-confirm-hint">
                请输入「{{ PURGE_WORD }}」两个中文字，才能启用按钮
              </span>
            </label>
            <div class="token-actions">
              <ElButton
                type="danger"
                :loading="purging"
                :disabled="!purgeReady"
                @click="purge"
              >清空数据</ElButton>
            </div>
            <p v-if="purgeError" class="field-error">{{ purgeError }}</p>
          </div>
        </template>

        <!-- 清空结果放在锁定区之外：刷新解锁后锁定区整体收起，条数仍然可见。 -->
        <div v-if="purgeReport" class="purge-result">
          <p class="purge-result-title">已清空：</p>
          <p class="purge-result-line">
            队伍 {{ purgeReport.teams }} 个 · 账号密码 {{ purgeReport.passwords }} 条 · 队伍码
            {{ purgeReport.teamCodes }} 条 · 登录历史 {{ purgeReport.loginHistory }} 条 · 审批记录
            {{ purgeReport.loginRequests }} 条 · 打印任务 {{ purgeReport.printTasks }} 条 · 气球任务
            {{ purgeReport.balloonTasks }} 条 · 留档文件 {{ purgeReport.filesRemoved }} 个
          </p>
          <p v-if="!purgeIdRefilled" class="purge-result-hint">比赛 ID 已置空，可以填写下一场比赛了。</p>
        </div>
      </section>

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
        <h2 class="card-title">打印回调 Token</h2>
        <label class="field">
          <span class="field-label">Token</span>
          <ElInput v-model="form.printToken" type="password" show-password placeholder="留空则不修改" />
          <div class="token-actions">
            <ElButton size="small" @click="generateToken">生成</ElButton>
            <ElButton size="small" @click="copyToken">复制</ElButton>
          </div>
          <span class="field-help">
            当前：{{ printTokenMasked || '未设置' }}。生成一个随机令牌，需要同步填到
            DOMjudge 的打印配置里（header <code>org.domjudge.print-token</code>）。
          </span>
        </label>
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
          <span v-else class="field-help">用户名与密码保存后立即生效，下次登录使用新账号。</span>
        </label>
      </section>
    </div>

    <div class="settings-footer">
      <ElButton type="primary" :loading="saving" :disabled="!loaded" @click="save">保存设置</ElButton>
      <span class="footer-note">
        保存后立即生效；端口、访问前缀、JWT 密钥例外，修改后需重启并重新登录。
      </span>
    </div>
    <p v-if="saveError" class="field-error save-error">{{ saveError }}</p>
    <p v-if="refreshError" class="refresh-error" role="alert">{{ refreshError }}</p>
    <p v-if="loading" class="footer-note">正在读取当前设置…</p>

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
  box-shadow: 0 1px 2px rgba(15, 15, 20, 0.04);
  transition: box-shadow 0.2s ease;
}

.settings-card:hover {
  box-shadow: 0 8px 24px rgba(15, 15, 20, 0.08);
}

/* 比赛设置是本页的主卡片：跨两列并带品牌色描边。 */
.contest-card {
  grid-column: 1 / -1;
  border-color: color-mix(in srgb, var(--brand-blue) 35%, transparent);
  background: color-mix(in srgb, var(--brand-blue) 5%, var(--bg-alt));
}

.card-title {
  margin: 0;
  font-size: var(--text-15);
  font-weight: 600;
  color: var(--text);
}

.contest-card .card-title {
  color: var(--brand-blue);
  font-size: var(--text-17);
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
  /* 品牌红 #ff7262 在白底上只有 ~2.6:1，正文用更深的红保证可读；亮红留给图标/描边。 */
  color: var(--danger-text);
  line-height: 1.6;
}

.field-help code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 0 4px;
}

.lock-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.6;
}

.lock-badge {
  flex-shrink: 0;
  padding: 1px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--brand-orange);
  border: 1px solid color-mix(in srgb, var(--brand-orange) 35%, transparent);
  background: color-mix(in srgb, var(--brand-orange) 12%, transparent);
}

.card-divider {
  height: 1px;
  background: var(--border);
  margin: 2px 0;
}

.purge-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: var(--radius-card);
  border: 1px solid color-mix(in srgb, var(--brand-red) 30%, transparent);
  background: color-mix(in srgb, var(--brand-red) 6%, transparent);
}

.purge-title {
  margin: 0;
  font-size: var(--text-15);
  font-weight: 600;
  color: var(--brand-red);
}

.purge-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.7;
}

.purge-tag {
  display: inline-block;
  margin-right: 8px;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  border: 1px solid transparent;
}

.purge-tag--danger {
  color: var(--brand-red);
  border-color: color-mix(in srgb, var(--brand-red) 35%, transparent);
  background: color-mix(in srgb, var(--brand-red) 12%, transparent);
}

.purge-tag--keep {
  color: var(--brand-green);
  border-color: color-mix(in srgb, var(--brand-green) 35%, transparent);
  background: color-mix(in srgb, var(--brand-green) 12%, transparent);
}

.purge-result {
  margin-top: 2px;
  padding: 12px 14px;
  border-radius: var(--radius-control);
  border: 1px solid color-mix(in srgb, var(--brand-green) 30%, transparent);
  background: color-mix(in srgb, var(--brand-green) 8%, transparent);
}

.purge-result-title {
  margin: 0 0 4px;
  font-size: var(--text-15);
  font-weight: 600;
  color: var(--brand-green);
}

.purge-result-line {
  margin: 0;
  font-size: var(--text-13);
  color: var(--text);
  line-height: 1.7;
}

.purge-result-hint {
  margin: 6px 0 0;
  font-size: var(--text-13);
  color: var(--text-muted);
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
  flex-wrap: wrap;
}

.footer-note {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.save-error {
  margin: 8px 0 0;
}

.refresh-error {
  margin: 8px 0 0;
  font-size: var(--text-13);
  color: var(--danger-text);
  line-height: 1.6;
}

.purge-confirm-hint {
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.6;
}

.version-line {
  margin: 0;
  font-size: var(--text-13);
  color: var(--text-muted);
}
</style>

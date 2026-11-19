import { computed, onMounted, reactive, ref } from 'vue'
import { messageError, messageSuccess } from '@/lib/feedback'
import { apiFetch } from '@/api'
import { serverMessage } from '@/lib/apiError'

export interface SettingsView {
  domjudge: { baseUrl: string; adminUser: string; timeoutSeconds: number }
  balloon: { contestId: string; pollIntervalSeconds: number; locked?: boolean }
  print: { tokenMasked: string }
  teamLogin?: { start: string; end: string }
  admin: { username: string }
  version?: { hash: string; year: number }
}

/** ISO datetime → value for <input type="datetime-local"> (local time); '' passes through. */
export function isoToLocalInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value → ISO string (UTC); '' passes through. */
export function localInputToIso(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toISOString()
}

/** 设置表单：拉取/合并、保存、字段校验与只读派生状态。 */
export function useSettingsForm() {
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
        messageError(refreshError.value)
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

  async function save(beforeRefresh?: () => void): Promise<void> {
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
      beforeRefresh?.()
      // 只同步服务端派生状态（锁定、掩码、版本），不重读表单：别的卡片里还没保存的编辑必须留着。
      // 重读失败由这里统一说话：保存本身已经成功，不能再弹一句「设置加载失败」。
      const refreshed = await pullSettings({ merge: true })
      messageSuccess('已保存，立即生效（端口与 JWT 密钥例外，修改后需重启）')
      if (!refreshed) refreshError.value = '已保存，但设置未能重新读取，请手动刷新'
    } catch (e) {
      // 403 锁定的说明必须原样展示：管理员要据此知道先清空数据才能换比赛。
      const msg = serverMessage(e, '保存没成功，请检查填写内容后再试')
      saveError.value = msg
      messageError(msg)
    } finally {
      saving.value = false
    }
  }

  /** 清空登录时段，保存后服务端按留空 = 不限制处理。 */
  function clearTeamLogin(): void {
    form.teamLoginStart = ''
    form.teamLoginEnd = ''
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

  async function copyToken(): Promise<void> {
    if (!form.printToken) return;
    try {
      await navigator.clipboard.writeText(form.printToken);
      messageSuccess('已复制到剪贴板');
    } catch {
      messageError('复制失败，请手动复制');
    }
  }

  onMounted(() => void refresh())

  return {
    form,
    loading,
    saving,
    loaded,
    refreshError,
    contestLocked,
    saveError,
    printTokenMasked,
    adminPasswordError,
    versionInfo,
    pollIntervalValid,
    pollIntervalTouched,
    showPollIntervalError,
    purgeIdRefilled,
    pullSettings,
    refresh,
    save,
    clearTeamLogin,
    generateToken,
    copyToken,
  }
}

export type SettingsFormStore = ReturnType<typeof useSettingsForm>

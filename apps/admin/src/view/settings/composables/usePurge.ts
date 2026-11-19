import { computed, ref } from 'vue'
import { messageSuccess } from '@/lib/feedback'
import { apiFetch } from '@/api'
import { serverMessage } from '@/lib/apiError'
import type { SettingsFormStore } from '@/view/settings/composables/useSettingsForm'

/** POST /admin/api/data/purge 的返回：每类数据的删除条数与归档文件数。 */
export interface PurgeReport {
  teams: number
  passwords: number
  teamCodes: number
  printTasks: number
  balloonTasks: number
  loginHistory: number
  loginRequests: number
  filesRemoved: number
}

/** 危险操作「清空数据」：二次确认词、执行与结果展示。 */
export function usePurge(form: SettingsFormStore['form'], pullSettings: SettingsFormStore['pullSettings'], setRefreshError: (msg: string) => void) {
  /** 清空数据的二次确认词：首尾空白不算，输入「清空」才解锁按钮。 */
  const PURGE_WORD = '清空'
  const purgeConfirm = ref('')
  const purgeError = ref('')
  const purgeReport = ref<PurgeReport | null>(null)
  const purging = ref(false)
  const purgeReady = computed(() => purgeConfirm.value.trim() === PURGE_WORD)
  /** 危险操作默认折叠：只留一行开关，展开后才出现清单、确认框和按钮。 */
  const purgeExpanded = ref(false)

  async function purge(): Promise<void> {
    if (!purgeReady.value || purging.value) return
    purgeError.value = ''
    purgeReport.value = null
    purging.value = true
    try {
      purgeReport.value = await apiFetch<PurgeReport>('/admin/api/data/purge', { method: 'POST' })
      purgeConfirm.value = ''
      messageSuccess('数据已清空，比赛 ID 已解锁')
    } catch (e) {
      // 只有清空请求本身失败才算「清空没成功」。
      purgeError.value = serverMessage(e, '清空没成功，请稍后再试')
      purging.value = false
      return
    }
    // 清空已成功：随后按最新状态重渲染（比赛 ID 已置空、解锁）。刷新失败是另一回事，
    // 由 pullSettings 自己提示，绝不能反过来把清空说成失败。
    const refreshed = await pullSettings({ merge: false, errorFallback: '设置加载失败，请刷新重试' })
    if (!refreshed) setRefreshError('已清空，但页面刷新失败，请手动刷新')
    purging.value = false
  }

  /** 保存成功后，旧的清空结果不再代表当前状态。 */
  function resetReport(): void {
    purgeReport.value = null
    purgeError.value = ''
  }

  return { PURGE_WORD, purgeConfirm, purgeError, purgeReport, purging, purgeReady, purgeExpanded, purge, resetReport }
}

export type PurgeStore = ReturnType<typeof usePurge>

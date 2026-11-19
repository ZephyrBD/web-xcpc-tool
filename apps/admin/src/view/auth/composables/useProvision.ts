import { computed, onUnmounted, ref } from 'vue'
import { confirmDialog, messageInfo } from '@/lib/feedback'
import { apiFetch } from '@/api'
import type { TeamCodeRow } from '@/types'

interface ProvisionResult {
  icpcId: string
  name: string
  status: 'ok' | 'skip' | 'fail'
  reason?: string
}

/** 一键配置密码：逐队调用 DOMjudge 重置密码，带进度弹窗与取消。 */
export function useProvision(refresh: () => Promise<void>, getRows: () => TeamCodeRow[]) {
  const provDialog = ref(false)
  const provRunning = ref(false)
  const provCancelled = ref(false)
  // 组件卸载（离开页面）后必须停止循环，避免无人值守的密码重置请求继续发出。
  const provDisposed = ref(false)
  const provTargets = ref<TeamCodeRow[]>([])
  const provResults = ref<ProvisionResult[]>([])

  onUnmounted(() => {
    provDisposed.value = true
  })

  const provProgress = computed(() =>
    provTargets.value.length === 0 ? 0 : Math.round((provResults.value.length / provTargets.value.length) * 100),
  )
  const provOk = computed(() => provResults.value.filter((r) => r.status === 'ok').length)
  const provSkip = computed(() => provResults.value.filter((r) => r.status === 'skip').length)
  const provFail = computed(() => provResults.value.filter((r) => r.status === 'fail').length)
  const provCurrent = computed(() => provTargets.value[provResults.value.length] ?? null)
  const provStatus = computed(() => {
    if (provRunning.value) return undefined
    if (provFail.value > 0) return 'exception'
    if (provCancelled.value || provDisposed.value) return 'warning'
    return 'success'
  })
  // 仅当所有队伍都失败（且原因一致）时才提示权限问题，部分失败时该提示会误导。
  const allFailSameReason = computed(() => {
    if (provResults.value.length === 0 || provFail.value !== provResults.value.length) return false
    return provResults.value.every((f) => f.reason === provResults.value[0].reason)
  })

  function friendlyReason(reason: string): string {
    if (reason.includes('not found')) return 'DOMjudge 中没有该用户名的账号'
    if (reason.includes('refusing non-team')) return '该账号不是纯队伍账号，已跳过'
    return reason
  }

  async function provisionOne(row: TeamCodeRow): Promise<ProvisionResult> {
    try {
      const { provisioned, skipped, errors } = await apiFetch<{
        provisioned: number
        skipped: number
        errors: Array<{ icpcId: string; reason: string }>
      }>('/admin/api/team-codes/provision', {
        method: 'POST',
        body: JSON.stringify({ icpcId: row.icpcId }),
      })
      const reason = errors[0]?.reason
      if (provisioned > 0) return { icpcId: row.icpcId, name: row.name, status: 'ok' }
      return {
        icpcId: row.icpcId,
        name: row.name,
        status: skipped > 0 ? 'skip' : 'fail',
        reason: reason ? friendlyReason(reason) : '未知原因',
      }
    } catch (err) {
      console.warn(`provision ${row.icpcId} failed:`, err instanceof Error ? err.message : String(err))
      return { icpcId: row.icpcId, name: row.name, status: 'fail', reason: '请求失败，请检查 DOMjudge 是否可用' }
    }
  }

  async function onProvision(): Promise<void> {
    try {
      await confirmDialog(
        '会通过 DOMjudge API 重置这些队伍的密码（没有队伍码或没有密码的队伍都会被配置），确定继续吗？',
        '一键配置密码',
        {
          confirmButtonText: '配置',
          cancelButtonText: '取消',
          type: 'warning',
        },
      )
    } catch {
      return
    }
    // targets come from a fresh list so we don't provision stale rows
    await refresh()
    const targets = getRows().filter((t) => t.icpcId !== '' && (!t.teamCode || !t.hasPassword))
    if (targets.length === 0) {
      messageInfo('所有队伍都已配置好了')
      return
    }
    provTargets.value = targets
    provResults.value = []
    provCancelled.value = false
    provRunning.value = true
    provDialog.value = true
    try {
      for (const t of targets) {
        if (provCancelled.value || provDisposed.value) break
        provResults.value.push(await provisionOne(t))
      }
    } finally {
      provRunning.value = false
      if (!provDisposed.value) await refresh()
    }
  }

  function cancelProvision(): void {
    provCancelled.value = true
  }

  return {
    provDialog,
    provRunning,
    provCancelled,
    provTargets,
    provResults,
    provProgress,
    provOk,
    provSkip,
    provFail,
    provCurrent,
    provStatus,
    allFailSameReason,
    onProvision,
    cancelProvision,
  }
}

export type ProvisionStore = ReturnType<typeof useProvision>

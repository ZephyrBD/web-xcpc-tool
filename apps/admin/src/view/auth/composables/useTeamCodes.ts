import { ref } from 'vue'
import { alertDialog, confirmDialog, messageError, messageSuccess } from '@/lib/feedback'
import { apiFetch } from '@/api'
import { usePagination } from '@/composables/usePagination'
import type { TeamCodeRow, TeamCodesResponse } from '@/types'

/** 队伍码列表：拉取、分页、重新生成、批量生成、导出 CSV 与复制。 */
export function useTeamCodes() {
  const rows = ref<TeamCodeRow[]>([])
  const unassigned = ref(0)
  const loading = ref(false)
  const { page, pageSize, paged: pagedRows } = usePagination(rows)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const data = await apiFetch<TeamCodesResponse>('/admin/api/team-codes')
      rows.value = data.rows
      unassigned.value = data.unassigned
    } catch {
      messageError('队伍码列表加载失败，请刷新重试')
    } finally {
      loading.value = false
    }
  }

  async function onGenerate(row: TeamCodeRow): Promise<void> {
    try {
      await confirmDialog(`确定为队伍 ${row.name || row.icpcId} 重新生成队伍码？旧队伍码将立即失效。`, '重新生成队伍码', {
        confirmButtonText: '重新生成',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch {
      return
    }
    try {
      const { teamCode } = await apiFetch<{ icpcId: string; teamCode: string }>('/admin/api/team-codes/generate', {
        method: 'POST',
        body: JSON.stringify({ icpcId: row.icpcId }),
      })
      await refresh()
      alertDialog(teamCode, '新的队伍码', { confirmButtonText: '我已保存', center: true })
    } catch {
      messageError('生成没成功，请再试一次')
    }
  }

  const generatingAll = ref(false)

  async function onGenerateAll(): Promise<void> {
    generatingAll.value = true
    try {
      const { count } = await apiFetch<{ count: number }>('/admin/api/team-codes/generate', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
      })
      messageSuccess(count > 0 ? `已为 ${count} 个未分配队伍生成队伍码` : '所有队伍都已有队伍码')
      await refresh()
    } catch {
      messageError('批量生成没成功，请再试一次')
    } finally {
      generatingAll.value = false
    }
  }

  const exporting = ref(false)

  async function onExport(): Promise<void> {
    try {
      await confirmDialog('导出内容包含 DOMjudge 密码，请妥善保管。', '导出队伍码 CSV', {
        confirmButtonText: '导出',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch {
      return
    }
    exporting.value = true
    try {
      const blob = await apiFetch<Blob>('/admin/api/team-codes/export', { blob: true })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `team-codes-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      messageSuccess('已导出 CSV（包含 DOMjudge 密码，请妥善保管）')
    } catch {
      messageError('导出没成功，请再试一次')
    } finally {
      exporting.value = false
    }
  }

  async function onCopy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      messageSuccess('已复制到剪贴板')
    } catch {
      messageError('复制失败，请手动复制')
    }
  }

  return {
    rows,
    unassigned,
    loading,
    pagedRows,
    page,
    pageSize,
    generatingAll,
    exporting,
    refresh,
    onGenerate,
    onGenerateAll,
    onExport,
    onCopy,
  }
}

export type TeamCodesStore = ReturnType<typeof useTeamCodes>

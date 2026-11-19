import { ref, watch } from 'vue'
import { messageError } from '@/lib/feedback'
import { apiFetch } from '@/api'
import { usePagination } from '@/composables/usePagination'
import { printPdfTask } from '@/utils/printPdf'
import type { PrintTask } from '@/types'

/** 打印任务列表：拉取、分页、自动打印开关与打印/确认操作。 */
export function usePrintTasks() {
  const printTasks = ref<PrintTask[]>([])
  const { page: printPage, pageSize: printPageSize, paged: pagedPrintTasks } = usePagination(printTasks)

  // 收到新任务自动打印：本地开关，默认关。打印走隐藏 iframe（document.write
  // HTML），若浏览器因缺少用户手势忽略打印请求，管理员可手动点「打印」。
  const AUTO_PRINT_KEY = 'cxtool_autoprint'
  const autoPrint = ref(localStorage.getItem(AUTO_PRINT_KEY) === '1')
  watch(autoPrint, (v) => localStorage.setItem(AUTO_PRINT_KEY, v ? '1' : '0'))

  // 已见过的任务 id：只有随 SSE 新出现的待打任务才自动打印，避免 refresh()
  // 重新拉列表时对老任务重复触发。浏览器要求打印通常有用户手势，SSE 触发的
  // 自动打印可能被静默忽略——属已知限制。
  const knownPrintIds = new Set<string>()

  async function refresh(): Promise<void> {
    try {
      printTasks.value = await apiFetch<PrintTask[]>('/admin/api/print-tasks')
      for (const t of printTasks.value) knownPrintIds.add(t.id)
    } catch {
      // 轮询失败不打断页面，下一条 SSE 事件会再触发刷新。
    }
  }

  /** Print + auto-ack: the ack fires only when the browser confirms the print
   * via afterprint (Chromium dispatches it on the TOP window for iframe
   * print() calls — never on button click alone); a confirmation timeout
   * resolves false and must not ack. */
  async function printAndAck(id: string): Promise<void> {
    const confirmed = await printPdfTask(id, apiFetch)
    if (!confirmed) return
    await apiFetch(`/admin/api/print-tasks/${id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ status: 'printed' }),
    })
    await refresh()
  }

  async function printRow(row: PrintTask): Promise<void> {
    try {
      await printAndAck(row.id)
    } catch (e) {
      // 专属文案（弹窗拦截 / 旧任务无留档）原样提示；其余失败走通用文案
      messageError(
        e instanceof Error && (e.message.includes('弹窗') || e.message.includes('留档'))
          ? e.message
          : '打印没成功，请再试一次',
      )
    }
  }

  async function ackPrint(row: PrintTask, status: 'printed' | 'failed'): Promise<void> {
    try {
      await apiFetch(`/admin/api/print-tasks/${row.id}/ack`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
    } catch {
      messageError('操作没成功，请再试一次')
    } finally {
      await refresh()
    }
  }

  // SSE 变更 300ms 防抖合并刷新。
  let timer: ReturnType<typeof setTimeout> | null = null
  function scheduleRefresh(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, 300)
  }

  function dispose(): void {
    if (timer) clearTimeout(timer)
  }

  return {
    printTasks,
    pagedPrintTasks,
    printPage,
    printPageSize,
    autoPrint,
    knownPrintIds,
    refresh,
    printAndAck,
    printRow,
    ackPrint,
    scheduleRefresh,
    dispose,
  }
}

export type PrintTasksStore = ReturnType<typeof usePrintTasks>

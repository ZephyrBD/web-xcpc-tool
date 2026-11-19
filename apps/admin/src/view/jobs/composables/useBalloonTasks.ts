import { ref, watch } from 'vue'
import { messageError } from '@/lib/feedback'
import { apiFetch } from '@/api'
import { usePagination } from '@/composables/usePagination'
import { printBalloonTask } from '@/utils/printBalloon'
import type { BalloonTask } from '@/types'

/** 气球任务列表：拉取、分页、自动打印开关与打印/确认操作。 */
export function useBalloonTasks() {
  const balloonTasks = ref<BalloonTask[]>([])
  const { page: balloonPage, pageSize: balloonPageSize, paged: pagedBalloonTasks } = usePagination(balloonTasks)

  // 收到新气球自动打印：与打印任务同样的机制，独立开关与去重集合。
  const AUTO_BALLOON_KEY = 'cxtool_autoprint_balloon'
  const autoPrintBalloon = ref(localStorage.getItem(AUTO_BALLOON_KEY) === '1')
  watch(autoPrintBalloon, (v) => localStorage.setItem(AUTO_BALLOON_KEY, v ? '1' : '0'))
  const knownBalloonIds = new Set<string>()

  async function refresh(): Promise<void> {
    try {
      balloonTasks.value = await apiFetch<BalloonTask[]>('/admin/api/balloon-tasks')
      for (const t of balloonTasks.value) knownBalloonIds.add(t.id)
    } catch {
      // 同上：气球服务可能未启用（503），静默等待下次刷新。
    }
  }

  async function printAndAck(task: BalloonTask): Promise<void> {
    const confirmed = await printBalloonTask(task, apiFetch)
    if (!confirmed) return
    await apiFetch(`/admin/api/balloon-tasks/${task.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    await refresh()
  }

  async function printBalloonRow(row: BalloonTask): Promise<void> {
    try {
      await printAndAck(row)
    } catch (e) {
      messageError(
        e instanceof Error && (e.message.includes('弹窗') || e.message.includes('留档'))
          ? e.message
          : '打印没成功，请再试一次',
      )
    }
  }

  async function ackBalloon(row: BalloonTask): Promise<void> {
    try {
      await apiFetch(`/admin/api/balloon-tasks/${row.id}/ack`, {
        method: 'POST',
        body: JSON.stringify({}),
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
    balloonTasks,
    pagedBalloonTasks,
    balloonPage,
    balloonPageSize,
    autoPrintBalloon,
    knownBalloonIds,
    refresh,
    printAndAck,
    printBalloonRow,
    ackBalloon,
    scheduleRefresh,
    dispose,
  }
}

export type BalloonTasksStore = ReturnType<typeof useBalloonTasks>

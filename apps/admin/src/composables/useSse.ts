import { onUnmounted } from 'vue'
import { useSessionStore } from '@/stores/session'

export type SseHandler = (event: string, data: unknown) => void

const EVENT_NAMES = ['auth-task', 'print-task', 'balloon-task'] as const

/**
 * Opens one EventSource to /admin/api/events using the session's SSE token
 * as a ?token= query param (EventSource cannot set headers). Does nothing
 * when there is no token (e.g. before login). Closes automatically on unmount.
 */
export function useSse(onEvent: SseHandler): void {
  const session = useSessionStore()
  const token = session.sseToken
  if (!token) return

  const es = new EventSource(`/cxtool/admin/api/events?token=${encodeURIComponent(token)}`)
  const handle = (name: string) => (e: MessageEvent) => {
    let data: unknown = null
    try {
      data = JSON.parse(e.data)
    } catch {
      data = e.data
    }
    onEvent(name, data)
  }
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, handle(name) as EventListener)
  }
  onUnmounted(() => es.close())
}

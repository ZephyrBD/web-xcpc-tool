/**
 * Fetches a print task's PDF with the admin auth header (an iframe cannot set
 * Authorization headers, so a plain URL won't do), loads it into a hidden
 * iframe via an object URL, and triggers the browser print dialog — the same
 * approach as the legacy Java admin UI. The object URL is revoked afterwards.
 *
 * The returned promise resolves ONLY on the iframe window's `afterprint`
 * event — the standard best-effort signal that the browser actually accepted
 * the print request (Chrome/Edge fire it when the job is submitted, not when
 * printing finishes; Firefox also fires it when the dialog is cancelled).
 * Callers treat resolution as "print confirmed" and may auto-ack the task.
 *
 * Note: browsers may silently ignore iframe.contentWindow.print() when there
 * was no prior user gesture (relevant for SSE auto-print). That's accepted —
 * worst case the promise never resolves and the admin prints the task
 * manually from the jobs list.
 */
export type PdfApiFetch = <T>(path: string, opts?: { blob?: boolean }) => Promise<T>

/** Delay before cleanup so the print dialog has time to read the object URL. */
const CLEANUP_DELAY_MS = 60_000
/** Safety timeout for the afterprint confirmation (unconfirmed → no ack). */
const CONFIRM_TIMEOUT_MS = 60_000

export function printViaIframe(iframe: HTMLIFrameElement): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (!iframe.isConnected) document.body.appendChild(iframe)
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow
      if (!win) {
        // Without a frame window there is nothing to print or confirm;
        // reject so callers surface an error instead of hanging forever.
        reject(new Error('iframe window unavailable, cannot print'))
        return
      }
      void confirmOnAfterprint(win).then(resolve)
    })
    window.setTimeout(() => {
      iframe.remove()
    }, CLEANUP_DELAY_MS)
  })
}

/**
 * Calls the frame window's print() and resolves once the browser confirms
 * the print job via its `afterprint` event (see file header) — true means
 * confirmed (safe to ack), false means the 60s safety timeout elapsed
 * without afterprint (e.g. the browser silently ignored the print call), so
 * callers must NOT ack. Exposed for testing without a real DOM.
 */
export function confirmOnAfterprint(win: Window, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined
    // Browsers differ on where `afterprint` dispatches for an iframe print():
    // Chromium targets the frame's window, other engines the top window.
    // Listen on BOTH, or the confirmation is silently lost and the task
    // never acks. The listener is registered BEFORE print() because the
    // event may dispatch while/just after the blocking print() call.
    // happy-dom's contentWindow lacks event methods; real browsers always
    // have them. Listen only where listening is possible.
    const targets = [win, window].filter(
      (t) => typeof t.addEventListener === 'function' && typeof t.removeEventListener === 'function',
    )
    const onAfterprint = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      for (const t of targets) t.removeEventListener('afterprint', onAfterprint)
      resolve(true)
    }
    for (const t of targets) t.addEventListener('afterprint', onAfterprint)
    // happy-dom (test env) has no window.print; real browsers always do.
    if (typeof win.print === 'function') win.print()
    timer = window.setTimeout(() => {
      if (!settled) {
        settled = true
        for (const t of targets) t.removeEventListener('afterprint', onAfterprint)
        resolve(false)
      }
    }, timeoutMs)
  })
}

/** Grace period after the print promise settles before the frame is torn
 * down: Chromium's print() returns when the dialog closes, but the frame's
 * afterprint still dispatches asynchronously — an immediate removal would
 * destroy the frame before the event can fire. */
const AFTERPRINT_GRACE_MS = 1_000

export async function printPdfTask(id: string, apiFetch: PdfApiFetch): Promise<boolean> {
  const blob = await apiFetch<Blob>(`/admin/api/print-tasks/${id}/pdf`, { blob: true })
  const url = URL.createObjectURL(blob)
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = url
  const cleanup = () => {
    iframe.remove()
    URL.revokeObjectURL(url)
  }
  try {
    return await printViaIframe(iframe)
  } finally {
    window.setTimeout(cleanup, AFTERPRINT_GRACE_MS)
  }
}

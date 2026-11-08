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

export function printViaIframe(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    if (!iframe.isConnected) document.body.appendChild(iframe)
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow
      if (!win) return
      void confirmOnAfterprint(win).then(resolve)
    })
    window.setTimeout(() => {
      iframe.remove()
    }, CLEANUP_DELAY_MS)
  })
}

/**
 * Calls the frame window's print() and resolves once the browser confirms
 * the print job via its `afterprint` event (see file header). Exposed for
 * testing without a real DOM.
 */
export function confirmOnAfterprint(win: Window): Promise<void> {
  return new Promise((resolve) => {
    win.addEventListener('afterprint', () => resolve())
    // happy-dom (test env) has no window.print; real browsers always do.
    if (typeof win.print === 'function') win.print()
  })
}

export async function printPdfTask(id: string, apiFetch: PdfApiFetch): Promise<void> {
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
    await printViaIframe(iframe)
  } finally {
    cleanup()
  }
}

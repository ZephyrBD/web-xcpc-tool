/**
 * Fetches a print task's PDF with the admin auth header (an iframe cannot set
 * Authorization headers, so a plain URL won't do), loads it into a hidden
 * iframe via an object URL, and triggers the browser print dialog — the same
 * approach as the legacy Java admin UI. The object URL is revoked afterwards.
 *
 * The returned promise resolves ONLY on the browser's `afterprint`
 * event — the best-effort signal that the browser actually accepted
 * the print request (Chrome/Edge fire it when the job is submitted, not when
 * printing finishes; Firefox also fires it when the dialog is cancelled).
 * Callers treat resolution as "print confirmed" and may auto-ack the task.
 * The PRIMARY signal is the TOP window's `afterprint`: Chromium dispatches
 * the event there for iframe print() calls (and for object-URL frames often
 * not on the frame at all); the frame listener is only a fallback.
 * A second layered signal is the `print` media query on the TOP window:
 * Chromium flips it on when the preview opens and off when it closes, so a
 * false→true→false transition also counts as confirmed.
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
 * the print job via `afterprint` (see file header) — true means
 * confirmed (safe to ack), false means the 60s safety timeout elapsed
 * without afterprint (e.g. the browser silently ignored the print call), so
 * callers must NOT ack. Exposed for testing without a real DOM.
 */
export function confirmOnAfterprint(win: Window, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined
    // Chromium dispatches `afterprint` for an iframe print() on the TOP
    // window — for object-URL frames it often does not fire on the frame's
    // own window at all, which silently starves the confirmation and the
    // task never acks. The TOP window is therefore the primary signal and
    // is listed first; the frame listener is kept as a best-effort fallback
    // for engines that dispatch there. Listeners are registered BEFORE
    // print() because the event may dispatch while/just after the (async
    // preview) print() call returns. happy-dom's contentWindow may lack
    // event methods; real browsers always have them. Listen only where
    // listening is possible.
    const targets = [window, win].filter(
      (t) => typeof t.addEventListener === 'function' && typeof t.removeEventListener === 'function',
    )
    // Layered confirmation #2: Chromium toggles the `print` media query when
    // the print preview opens and closes. A false→true→false transition on
    // the TOP window counts as "preview closed = print confirmed" even when
    // `afterprint` never fires (observed in real Chromium for object-URL
    // iframes). A close-transition without a prior open is ignored — it may
    // be a stale query matching at call time. Guarded by method checks so
    // environments without functioning matchMedia (test stubs) simply skip
    // this layer.
    let mql: MediaQueryList | undefined
    let onMediaChange: (() => void) | undefined
    const detachPrintMedia = () => {
      if (!mql || !onMediaChange) return
      const legacy = mql as unknown as { removeListener?: (fn: () => void) => void }
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onMediaChange)
      else if (typeof legacy.removeListener === 'function') legacy.removeListener(onMediaChange)
    }
    if (typeof window.matchMedia === 'function') {
      mql = window.matchMedia('print')
      const legacy = mql as unknown as { addListener?: (fn: () => void) => void }
      onMediaChange = () => {
        console.debug(`[print] matchMedia('print') change → matches=${mql?.matches}`)
        if (mql?.matches) printPreviewOpen = true
        else if (printPreviewOpen) settle(true, 'print media close')
      }
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onMediaChange)
      else if (typeof legacy.addListener === 'function') legacy.addListener(onMediaChange)
      else {
        mql = undefined
        onMediaChange = undefined
      }
    }
    let printPreviewOpen = mql?.matches === true
    const settle = (confirmed: boolean, why = '') => {
      if (settled) return
      settled = true
      console.debug(`[print] settle(${confirmed})${why ? ' via ' + why : ''}`)
      window.clearTimeout(timer)
      for (const t of targets) t.removeEventListener('afterprint', onAfterprint)
      detachPrintMedia()
      resolve(confirmed)
    }
    const onAfterprint = () => settle(true, 'afterprint on ' + (win === window ? 'top' : 'frame'))
    for (const t of targets) t.addEventListener('afterprint', onAfterprint)
    // happy-dom (test env) has no window.print; real browsers always do.
    if (typeof win.print === 'function') {
      console.debug('[print] calling win.print(), targets:', targets.length, 'matchMedia:', !!mql)
      win.print()
    } else {
      console.debug('[print] win.print unavailable')
    }
    timer = window.setTimeout(() => settle(false, 'timeout'), timeoutMs)
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

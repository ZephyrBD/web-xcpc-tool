/**
 * Fetches a print task's PDF with the admin auth header (a popup window
 * cannot set Authorization headers either, so a plain URL won't do), loads
 * it into a real popup window via an object URL, and triggers the browser
 * print dialog. The object URL is revoked afterwards.
 *
 * Why a popup and not a hidden iframe: Chromium renders PDFs in its
 * built-in PDF viewer plugin inside the frame. The plugin document is not
 * a normal document, so the iframe's `load` event never fires for our
 * listener — the print call never happened and afterprint never fired
 * (root cause of the silent "打印 does nothing" bug). A popup window is a
 * real window context: its `load` fires and print()/afterprint work.
 *
 * The returned promise resolves ONLY on the browser's `afterprint`
 * event — the best-effort signal that the browser actually accepted
 * the print request (Chrome/Edge fire it when the job is submitted, not when
 * printing finishes; Firefox also fires it when the dialog is cancelled).
 * Callers treat resolution as "print confirmed" and may auto-ack the task.
 * Signals are layered (see confirmOnAfterprint): the POPUP window's
 * `afterprint`, the TOP (opener) window's `afterprint`, and the `print`
 * media query transition on the opener.
 *
 * Note: browsers may silently ignore print() without a prior user gesture
 * (relevant for SSE auto-print). That's accepted — worst case the promise
 * never resolves and the admin prints the task manually from the jobs list.
 * The popup also stays open with the PDF viewer's own print button, so the
 * admin can always print it by hand.
 */
export type PdfApiFetch = <T>(path: string, opts?: { blob?: boolean }) => Promise<T>

/** Safety timeout for the afterprint confirmation (unconfirmed → no ack). */
const CONFIRM_TIMEOUT_MS = 60_000

/**
 * Opens a print popup. Returns the real window context for the document to
 * print. Throws a friendly error when a popup blocker nulls the open (the
 * click-handler chain is a user gesture, so this mostly happens for
 * SSE-triggered auto-print without prior interaction).
 */
export function openPrintPopup(url: string | undefined = undefined): Window {
  const popWin = window.open(url ?? 'about:blank', '_blank', 'popup,width=900,height=700')
  if (!popWin) throw new Error('弹窗被拦截，请允许弹窗后重试')
  return popWin
}

/**
 * Drives the print dialog in an already-opened popup window: waits for the
 * popup's `load` (a real window context — unlike a hidden iframe loading a
 * PDF plugin document, this always fires), then hands the popup window to
 * confirmOnAfterprint, which calls print() and resolves on confirmation.
 */
export function printViaPopup(popWin: Window): Promise<boolean> {
  return new Promise((resolve) => {
    const start = () => void confirmOnAfterprint(popWin).then(resolve)
    if (popWin.document.readyState === 'complete') start()
    else popWin.addEventListener('load', start, { once: true })
  })
}

/**
 * Calls the window's print() and resolves once the browser confirms
 * the print job via `afterprint` — true means
 * confirmed (safe to ack), false means the 60s safety timeout elapsed
 * without afterprint (e.g. the browser silently ignored the print call), so
 * callers must NOT ack. Exposed for testing without a real DOM.
 */
export function confirmOnAfterprint(win: Window, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined
    // Chromium dispatches `afterprint` on the window whose print() was
    // called; a top-window listener is kept as a fallback for engines that
    // dispatch there. Listeners are registered BEFORE print() because the
    // event may dispatch while/just after the (async preview) print() call
    // returns. happy-dom stubs may lack event methods; real browsers always
    // have them. Listen only where listening is possible.
    const targets = [window, win].filter(
      (t) => typeof t.addEventListener === 'function' && typeof t.removeEventListener === 'function',
    )
    // Layered confirmation #2: Chromium toggles the `print` media query when
    // the print preview opens and closes. A false→true→false transition on
    // the TOP window counts as "preview closed = print confirmed" even when
    // `afterprint` never fires. A close-transition without a prior open is
    // ignored — it may be a stale query matching at call time. Guarded by
    // method checks so environments without functioning matchMedia (test
    // stubs) simply skip this layer.
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
    const onAfterprint = () => settle(true, 'afterprint on ' + (win === window ? 'top' : 'popup'))
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

/** Grace period after the print promise settles before the popup is closed
 * and the object URL revoked: the afterprint may still dispatch
 * asynchronously, and an immediate teardown would kill the window first. */
const AFTERPRINT_GRACE_MS = 1_000

export async function printPdfTask(id: string, apiFetch: PdfApiFetch): Promise<boolean> {
  const blob = await apiFetch<Blob>(`/admin/api/print-tasks/${id}/pdf`, { blob: true })
  const url = URL.createObjectURL(blob)
  try {
    return await printBlobUrl(url)
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), AFTERPRINT_GRACE_MS)
  }
}

/**
 * Prints an already-created object URL in a print popup: opens the window,
 * focuses it, waits for `load`, calls print(), and resolves on the layered
 * afterprint/matchMedia confirmation (see confirmOnAfterprint). The popup is
 * closed after a grace delay so an async afterprint still lands. Separated
 * from printPdfTask so tests can exercise the full popup flow against the
 * real implementation while the fetch/object-URL plumbing stays thin.
 */
export async function printBlobUrl(url: string): Promise<boolean> {
  const popWin = openPrintPopup(url)
  try {
    if (typeof popWin.focus === 'function') popWin.focus()
    return await printViaPopup(popWin)
  } finally {
    window.setTimeout(() => {
      try {
        popWin.close()
      } catch {
        // the popup may already be gone; nothing to clean up
      }
    }, AFTERPRINT_GRACE_MS)
  }
}

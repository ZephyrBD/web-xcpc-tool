/**
 * Prints a print-task's archived source as an HTML document inside a hidden
 * iframe. The server renders GET /admin/api/print-tasks/:id/source-html
 * (formatted code + per-page header/footer); the HTML TEXT is written into
 * the iframe via document.write and print() is called on the frame window.
 *
 * Why document.write HTML and not the PDF blob: Chromium renders PDFs in its
 * built-in PDF viewer plugin inside the frame — a plugin document is not a
 * normal document, so the iframe's `load` never fires and print()/afterprint
 * are unreachable (root cause of the silent "打印 does nothing" bug). An HTML
 * document written via document.write is a real document: load fires,
 * print() works, afterprint confirms. The balloon ticket path already
 * printed successfully this way — both task kinds share printViaIframe.
 *
 * The returned promise resolves ONLY on the layered confirmation
 * (confirmOnAfterprint): true means confirmed (safe to ack), false means the
 * 60s safety timeout elapsed (unconfirmed → do NOT ack). Browsers may
 * silently ignore print() without a prior user gesture (relevant for
 * SSE auto-print) — accepted, worst case the admin prints manually.
 */

/** Safety timeout for the afterprint confirmation (unconfirmed → no ack). */
const CONFIRM_TIMEOUT_MS = 60_000

/** Grace period after the print promise settles before the iframe is removed:
 * the afterprint may still dispatch asynchronously, and an immediate teardown
 * would kill the frame first. */
const AFTERPRINT_GRACE_MS = 1_000

export type PrintApiFetch = <T>(path: string, opts?: { blob?: boolean; text?: boolean }) => Promise<T>

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

/**
 * Shared print flow for both task kinds: writes an HTML document into a
 * fresh hidden iframe (document.write — the proven mechanics from the
 * balloon ticket path), calls print() on the frame window once the write's
 * load has landed, and resolves on the layered confirmation. The iframe is
 * removed after a grace delay so an async afterprint still lands.
 */
export function printViaIframe(html: string, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    const style = frame.style
    style.position = 'fixed'
    style.width = '0'
    style.height = '0'
    style.border = '0'
    style.visibility = 'hidden'
    const cleanup = () => {
      if (frame.parentNode) frame.parentNode.removeChild(frame)
    }
    let started = false
    const start = () => {
      // Three start paths (load event, readyState, fallback timer) can all
      // land for one frame; guard so the print dialog opens exactly once.
      if (started) return
      started = true
      const win = frame.contentWindow
      if (!win) {
        resolve(false)
        return
      }
      void confirmOnAfterprint(win, timeoutMs).then((confirmed) => {
        window.setTimeout(cleanup, AFTERPRINT_GRACE_MS)
        resolve(confirmed)
      })
    }
    document.body.appendChild(frame)
    const doc = frame.contentDocument
    if (!doc) {
      resolve(false)
      return
    }
    doc.open()
    doc.write(html)
    doc.close()
    // The write triggers an async load; if the document already reports
    // complete, start immediately. A short fallback covers environments
    // where the frame's load event never lands (after close() the document
    // is fully parsed, so printing then is safe).
    frame.addEventListener('load', start, { once: true })
    if (doc.readyState === 'complete') start()
    else window.setTimeout(start, 100)
  })
}

/**
 * Fetches the task's print-ready HTML from the server and prints it via the
 * hidden-iframe flow. Throws a distinguishable error for tasks archived
 * before source archival existed (or PDF-only uploads) so the caller can
 * surface "旧任务没有留档，请手动标记" instead of a generic failure.
 */
export async function printPdfTask(id: string, apiFetch: PrintApiFetch): Promise<boolean> {
  let html: string
  try {
    html = await apiFetch<string>(`/admin/api/print-tasks/${id}/source-html`, { text: true })
  } catch (e) {
    if (e && typeof e === 'object' && (e as { status?: unknown }).status === 404) {
      throw new Error('旧任务没有留档，请手动标记')
    }
    throw e
  }
  return printViaIframe(html)
}

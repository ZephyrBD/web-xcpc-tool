import { afterEach, describe, expect, test } from 'bun:test'
import { confirmOnAfterprint, printPdfTask, printViaIframe } from '@/utils/printPdf'

/** Controllable MediaQueryList stub matching the real browser API surface. */
function makeFakeMql() {
  const listeners: Array<() => void> = []
  const mql: any = {
    matches: false,
    addEventListener(name: string, fn: () => void) {
      if (name === 'change') listeners.push(fn)
    },
    removeEventListener(name: string, fn: () => void) {
      if (name === 'change') {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    // Simulates Chromium flipping the `print` media when the preview opens/closes.
    setMatches(v: boolean) {
      mql.matches = v
      for (const fn of [...listeners]) fn()
    },
  }
  return mql as { matches: boolean; setMatches: (v: boolean) => void }
}

const originalMatchMedia = window.matchMedia
afterEach(() => {
  window.matchMedia = originalMatchMedia
  document.querySelectorAll('iframe').forEach((f) => f.remove())
})

const PRINT_HTML = '<html><body><pre>int main(){}</pre></body></html>'

describe('confirmOnAfterprint', () => {
  test('calls print and resolves true only on the afterprint event', async () => {
    const win = makeFakeWindow()
    const p = confirmOnAfterprint(win)

    expect(win.printCount).toBe(1)
    let resolved: boolean | undefined
    void p.then((v) => {
      resolved = v
    })
    await Promise.resolve()
    expect(resolved).toBeUndefined() // print() alone is not a confirmation

    win.fire('afterprint')
    expect(await p).toBe(true)
  })

  test('confirmation timeout resolves false (unconfirmed → caller must not ack)', async () => {
    const win = makeFakeWindow()
    expect(await confirmOnAfterprint(win, 10)).toBe(false)
    expect(win.printCount).toBe(1)
  })

  test('late afterprint after the timeout does not flip the result to true', async () => {
    const win = makeFakeWindow()
    const p = confirmOnAfterprint(win, 10)
    expect(await p).toBe(false)
    win.fire('afterprint')
    expect(await p).toBe(false)
  })

  test('afterprint on the parent window confirms too (Chromium dispatches there for iframe print)', async () => {
    const frameWin = makeFakeWindow()
    const p = confirmOnAfterprint(frameWin, 50)
    window.dispatchEvent(new Event('afterprint'))
    expect(await p).toBe(true)
  })

  test('a frame window without event methods still confirms via the top window', async () => {
    const frameWin: any = { printCount: 0, print() { frameWin.printCount++ } }
    const p = confirmOnAfterprint(frameWin, 50)
    window.dispatchEvent(new Event('afterprint'))
    expect(await p).toBe(true)
  })

  test('print media open→close transition confirms even without afterprint', async () => {
    const mql = makeFakeMql()
    window.matchMedia = (() => mql) as any
    const win = makeFakeWindow()
    const p = confirmOnAfterprint(win, 50)
    mql.setMatches(true) // preview opened
    await Promise.resolve()
    let resolved: boolean | undefined
    void p.then((v) => { resolved = v })
    await Promise.resolve()
    expect(resolved).toBeUndefined() // open alone is not a confirmation
    mql.setMatches(false) // preview closed = confirmed
    expect(await p).toBe(true)
  })

  test('a close-transition without a prior open is ignored', async () => {
    const mql = makeFakeMql()
    window.matchMedia = (() => mql) as any
    const win = makeFakeWindow()
    const p = confirmOnAfterprint(win, 20)
    mql.setMatches(false) // stale/false without an open — no signal
    expect(await p).toBe(false)
  })

  test('a media transition after the timeout does not flip the result to true', async () => {
    const mql = makeFakeMql()
    window.matchMedia = (() => mql) as any
    const win = makeFakeWindow()
    const p = confirmOnAfterprint(win, 10)
    expect(await p).toBe(false)
    mql.setMatches(true)
    mql.setMatches(false)
    expect(await p).toBe(false)
  })

  test('print() returning synchronously does not remove the iframe before afterprint fires', async () => {
    // Real-browser race: Chromium's print() blocks until the dialog closes,
    // then afterprint dispatches ASYNC. Any cleanup that runs right when
    // print() returns would kill the frame before the event arrives.
    const win = makeFakeWindow()
    const p = confirmOnAfterprint(win)
    await Promise.resolve()
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
    win.fire('afterprint')
    expect(await p).toBe(true)
  })
})

describe('printViaIframe', () => {
  test('writes the html into a hidden iframe document and confirms on afterprint', async () => {
    const p = printViaIframe(PRINT_HTML, 50)
    await new Promise((r) => setTimeout(r, 0))

    const frame = document.querySelector('iframe')
    expect(frame).toBeDefined()
    expect(frame!.getAttribute('aria-hidden')).toBe('true')
    // The html was written into the frame document (document.write mechanics).
    expect(frame!.contentDocument?.body?.textContent).toContain('int main(){}')

    window.dispatchEvent(new Event('afterprint'))
    expect(await p).toBe(true)
    // Cleanup runs after the afterprint grace delay, not synchronously.
    expect(document.querySelector('iframe')).toBeDefined()
    await new Promise((r) => setTimeout(r, 1100))
    expect(document.querySelector('iframe')).toBeNull()
  })

  test('confirmation timeout resolves false (no ack) and the iframe is removed', async () => {
    const p = printViaIframe(PRINT_HTML, 10)
    expect(await p).toBe(false)
    await new Promise((r) => setTimeout(r, 1100))
    expect(document.querySelector('iframe')).toBeNull()
  })
})

describe('printPdfTask (source-html iframe flow)', () => {
  test('fetches the source-html text and prints it via the iframe flow', async () => {
    const calls: Array<{ path: string; opts?: { text?: boolean; blob?: boolean } }> = []
    const apiFetch = (async (path: string, opts?: { text?: boolean; blob?: boolean }) => {
      calls.push({ path, opts })
      return PRINT_HTML
    }) as never
    const p = printPdfTask('p1', apiFetch)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ path: '/admin/api/print-tasks/p1/source-html', opts: { text: true } }])
    const frame = document.querySelector('iframe')
    expect(frame?.contentDocument?.body?.textContent).toContain('int main(){}')
    window.dispatchEvent(new Event('afterprint'))
    expect(await p).toBe(true)
  })

  test('a 404 (legacy task without source archive) throws the friendly archival error', async () => {
    const apiFetch = (async () => {
      throw Object.assign(new Error('API error 404'), { status: 404 })
    }) as never
    await expect(printPdfTask('p-old', apiFetch)).rejects.toThrow('旧任务没有留档，请手动标记')
  })

  test('other fetch errors propagate unchanged', async () => {
    const apiFetch = (async () => {
      throw Object.assign(new Error('API error 500'), { status: 500 })
    }) as never
    await expect(printPdfTask('p1', apiFetch)).rejects.toThrow('API error 500')
  })
})

/** Minimal EventTarget-like window with a document stub and print(). */
function makeFakeWindow(): Window & {
  printCount: number
  fire: (name: string) => void
} {
  const listeners: Record<string, Array<() => void>> = {}
  const win: any = {
    printCount: 0,
    print() {
      win.printCount++
    },
    addEventListener(name: string, fn: () => void) {
      ;(listeners[name] ??= []).push(fn)
    },
    removeEventListener(name: string, fn: () => void) {
      const a = listeners[name]
      if (a) {
        const i = a.indexOf(fn)
        if (i >= 0) a.splice(i, 1)
      }
    },
    fire(name: string) {
      for (const fn of [...(listeners[name] ?? [])]) fn()
    },
  }
  return win
}

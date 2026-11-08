import { afterEach, describe, expect, test } from 'bun:test'
import { confirmOnAfterprint, openPrintPopup, printBlobUrl, printViaPopup } from '@/utils/printPdf'

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
})

/** Minimal EventTarget-like popup window with a document stub and print(). */
function makeFakeWindow(opts: { readyState?: string } = {}): Window & {
  printCount: number
  document: { readyState: string; open: () => void; write: (s: string) => void; close: () => void }
  close: () => void
  closed: () => boolean
  fire: (name: string) => void
} {
  const listeners: Record<string, Array<() => void>> = {}
  const win: any = {
    printCount: 0,
    document: {
      readyState: opts.readyState ?? 'complete',
      open() {},
      write(_html: string) {},
      close() {},
    },
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
  win.close = () => {
    win._closed = true
  }
  win.closed = () => win._closed === true
  return win
}

const originalWindowOpen = window.open
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
afterEach(() => {
  window.open = originalWindowOpen
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

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

  test('print() returning synchronously does not close the popup before afterprint fires', async () => {
    // Real-browser race: Chromium's print() blocks until the dialog closes,
    // then afterprint dispatches ASYNC. Any cleanup that runs right when
    // print() returns would close the popup before the event arrives.
    const popWin = makeFakeWindow()
    const p = confirmOnAfterprint(popWin)
    await Promise.resolve()
    expect(popWin.closed()).toBe(false)
    popWin.fire('afterprint')
    expect(await p).toBe(true)
  })
})

describe('printViaPopup', () => {
  test('waits for the popup load event, then prints on the popup window', async () => {
    // Real-browser contract: a popup loading a PDF is a REAL window context —
    // unlike a hidden iframe's PDF plugin document, its `load` always fires.
    const popWin = makeFakeWindow({ readyState: 'loading' })
    const p = printViaPopup(popWin)
    await Promise.resolve()
    expect(popWin.printCount).toBe(0) // load has not fired yet
    popWin.fire('load')
    expect(popWin.printCount).toBe(1)
    popWin.fire('afterprint')
    expect(await p).toBe(true)
  })

  test('prints immediately when the popup document is already complete', async () => {
    const popWin = makeFakeWindow({ readyState: 'complete' })
    const p = printViaPopup(popWin)
    expect(popWin.printCount).toBe(1)
    popWin.fire('afterprint')
    expect(await p).toBe(true)
  })
})

describe('openPrintPopup', () => {
  test('returns the popup window from window.open', () => {
    const popWin = makeFakeWindow()
    window.open = (() => popWin) as unknown as typeof window.open
    expect(openPrintPopup('blob:x')).toBe(popWin)
  })

  test('a popup blocker (window.open → null) throws the friendly error', () => {
    window.open = (() => null) as unknown as typeof window.open
    expect(() => openPrintPopup()).toThrow('弹窗被拦截，请允许弹窗后重试')
  })
})

describe('printBlobUrl (printPdfTask popup flow)', () => {
  test('opens a popup with the URL, prints, and confirms on the popup afterprint', async () => {
    const popWin = makeFakeWindow({ readyState: 'complete' })
    window.open = (() => popWin) as unknown as typeof window.open
    const p = printBlobUrl('blob:fake')
    expect(popWin.printCount).toBe(1)
    popWin.fire('afterprint')
    expect(await p).toBe(true)
    // Cleanup runs after the afterprint grace delay, not synchronously.
    expect(popWin.closed()).toBe(false)
    await new Promise((r) => setTimeout(r, 1100))
    expect(popWin.closed()).toBe(true)
  })

  test('a blocked popup rejects with the friendly error', async () => {
    window.open = (() => null) as unknown as typeof window.open
    await expect(printBlobUrl('blob:fake')).rejects.toThrow('弹窗被拦截，请允许弹窗后重试')
  })
})

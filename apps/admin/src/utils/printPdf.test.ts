import { afterEach, describe, expect, test } from 'bun:test'
import { confirmOnAfterprint, printViaIframe } from '@/utils/printPdf'

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

/** Minimal EventTarget-like window with a print() method. */
function makeFakeWindow(): Window & { printCount: number; fire: (name: string) => void } {
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

  test('print() returning synchronously does not tear the frame down before afterprint fires', async () => {
    // Real-browser race: Chromium's print() blocks until the dialog closes,
    // then afterprint dispatches ASYNC. Any cleanup that runs right when
    // print() returns would destroy the frame before the event arrives.
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const frameWin: any = makeFakeWindow()
    Object.defineProperty(iframe, 'contentWindow', { value: frameWin })
    const p = printViaIframe(iframe)
    // simulate the load event reaching printViaIframe's handler
    iframe.dispatchEvent(new Event('load'))
    // print() returned, dialog closed, but afterprint has not fired yet —
    // the frame must still be alive so its afterprint can dispatch.
    await Promise.resolve()
    expect(iframe.isConnected).toBe(true)
    frameWin.fire('afterprint')
    expect(await p).toBe(true)
    expect(iframe.isConnected).toBe(true)
    iframe.remove()
  })
})

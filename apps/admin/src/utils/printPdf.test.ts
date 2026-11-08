import { describe, expect, test } from 'bun:test'
import { confirmOnAfterprint } from '@/utils/printPdf'

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
    fire(name: string) {
      for (const fn of listeners[name] ?? []) fn()
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
})

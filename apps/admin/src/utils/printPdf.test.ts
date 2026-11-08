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
  test('calls print and resolves only on the afterprint event', async () => {
    const win = makeFakeWindow()
    let resolved = false
    const p = confirmOnAfterprint(win).then(() => {
      resolved = true
    })

    expect(win.printCount).toBe(1)
    await Promise.resolve()
    expect(resolved).toBe(false) // print() alone is not a confirmation

    win.fire('afterprint')
    await p
    expect(resolved).toBe(true)
  })

  test('no afterprint: stays pending (caller must not ack)', async () => {
    const win = makeFakeWindow()
    let resolved = false
    void confirmOnAfterprint(win).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(win.printCount).toBe(1)
  })
})

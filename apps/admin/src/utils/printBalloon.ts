/**
 * Prints a balloon ticket via a hidden iframe: builds the plain-text ticket
 * HTML from the task and writes it into the iframe document, then triggers
 * the browser print dialog — the same ticket layout as the legacy Java admin
 * UI (vue/src/utils/print.js).
 *
 * Note: browsers may silently ignore iframe.contentWindow.print() when there
 * was no prior user gesture (relevant for SSE auto-print). That's accepted —
 * worst case the balloon runner prints the ticket manually from the jobs list.
 */
import type { BalloonTask } from '@/types'

/** Delay before iframe cleanup so the print dialog has time to read the doc. */
const CLEANUP_DELAY_MS = 60_000

/** Local time as HH:mm; falls back to the raw string for unparseable input. */
export function formatBalloonTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function generateBalloonTicket(task: BalloonTask): string {
  return `
== BALLOON TICKET ==
Problem : ${task.problemLabel}
Team    : ${task.teamName}
Seat    : ${task.location ?? '—'}
Time    : ${formatBalloonTime(task.createdAt)}
== Web XCPC Tool ==
`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

export async function printBalloonTask(task: BalloonTask, _apiFetch?: unknown): Promise<void> {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <style>
      * { margin: 0; padding: 0; }
      pre {
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 14px;
        white-space: pre;
        line-height: 1.4;
        padding: 8px;
      }
    </style>
  </head>
  <body><pre>${escapeHtml(generateBalloonTicket(task))}</pre></body>
</html>`
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px'
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument ?? iframe.contentWindow?.document
  if (!doc) {
    iframe.remove()
    throw new Error('iframe document unavailable')
  }
  doc.open()
  doc.write(html)
  doc.close()
  iframe.addEventListener('load', () => {
    window.setTimeout(() => iframe.contentWindow?.print(), 200)
  })
  window.setTimeout(() => iframe.remove(), CLEANUP_DELAY_MS)
}

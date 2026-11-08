/**
 * Prints a balloon ticket as an HTML document in a hidden iframe: builds the
 * plain-text ticket HTML from the task, writes it into the iframe's document
 * via document.write, and triggers the browser print dialog — the same
 * ticket layout as the legacy Java admin UI (vue/src/utils/print.js). Uses
 * the same iframe flow as source printing (printViaIframe) so the behavior
 * (print dialog, afterprint confirmation, cleanup) is uniform for both task
 * kinds; document.write HTML is the mechanics that actually works in
 * Chromium frames (a PDF plugin document never fires load/print).
 *
 * Note: browsers may silently ignore print() when there was no prior user
 * gesture (relevant for SSE auto-print). That's accepted — worst case the
 * balloon runner prints the ticket manually from the jobs list.
 *
 * The promise resolves on `afterprint` (print confirmed by the browser —
 * see confirmOnAfterprint), which callers use to auto-ack the balloon
 * as delivered.
 */
import { printViaIframe } from '@/utils/printPdf'
import type { BalloonTask } from '@/types'

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

export async function printBalloonTask(task: BalloonTask, _apiFetch?: unknown): Promise<boolean> {
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
  return printViaIframe(html)
}

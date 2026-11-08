/**
 * Prints a balloon ticket via a popup window: builds the plain-text ticket
 * HTML from the task, writes it into the popup's document, and triggers the
 * browser print dialog — the same ticket layout as the legacy Java admin
 * UI (vue/src/utils/print.js). Uses the same popup flow as PDF printing so
 * the behavior (print dialog, afterprint confirmation, popup handling) is
 * uniform for both task kinds.
 *
 * Note: browsers may silently ignore print() when there was no prior user
 * gesture (relevant for SSE auto-print). That's accepted — worst case the
 * balloon runner prints the ticket manually from the jobs list.
 *
 * The promise resolves on `afterprint` (print confirmed by the browser —
 * see confirmOnAfterprint), which callers use to auto-ack the balloon
 * as delivered.
 */
import { openPrintPopup, printViaPopup } from '@/utils/printPdf'
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
  const popWin = openPrintPopup()
  try {
    popWin.document.open()
    popWin.document.write(html)
    popWin.document.close()
    // Resolves true only on `afterprint` (browser confirmed the print job;
    // Firefox also fires it when the dialog is cancelled) — callers may
    // auto-ack the delivery. False on the confirmation timeout: no ack.
    return await printViaPopup(popWin)
  } finally {
    window.setTimeout(() => {
      try {
        popWin.close()
      } catch {
        // the popup may already be gone; nothing to clean up
      }
    }, 1_000)
  }
}

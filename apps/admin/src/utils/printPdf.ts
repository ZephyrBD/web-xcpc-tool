/**
 * Fetches a print task's PDF with the admin auth header (an iframe cannot set
 * Authorization headers, so a plain URL won't do), loads it into a hidden
 * iframe via an object URL, and triggers the browser print dialog — the same
 * approach as the legacy Java admin UI. The object URL is revoked afterwards.
 *
 * Note: browsers may silently ignore iframe.contentWindow.print() when there
 * was no prior user gesture (relevant for SSE auto-print). That's accepted —
 * worst case the admin prints the task manually from the jobs list.
 */
export type PdfApiFetch = <T>(path: string, opts?: { blob?: boolean }) => Promise<T>

/** Delay before cleanup so the print dialog has time to read the object URL. */
const CLEANUP_DELAY_MS = 60_000

export async function printPdfTask(id: string, apiFetch: PdfApiFetch): Promise<void> {
  const blob = await apiFetch<Blob>(`/admin/api/print-tasks/${id}/pdf`, { blob: true })
  const url = URL.createObjectURL(blob)
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = url
  iframe.addEventListener('load', () => iframe.contentWindow?.print())
  document.body.appendChild(iframe)
  window.setTimeout(() => {
    iframe.remove()
    URL.revokeObjectURL(url)
  }, CLEANUP_DELAY_MS)
}

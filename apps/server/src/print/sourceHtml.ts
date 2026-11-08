import { formatCode } from "./format";
import type { PrintTask } from "./queue";

/**
 * Print HTML for a print task's archived source. Printed via document.write
 * into a hidden iframe (Chromium's built-in PDF viewer plugin inside an
 * iframe never fires load/print — an HTML document does). The header and
 * footer are position:fixed so every printed page repeats them; per-page
 * "Page X" numbers are impossible there without JS, so they are dropped
 * (controller ruling).
 */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/** yyyy-MM-dd HH:mm:ss in the server's local time, like the legacy Java print header. */
function formatHeaderTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function buildSourceHtml(task: PrintTask, rawSource: string): string {
  const ext = task.originalFilename.includes(".")
    ? task.originalFilename.slice(task.originalFilename.lastIndexOf(".") + 1)
    : "";
  const formatted = formatCode(rawSource, ext);
  const header = `[${task.location}] ${task.teamName} (${task.teamId}) | ${formatHeaderTime(task.createdAt)}`;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <style>
      @page { size: A4; margin: 15mm; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: "Maple Mono NF CN", "Cascadia Mono", Consolas, monospace;
        font-size: 10pt;
        padding: 8mm 0;
      }
      .print-header {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        font-size: 9pt;
        border-bottom: 1px solid #999;
        padding-bottom: 2mm;
      }
      .print-footer {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 9pt;
        color: #666;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-all;
        line-height: 1.4;
      }
    </style>
  </head>
  <body>
    <div class="print-header">${escapeHtml(header)}</div>
    <pre>${escapeHtml(formatted)}</pre>
    <div class="print-footer">--- Web XCPC Tool ---</div>
  </body>
</html>`;
}

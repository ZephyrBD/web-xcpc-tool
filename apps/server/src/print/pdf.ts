/**
 * Code-to-PDF printing: A4 page, bundled Maple Mono NF CN font, and a
 * two-line per-page header replicated from the legacy Java PdfUtil:
 *   [位置] 队名 (队伍ID) | yyyy-MM-dd HH:mm:ss
 *   -- Page X of N -------------------------------------------Web XCPC Tool--
 *
 * The font is Maple Mono (https://github.com/subframe7536/maple-font),
 * licensed under the SIL Open Font License 1.1.
 */
import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FONT_PATH = join(import.meta.dir, "..", "..", "assets", "fonts", "MapleMono-NF-CN-Regular.ttf");

const PAGE_WIDTH = 595.28; // A4
const MARGIN = 72;
// Header line 1 sits 13pt above the divider line, matching the legacy layout.
const HEADER_LINE1_Y = MARGIN - 26;
const HEADER_LINE2_Y = MARGIN - 13;
const BODY_TOP = MARGIN + 13;
const BODY_LEADING_GAP = 2; // 10pt font + 2pt gap = 12pt leading

export type CodePdfHeader = {
  location: string;
  teamName: string;
  teamId: string;
};

function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export async function generateCodePdf(code: string, header: CodePdfHeader): Promise<{ buffer: Buffer; pages: number }> {
  const fontData = readFileSync(FONT_PATH);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: BODY_TOP, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });

  doc.registerFont("MapleMono", fontData);
  doc.font("MapleMono").fontSize(10);
  if (code.trim() !== "") {
    doc.text(code, MARGIN, BODY_TOP, { width: PAGE_WIDTH - MARGIN * 2, lineGap: BODY_LEADING_GAP });
  }

  // Headers are drawn last (buffered pages let us revisit every page), so the
  // total page count is known by the time the divider line is rendered.
  const range = doc.bufferedPageRange();
  doc.font("MapleMono").fontSize(11);
  const line1 = `[${header.location}] ${header.teamName} (${header.teamId}) | ${localTimestamp()}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.text(line1, MARGIN, HEADER_LINE1_Y, { lineBreak: false });
    doc.text(
      `-- Page ${i + 1} of ${range.count} -------------------------------------------Web XCPC Tool--`,
      MARGIN,
      HEADER_LINE2_Y,
      { lineBreak: false },
    );
  }

  const pages = range.count;
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  doc.end();
  const buffer = await done;
  return { buffer, pages };
}

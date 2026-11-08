import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import type { Config } from "../config";
import { PrintQueue } from "./queue";
import { formatCode } from "./format";
import { generateCodePdf } from "./pdf";

export async function handlePrintCallback(c: Context, cfg: Config, queue: PrintQueue, dataDir: string): Promise<Response> {
  const token = c.req.header("org.domjudge.print-token");
  if (!token || token !== cfg.print.token) {
    return c.json({ error: "invalid print token" }, 403);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "missing file" }, 400);
  }

  const raw = Buffer.from(await file.arrayBuffer());
  let pdf: Buffer;
  if (raw.subarray(0, 5).toString("ascii") === "%PDF-") {
    // Already a PDF (e.g. a client that prints to PDF itself): store as-is.
    pdf = raw;
  } else {
    // DOMjudge's print_command delivers the ORIGINAL source file with [file];
    // code-to-PDF formatting is our job. Formatting follows the `original`
    // filename extension, like the legacy Java DjPrintController.
    const original = String(form.get("original") ?? "") || file.name || "";
    const ext = original.includes(".") ? original.slice(original.lastIndexOf(".") + 1) : "";
    const formatted = formatCode(raw.toString("utf8"), ext);
    ({ buffer: pdf } = await generateCodePdf(formatted, {
      location: String(form.get("location") ?? ""),
      teamName: String(form.get("teamname") ?? ""),
      teamId: String(form.get("teamid") ?? ""),
    }));
  }

  const pdfDir = join(dataDir, "pdf");
  mkdirSync(pdfDir, { recursive: true });
  const id = crypto.randomUUID();
  const pdfPath = join(pdfDir, `${id}.pdf`);
  writeFileSync(pdfPath, pdf);

  const task = queue.add({
    location: String(form.get("location") ?? ""),
    teamName: String(form.get("teamname") ?? ""),
    teamId: String(form.get("teamid") ?? ""),
    originalFilename: file.name || String(form.get("original") ?? ""),
    pdfPath,
  });
  return c.json(task);
}

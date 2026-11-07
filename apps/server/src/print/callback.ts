import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import type { Config } from "../config";
import { PrintQueue } from "./queue";

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

  const pdfDir = join(dataDir, "pdf");
  mkdirSync(pdfDir, { recursive: true });
  const id = crypto.randomUUID();
  const pdfPath = join(pdfDir, `${id}.pdf`);
  writeFileSync(pdfPath, Buffer.from(await file.arrayBuffer()));

  const task = queue.add({
    location: String(form.get("location") ?? ""),
    teamName: String(form.get("teamname") ?? ""),
    teamId: String(form.get("teamid") ?? ""),
    originalFilename: file.name || String(form.get("original") ?? ""),
    pdfPath,
  });
  return c.json(task);
}

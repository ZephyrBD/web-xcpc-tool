import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "./config";
import { FingerprintCapture } from "./oms/capture";
import type { ClientFingerprint } from "./oms/identify";
import { identifyClient } from "./oms/identify";

export type Deps = {
  dataDir: string;
};

const CAPTURE_FILE = "fingerprints.jsonl";
const STATIC_DIR = join(import.meta.dir, "..", "static");

export function createApp(cfg: Config, deps?: Partial<Deps>): Hono {
  const dataDir = deps?.dataDir ?? "data";
  const app = new Hono();

  let capture: FingerprintCapture | null = null;
  if (cfg.oms.capture) {
    mkdirSync(dataDir, { recursive: true });
    capture = new FingerprintCapture(join(dataDir, CAPTURE_FILE));
  }

  app.use("*", async (c, next) => {
    if (capture) {
      const headers: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers.entries()) {
        headers[k] = v;
      }
      const fp: ClientFingerprint = {
        ip: "unknown",
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        headers,
      };
      capture.record(fp);
      identifyClient(fp, cfg.oms);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  if (existsSync(STATIC_DIR)) {
    app.get("*", (c) => {
      const rel = new URL(c.req.url).pathname.replace(/^\/+/, "");
      const filePath = join(STATIC_DIR, rel);
      const resolved =
        rel !== "" && filePath.startsWith(STATIC_DIR) && existsSync(filePath)
          ? filePath
          : join(STATIC_DIR, "index.html");
      if (!existsSync(resolved)) {
        return c.notFound();
      }
      return new Response(readFileSync(resolved));
    });
  }

  return app;
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "./config";
import { AuthQueue, type AuthTask } from "./queue/authQueue";
import { FingerprintCapture } from "./oms/capture";
import type { ClientFingerprint } from "./oms/identify";
import { identifyClient } from "./oms/identify";
import { SseBus } from "./sse/bus";
import { verifyClient } from "./domjudge/verify";
import { handleDjProxy } from "./domjudge/proxy";
import { PrintQueue } from "./print/queue";
import { handlePrintCallback } from "./print/callback";
import type { BalloonService } from "./balloon/service";

export type Deps = {
  dataDir: string;
  authQueue: AuthQueue;
  printQueue: PrintQueue;
  bus: SseBus;
  balloonService?: BalloonService;
  /** Bun's Server is structurally compatible with this shape. */
  server?: { requestIP(req: Request): { address: string } | null };
};

const CAPTURE_FILE = "fingerprints.jsonl";
const STATIC_DIR = join(import.meta.dir, "..", "static");

export function createApp(cfg: Config, deps?: Partial<Deps>): Hono {
  const dataDir = deps?.dataDir ?? "data";
  const app = new Hono();

  const queue = deps?.authQueue ?? new AuthQueue(join(dataDir, "auth-tasks.json"));
  const bus = deps?.bus ?? new SseBus();
  queue.onChange((t: AuthTask) => bus.publish("admin", "auth-task", t));

  const printQueue = deps?.printQueue ?? new PrintQueue(join(dataDir, "print-tasks.json"));
  printQueue.onChange((t) => bus.publish("admin", "print-task", t));

  let capture: FingerprintCapture | null = null;
  if (cfg.oms.capture) {
    mkdirSync(dataDir, { recursive: true });
    capture = new FingerprintCapture(join(dataDir, CAPTURE_FILE));
  }

  app.use("*", async (c, next) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) {
      headers[k] = v;
    }
    const fp: ClientFingerprint = {
      ip: deps?.server?.requestIP(c.req.raw)?.address ?? "unknown",
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      headers,
    };
    if (capture) {
      capture.record(fp);
    }
    const result = identifyClient(fp, cfg.oms);
    if (result && deps?.authQueue) {
      // Plan 2 binds the real examNum; "unknown" is a placeholder until then.
      deps.authQueue.enqueue({
        examNum: "unknown",
        clientId: c.req.raw.headers.get("x-oms-client-id"),
        strategy: result.strategy,
      });
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/dj/verify", async (c) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) {
      headers[k] = v;
    }
    const fp: ClientFingerprint = {
      ip: deps?.server?.requestIP(c.req.raw)?.address ?? "unknown",
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      headers,
    };
    const result = await verifyClient(
      fp,
      c.req.query("examNum") ?? "",
      queue.list(),
      cfg,
    );
    if (!result.ok) {
      return c.json(result, 403);
    }
    c.header(
      "Set-Cookie",
      `cxtool-token=${result.token}; Path=/dj; HttpOnly; SameSite=Lax`,
    );
    return c.redirect(`${cfg.domjudge.baseUrl}/dj/`, 302);
  });

  // Print callback must be registered BEFORE the /dj/* catch-all proxy.
  app.post("/dj/print", (c) => handlePrintCallback(c, cfg, printQueue, dataDir));

  // Catch-all proxy must be registered AFTER /dj/verify so verify is not shadowed.
  app.all("/dj/*", (c) => handleDjProxy(c, cfg));

  app.get("/admin/api/print-tasks", (c) => {
    const status = c.req.query("status");
    const valid = ["pending", "printed", "failed"] as const;
    return c.json(printQueue.list(valid.includes(status as never) ? (status as never) : undefined));
  });

  app.post("/admin/api/print-tasks/:id/ack", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const status = body?.status === "failed" ? "failed" : "printed";
    const t = printQueue.ack(c.req.param("id"), status);
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  });

  app.get("/admin/api/auth-tasks", (c) => {
    const status = c.req.query("status");
    const valid = ["pending", "approved", "rejected", "auto-done"] as const;
    return c.json(queue.list(valid.includes(status as never) ? (status as never) : undefined));
  });

  app.post("/admin/api/auth-tasks/:id/approve", (c) => {
    const t = queue.approve(c.req.param("id"));
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  });

  app.post("/admin/api/auth-tasks/:id/reject", (c) => {
    const t = queue.reject(c.req.param("id"));
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  });

  app.get("/admin/api/balloon-tasks", (c) => {
    const svc = deps?.balloonService;
    if (!svc) return c.json({ error: "balloon service unavailable" }, 503);
    const status = c.req.query("status");
    const valid = ["pending", "delivered"] as const;
    return c.json(svc.list(valid.includes(status as never) ? (status as never) : undefined));
  });

  app.post("/admin/api/balloon-tasks/:id/ack", (c) => {
    const svc = deps?.balloonService;
    if (!svc) return c.json({ error: "balloon service unavailable" }, 503);
    const t = svc.ack(c.req.param("id"));
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  });

  app.get("/admin/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe("admin", (e) => {
        void stream.writeSSE({
          event: e.event,
          data: JSON.stringify(e.data),
        });
      });
      c.req.raw.signal.addEventListener("abort", unsub);
      // keep the stream open until the client disconnects
      while (true) {
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        await stream.sleep(15_000);
      }
    });
  });

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

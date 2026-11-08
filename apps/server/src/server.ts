import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
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
import { DjClient, type DjTeam } from "./domjudge/client";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { JsonStore } from "./store/store";
import { TeamStore } from "./store/teams";
import { importTeamsFromExcel, syncTeamsFromDomjudge } from "./teams/import";
import { createAdminLoginHandler, requireAdmin } from "./admin/auth";
import { appPath } from "./domjudge/proxy";

export type Deps = {
  dataDir: string;
  authQueue: AuthQueue;
  printQueue: PrintQueue;
  bus: SseBus;
  balloonService?: BalloonService;
  teamStore?: TeamStore;
  teamsStore?: JsonStore<DjTeam[]>;
  djClient?: DjClient;
  /** Bun's Server is structurally compatible with this shape. */
  server?: { requestIP(req: Request): { address: string } | null };
  /** Admin frontend build output directory. Defaults to apps/server/static. */
  staticDir?: string;
};

const CAPTURE_FILE = "fingerprints.jsonl";
const DEFAULT_STATIC_DIR = join(import.meta.dir, "..", "static");

export function createApp(cfg: Config, deps?: Partial<Deps>): Hono {
  const dataDir = deps?.dataDir ?? "data";
  const staticDir = resolve(deps?.staticDir ?? DEFAULT_STATIC_DIR);
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

  const djRoot = `${cfg.contextPath.replace(/\/+$/, "")}/dj`;

  app.get("/dj/verify", async (c) => {    const headers: Record<string, string> = {};
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
      `cxtool-token=${result.token}; Path=${djRoot}; HttpOnly; SameSite=Lax`,
    );
    return c.redirect(`${djRoot}/`, 302);
  });

  // Print callback must be registered BEFORE the /dj/* catch-all proxy.
  app.post("/dj/print", (c) => handlePrintCallback(c, cfg, printQueue, dataDir));

  // Catch-all proxy must be registered AFTER /dj/verify so verify is not shadowed.
  app.all("/dj/*", (c) => handleDjProxy(c, cfg));

  // Admin login is registered before the /admin/api/* middleware, which skips it explicitly.
  app.post("/admin/api/login", createAdminLoginHandler(cfg, deps));
  app.use("/admin/api/*", requireAdmin(cfg));

  app.get("/admin/api/print-tasks", (c) => {
    const status = c.req.query("status");
    const valid = ["pending", "printed", "failed"] as const;
    // pdfPath is server-local; never expose it to the admin UI.
    return c.json(
      printQueue.list(valid.includes(status as never) ? (status as never) : undefined).map(({ pdfPath: _p, ...t }) => t),
    );
  });

  app.post("/admin/api/print-tasks/:id/ack", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const status = body?.status === "failed" ? "failed" : "printed";
    const t = printQueue.ack(c.req.param("id"), status);
    if (!t) return c.json({ error: "task not found" }, 404);
    const { pdfPath: _p, ...safe } = t;
    return c.json(safe);
  });

  // PDF for the admin browser to print (hidden-iframe flow, like the legacy
  // Java version). pdfPath is server-internal, so it is re-validated here.
  app.get("/admin/api/print-tasks/:id/pdf", (c) => {
    const t = printQueue.list().find((x) => x.id === c.req.param("id"));
    if (!t) return c.json({ error: "task not found" }, 404);
    const pdfDir = resolve(join(dataDir, "pdf"));
    const filePath = resolve(t.pdfPath);
    if (filePath !== pdfDir && !filePath.startsWith(pdfDir + sep)) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return c.json({ error: "pdf not found" }, 404);
    }
    const filename = t.originalFilename.replace(/[^\w.\-]+/g, "_") || "print.pdf";
    return new Response(readFileSync(filePath), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${filename}"`,
      },
    });
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

  app.get("/admin/api/teams", (c) => {
    const teamsStore =
      deps?.teamsStore ?? new JsonStore<DjTeam[]>(join(dataDir, "teams.json"), []);
    // Passwords live in a separate store; this response must never contain them.
    return c.json(teamsStore.load());
  });

  app.post("/admin/api/teams/sync", async (c) => {
    const client = deps?.djClient;
    if (!client) return c.json({ error: "domjudge client unavailable" }, 503);
    const body = await c.req.json().catch(() => ({}));
    const contestId = body?.contestId;
    if (!contestId || typeof contestId !== "string") {
      return c.json({ error: "contestId required" }, 400);
    }
    const teamsStore =
      deps?.teamsStore ?? new JsonStore<DjTeam[]>(join(dataDir, "teams.json"), []);
    try {
      const count = await syncTeamsFromDomjudge(client, contestId, teamsStore);
      let problemsMapped = true;
      if (deps?.balloonService) {
        let problems: Awaited<ReturnType<typeof client.getProblems>>;
        try {
          problems = await client.getProblems(contestId);
        } catch (err) {
          // A silent failure here leaves balloon tasks with raw problem ids as
          // labels; the response must tell the operator mapping did not happen.
          problemsMapped = false;
          console.error(
            `team sync: could not fetch problems for contest ${contestId}, balloon tasks will fall back to raw ids:`,
            err instanceof Error ? err.message : err,
          );
          problems = [];
        }
        deps.balloonService.refresh(teamsStore.load(), problems);
      }
      return c.json({ count, problemsMapped });
    } catch {
      return c.json({ error: "domjudge sync failed" }, 502);
    }
  });

  app.post("/admin/api/teams/import-excel", async (c) => {
    const teamStore =
      deps?.teamStore ??
      new TeamStore(join(dataDir, "team-passwords.json"), new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))));
    const teamsStore =
      deps?.teamsStore ?? new JsonStore<DjTeam[]>(join(dataDir, "teams.json"), []);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field required" }, 400);
    const buffer = Buffer.from(await file.arrayBuffer());
    let result;
    try {
      result = await importTeamsFromExcel(buffer, teamsStore.load(), teamStore);
    } catch {
      return c.json({ ok: false, reason: "invalid excel file" }, 400);
    }
    return c.json(result);
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

  if (existsSync(staticDir)) {
    const MIME: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".json": "application/json",
      ".woff2": "font/woff2",
    };
    const indexHtml = join(staticDir, "index.html");
    const safeDecode = (value: string): string | null => {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    };
    const serveFile = (filePath: string): Response | null => {
      const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      try {
        return new Response(readFileSync(filePath), {
          headers: { "content-type": type, "cache-control": filePath === indexHtml ? "no-cache" : "public, max-age=3600" },
        });
      } catch {
        return null;
      }
    };

    app.get("*", (c) => {
      // Validate the decoded form (URL-encoded traversal like %2e%2e must not
      // survive decoding into a ".." segment); also reject raw suspicious
      // sequences in case decoding already happened upstream.
      const raw = appPath(c, cfg);
      if (/(^|\/)\.\.?(\/|$)/.test(raw) || /%2e|%2f|%5c/i.test(raw)) {
        return c.json({ ok: false, reason: "forbidden" }, 403);
      }
      const decodedPath = raw === "/" ? "" : safeDecode(raw);
      if (decodedPath === null) return c.json({ ok: false, reason: "forbidden" }, 403);
      const rel = decodedPath.replace(/^\/+/, "");
      if (!rel) {
        return serveFile(indexHtml) ?? c.notFound();
      }
      const decoded = safeDecode(rel);
      if (decoded === null) return c.json({ ok: false, reason: "forbidden" }, 403);
      const filePath = resolve(join(staticDir, decoded));
      if (filePath !== staticDir && !filePath.startsWith(staticDir + sep)) {
        return c.json({ ok: false, reason: "forbidden" }, 403);
      }
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return serveFile(filePath) ?? c.notFound();
      }
      // SPA fallback: only GET misses outside API surfaces reach here.
      return serveFile(indexHtml) ?? c.notFound();
    });
  }

  return app;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "./config";
import { SseBus } from "./sse/bus";
import { verifyTeamCode } from "./domjudge/verify";
import { handleDjProxy } from "./domjudge/proxy";
import { PrintQueue } from "./print/queue";
import { handlePrintCallback } from "./print/callback";
import { buildSourceHtml } from "./print/sourceHtml";
import type { BalloonService } from "./balloon/service";
import { DjClient, teamAccountKey, type DjTeam, type DjUser } from "./domjudge/client";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { JsonStore } from "./store/store";
import { TeamStore } from "./store/teams";
import { importTeamsFromExcel, syncTeamsFromDomjudge } from "./teams/import";
import { createAdminLoginHandler, requireAdmin } from "./admin/auth";
import { LoginHistoryStore } from "./admin/loginHistory";
import { randomInt } from "node:crypto";import { applySettingsPatch, safeSettingsView, settingsPathFor, settingsPatchSchema } from "./admin/settings";
import { appPath } from "./domjudge/proxy";
import { verifyFormPage, verifyMissPage, verifyWaitingPage, verifyClaimDeniedPage } from "./pages/teamPages";
import { signTeamToken } from "./auth/token";
import { LoginRequestStore } from "./auth/loginRequests";
import { ConfigStore } from "./store/configStore";

export type Deps = {
  dataDir: string;
  printQueue: PrintQueue;
  bus: SseBus;
  balloonService?: BalloonService;
  teamStore?: TeamStore;
  teamsStore?: JsonStore<DjTeam[]>;
  djClient?: DjClient;
  /** Bun's Server is structurally compatible with this shape (admin rate-limit IP lookup). */
  server?: { requestIP(req: Request): { address: string } | null };
  /** Login history store. Defaults to <dataDir>/login-history.json with a 2000-entry cap. */
  loginHistory?: LoginHistoryStore;
  /** Approval requests for logins outside the window. Defaults to <dataDir>/login-requests.json. */
  loginRequests?: LoginRequestStore;
  /** Admin frontend build output directory. Defaults to apps/server/static. */
  staticDir?: string;
};

/**
 * Static dir resolution order:
 * 1. deps.staticDir (programmatic override)
 * 2. env WXT_STATIC_DIR
 * 3. ../static relative to this module (dev: apps/server/static)
 * 4. ./static relative to the process cwd (compiled binary run from package root)
 * The first candidate that exists on disk wins; the last one is the fallback
 * so the app still boots (without SPA hosting) on a bare checkout.
 */
export function resolveStaticDir(opts?: {
  envDir?: string;
  moduleStaticDir?: string;
  cwdStaticDir?: string;
}): string {
  const moduleDir = opts?.moduleStaticDir ?? join(import.meta.dir, "..", "static");
  const cwdDir = opts?.cwdStaticDir ?? join(process.cwd(), "static");
  const candidates = [opts?.envDir ?? process.env.WXT_STATIC_DIR, moduleDir, cwdDir];
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return resolve(dir);
  }
  return resolve(cwdDir);
}

/**
 * `cfg` may be a plain Config (tests, scripts: frozen for the app's lifetime)
 * or a ConfigStore, whose `current` is re-read on every request so admin
 * settings edits apply without a restart. Pass a ConfigStore to enable hot
 * reload — a plain Config is wrapped once and never replaced.
 */
export function createApp(config: Config | ConfigStore, deps?: Partial<Deps>): Hono {
  const configStore = config instanceof ConfigStore ? config : new ConfigStore(config);
  // Always the live values: contextPath/baseUrl/teamLogin/jwt.secret may all
  // change at runtime, so nothing derived from it is hoisted out of a handler.
  const cfg = (): Config => configStore.current;
  // Absolute, matching index.ts: everything derived here is joined onto it, so
  // a relative default would let JsonStore join a second time (data/data/).
  const dataDir = resolve(deps?.dataDir ?? "data");
  const staticDir = deps?.staticDir ? resolve(deps.staticDir) : resolveStaticDir();
  const app = new Hono();

  const bus = deps?.bus ?? new SseBus();

  const printQueue = deps?.printQueue ?? new PrintQueue(join(dataDir, "print-tasks.json"));
  printQueue.onChange((t) => bus.publish("admin", "print-task", t));

  const teamStore =
    deps?.teamStore ??
    new TeamStore(join(dataDir, "team-passwords.json"), new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))));

  const teamsStore = deps?.teamsStore ?? new JsonStore<DjTeam[]>(join(dataDir, "teams.json"), []);
  const loginHistory = deps?.loginHistory ?? new LoginHistoryStore(join(dataDir, "login-history.json"));
  const loginRequests = deps?.loginRequests ?? new LoginRequestStore(join(dataDir, "login-requests.json"));

  app.get("/health", (c) => c.json({ ok: true }));

  /** Root path for DOMjudge routes under the *current* contextPath. */
  const djRoot = (): string => `${cfg().contextPath.replace(/\/+$/, "")}/dj`;

  /**
   * A `next` target is honored only as an absolute-path relative URL:
   * a single leading slash, no protocol-relative "//" and no backslash
   * (open-redirect guard).
   */
  const safeNext = (raw: string | undefined): string | null =>
    raw !== undefined &&
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    !raw.includes("\\") &&
    !/[\r\n]/.test(raw)
      ? raw
      : null;

  app.get("/dj/verify", async (c) => {
    const raw = c.req.query("code");
    const next = safeNext(c.req.query("next"));
    // No code in the URL → the team types it on the form page.
    if (raw === undefined || raw.trim() === "") {
      const hint = raw !== undefined ? "队伍码不能为空" : undefined;
      return verifyFormPage(cfg().contextPath, hint, next, cfg().teamLogin);
    }
    const result = await verifyTeamCode(raw.trim(), teamStore, cfg(), new Date(), loginRequests, {
      ip: deps?.server?.requestIP(c.req.raw)?.address ?? null,
      teamNameOf: (icpcId) => {
        const team = teamsStore.load().find((t) => teamAccountKey(t) === icpcId);
        return team?.display_name?.trim() || team?.name || icpcId;
      },
      // Live admin nudge: the admin page refreshes from this SSE event (debounced)
      // and from the manual 刷新 button — there is no polling loop.
      onRequestCreated: (request) => bus.publish("admin", "login-request", request),
    });
    if (!result.ok) {
      // Team-facing paths always answer humans with HTML (Accept-agnostic);
      // HTTP status codes keep their semantics (403 on both failures).
      if (result.reason === "waiting") {
        return verifyWaitingPage(cfg().contextPath, result.request.id, next);
      }
      // With the approval flow wired, a closed window has already looked the
      // code up: not-found lands here and shows the (unchanged) miss page,
      // while a found code took the waiting branch above.
      return verifyMissPage();
    }
    // Successful team-code logins are recorded (only who/when/from-where).
    const matched = teamStore.findByTeamCode(raw.trim());
    loginHistory.append({
      icpcId: matched?.icpcId ?? "",
      teamCode: matched?.teamCode ?? raw.trim(),
      at: new Date().toISOString(),
      ip: deps?.server?.requestIP(c.req.raw)?.address ?? null,
    });
    // Path=/ covers both the /dj/* proxy and the root DOMjudge proxy.
    c.header(
      "Set-Cookie",
      `cxtool-token=${result.token}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return c.redirect(next ?? `${djRoot()}/`, 302);
  });

  // Waiting page for an existing approval request (shared link / manual revisit).
  app.get("/dj/verify/wait", (c) => {
    const id = c.req.query("req") ?? "";
    if (!loginRequests.get(id)) {
      return verifyFormPage(cfg().contextPath, "登录请求不存在或已过期，请重新输入队伍码", null, cfg().teamLogin);
    }
    return verifyWaitingPage(cfg().contextPath, id, safeNext(c.req.query("next")));
  });

  // Polled by the waiting page's inline JS; id is a server-issued uuid.
  app.get("/dj/verify/status", (c) => {
    const req = loginRequests.get(c.req.query("req") ?? "");
    if (!req) return c.json({ error: "login request not found" }, 404);
    return c.json({ status: req.status });
  });

  // Approval is valid ONCE: consume turns approved → claimed, so a replayed
  // claim link (or a pending/rejected request) always lands on the 403 page.
  app.get("/dj/verify/claim", async (c) => {
    const next = safeNext(c.req.query("next"));
    const consumed = loginRequests.consume(c.req.query("req") ?? "");
    if (!consumed) return verifyClaimDeniedPage();
    const token = await signTeamToken(cfg().jwt.secret, cfg().jwt.ttlSeconds, consumed.icpcId);
    loginHistory.append({
      icpcId: consumed.icpcId,
      teamCode: consumed.teamCode,
      at: new Date().toISOString(),
      ip: consumed.ip ?? deps?.server?.requestIP(c.req.raw)?.address ?? null,
    });
    // Path=/ covers both the /dj/* proxy and the root DOMjudge proxy.
    c.header("Set-Cookie", `cxtool-token=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return c.redirect(next ?? `${djRoot()}/`, 302);
  });

  // Print callback must be registered BEFORE the /dj/* catch-all proxy.
  app.post("/dj/print", (c) => handlePrintCallback(c, cfg(), printQueue, dataDir));

  // Catch-all proxy must be registered AFTER /dj/verify so verify is not shadowed.
  // The config is read once per request: ConfigStore may swap it mid-flight,
  // and a half-old/half-new snapshot would mix e.g. two contextPaths.
  app.all("/dj/*", (c) => handleDjProxy(c, cfg(), teamStore));

  // Admin login is registered before the /admin/api/* middleware, which skips it explicitly.
  // Both read the live config per request (auth/contextPath can change).
  app.post("/admin/api/login", createAdminLoginHandler(cfg, deps));
  app.use("/admin/api/*", requireAdmin(cfg));

  app.get("/admin/api/print-tasks", (c) => {
    const status = c.req.query("status");
    const valid = ["pending", "printed", "failed"] as const;
    // pdfPath/sourcePath are server-local; never expose them to the admin UI.
    return c.json(
      printQueue.list(valid.includes(status as never) ? (status as never) : undefined).map(({ pdfPath: _p, sourcePath: _s, ...t }) => t),
    );
  });

  app.post("/admin/api/print-tasks/:id/ack", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const status = body?.status === "failed" ? "failed" : "printed";
    const t = printQueue.ack(c.req.param("id"), status);
    if (!t) return c.json({ error: "task not found" }, 404);
    const { pdfPath: _p, sourcePath: _s, ...safe } = t;
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

  // Print-ready HTML for the archived source (hidden-iframe flow — Chromium's
  // iframe PDF viewer plugin never fires load/print, an HTML document does).
  // sourcePath is server-internal, re-validated here like pdfPath.
  app.get("/admin/api/print-tasks/:id/source-html", (c) => {
    const t = printQueue.list().find((x) => x.id === c.req.param("id"));
    if (!t) return c.json({ error: "task not found" }, 404);
    if (!t.sourcePath) return c.json({ error: "source not archived" }, 404);
    const printedDir = resolve(join(dataDir, "printed"));
    const filePath = resolve(t.sourcePath);
    if (filePath !== printedDir && !filePath.startsWith(printedDir + sep)) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return c.json({ error: "source not found" }, 404);
    }
    return new Response(buildSourceHtml(t, readFileSync(filePath, "utf8")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  app.get("/admin/api/balloon-tasks", (c) => {
    const svc = deps?.balloonService;
    if (!svc) return c.json({ error: "balloon service unavailable" }, 503);
    const status = c.req.query("status");
    const valid = ["pending", "delivered"] as const;
    return c.json(svc.list(valid.includes(status as never) ? (status as never) : undefined));
  });

  app.post("/admin/api/balloon-tasks/:id/ack", async (c) => {
    const svc = deps?.balloonService;
    if (!svc) return c.json({ error: "balloon service unavailable" }, 503);
    const t = await svc.ack(c.req.param("id"));
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  });

  app.get("/admin/api/teams", (c) => {
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

  app.get("/admin/api/settings", (c) => {
    return c.json(safeSettingsView(cfg()));
  });

  app.put("/admin/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = settingsPatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "配置格式不正确，请检查各字段后重试" }, 400);
    }
    const newPassword = parsed.data.admin?.password;
    // Empty string means "leave unchanged"; only a non-empty blank value is invalid.
    if (newPassword !== undefined && newPassword !== "" && newPassword.trim() === "") {
      return c.json({ error: "密码不能是空白字符，请输入至少 6 个非空白字符" }, 400);
    }
    let updated: Config;
    try {
      updated = applySettingsPatch(cfg(), parsed.data, settingsPathFor(dataDir));
    } catch (err) {
      console.error("settings update failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "保存失败，请稍后重试" }, 500);
    }
    // Hot reload: the file is already written above, so a failing listener must
    // never turn a successful save into an error response (ConfigStore logs it).
    configStore.replace(updated);
    // Password fields are write-only and never echoed back.
    return c.json({ ...safeSettingsView(updated), note: "已保存，立即生效" });
  });

  /** Teams joined with their login codes. Only teams holding a code are listed;
   *  the rest are summarized so the UI can keep the 已发 X / Y counter meaningful. */
  app.get("/admin/api/team-codes", (c) => {
    const all = teamsStore.load().map((t) => {
      const icpcId = teamAccountKey(t);
      return {
        icpcId,
        name: t.display_name?.trim() || t.name,
        teamCode: teamStore.getTeamCode(icpcId),
        hasPassword: teamStore.hasPassword(icpcId),
        djUsername: teamStore.getDjUsername(icpcId),
      };
    });
    const rows = all.filter((r) => r.teamCode);
    return c.json({ rows, unassigned: all.length - rows.length });
  });

  app.post("/admin/api/team-codes/generate", async (c) => {
    const body = await c.req.json().catch(() => null);
    const teams = teamsStore.load();
    if (body?.all === true) {
      let count = 0;
      for (const t of teams) {
        const icpcId = teamAccountKey(t);
        if (!icpcId || teamStore.getTeamCode(icpcId)) continue;
        teamStore.setTeamCode(icpcId);
        count++;
      }
      return c.json({ count });
    }
    const icpcId = typeof body?.icpcId === "string" ? body.icpcId.trim() : "";
    if (!icpcId) return c.json({ error: "icpcId required" }, 400);
    if (!teams.some((t) => teamAccountKey(t) === icpcId)) {
      return c.json({ error: "team not found" }, 404);
    }
    return c.json({ icpcId, teamCode: teamStore.setTeamCode(icpcId) });
  });

  /** CSV export (admin-gated): decrypted DOMjudge passwords, Excel-friendly BOM. */
  app.get("/admin/api/team-codes/export", (c) => {
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [["队伍名", "DOMjudge用户名", "队伍码", "DOMjudge密码"]];
    for (const t of teamsStore.load()) {
      const icpcId = teamAccountKey(t);
      rows.push([
        t.display_name?.trim() || t.name || "",
        teamStore.getDjUsername(icpcId) ?? icpcId,
        teamStore.getTeamCode(icpcId) ?? "",
        teamStore.getPassword(icpcId) ?? "",
      ]);
    }
    const csv = "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="team-codes-${date}.csv"`,
      },
    });
  });

  /** 16-char password from an unambiguous charset (no 0/O/1/l/I). */
  const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const randomPassword = (): string => {
    let out = "";
    for (let i = 0; i < 16; i++) out += PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)];
    return out;
  };

  /**
   * Provision team logins: assign a team code where missing and reset the
   * DOMjudge account password via the admin API, storing it encrypted locally.
   */
  app.post("/admin/api/team-codes/provision", async (c) => {
    const client = deps?.djClient;
    if (!client) return c.json({ error: "domjudge client unavailable" }, 503);
    const body = await c.req.json().catch(() => null);
    const teams = teamsStore.load();
    let targets: DjTeam[];
    if (body?.all === true) {
      targets = teams.filter((t) => {
        const icpcId = teamAccountKey(t);
        return icpcId !== "" && (!teamStore.getTeamCode(icpcId) || !teamStore.hasPassword(icpcId));
      });
    } else {
      const icpcId = typeof body?.icpcId === "string" ? body.icpcId.trim() : "";
      if (!icpcId) return c.json({ error: "icpcId required" }, 400);
      const team = teams.find((t) => teamAccountKey(t) === icpcId);
      if (!team) return c.json({ error: "team not found" }, 404);
      targets = [team];
    }

    let provisioned = 0;
    let skipped = 0;
    const errors: Array<{ icpcId: string; reason: string }> = [];
    for (const t of targets) {
      const icpcId = teamAccountKey(t);
      const password = randomPassword();
      let user: DjUser | null = null;
      try {
        user = await client.findTeamUser(icpcId);
        if (!user) {
          skipped++;
          errors.push({ icpcId, reason: "DOMjudge 队伍用户不存在（应为 team<id>）" });
          continue;
        }
        // Hard guard after the demo-API incident: only exact team accounts
        // may be PATCHed, no matter what the API returned.
        const roles = Array.isArray(user.roles) ? user.roles : [];
        const teamOnly = roles.length > 0 && roles.every((r) => r === "team");
        if (!teamOnly) {
          skipped++;
          errors.push({ icpcId, reason: "refusing non-team user" });
          continue;
        }
        // Only team-role accounts ever get a code stored.
        if (!teamStore.getTeamCode(icpcId)) teamStore.setTeamCode(icpcId);
        await client.patchUserPassword(user.id, password);
      } catch (err) {
        errors.push({ icpcId, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      teamStore.setPassword(icpcId, password, user.username);
      provisioned++;
    }
    return c.json({ provisioned, skipped, errors });
  });

  app.get("/admin/api/login-history", (c) => {
    const raw = c.req.query("limit");
    const limit = raw === undefined ? 100 : Number(raw);
    if (raw !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: "limit must be a positive number" }, 400);
    }
    // Enrich each row with the team's current name and DOMjudge account name;
    // teams may have been deleted since the login, so both may be null.
    const nameByIcpcId = new Map(
      teamsStore.load().map((t) => [teamAccountKey(t), t.display_name?.trim() || t.name]),
    );
    const rows = loginHistory
      .list(Math.min(Math.trunc(limit), 500))
      .map((e) => ({
        ...e,
        teamName: nameByIcpcId.get(e.icpcId) ?? null,
        djUsername: teamStore.getDjUsername(e.icpcId),
      }));
    return c.json(rows);
  });

  /**
   * Approval requests for logins outside the window (see auth/loginRequests):
   * `pending` is the admin's work queue, `recent` the decided history
   * (newest first, capped so the payload stays small mid-contest).
   */
  app.get("/admin/api/login-requests", (c) => {
    const all = loginRequests.listAll();
    // Stable: requestedAt desc, ties keep store order (newest created first).
    const recent = all
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status !== "pending")
      .sort((a, b) => b.r.requestedAt.localeCompare(a.r.requestedAt) || a.i - b.i)
      .slice(0, 50)
      .map(({ r }) => r);
    return c.json({ pending: all.filter((r) => r.status === "pending"), recent });
  });

  app.post("/admin/api/login-requests/:id/decision", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "rejected") {
      return c.json({ error: "decision must be approved or rejected" }, 400);
    }
    // decide() only mutates pending requests, so an already-decided (or unknown)
    // id surfaces as 404 instead of silently overwriting a previous decision.
    const updated = loginRequests.decide(c.req.param("id"), decision);
    if (!updated) return c.json({ error: "login request not found" }, 404);
    return c.json(updated);
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
      const raw = appPath(c, cfg());
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

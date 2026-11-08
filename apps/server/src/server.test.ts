import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { createApp } from "./server";
import { adminAuthHeaders } from "./admin/auth";
import { LoginHistoryStore } from "./admin/loginHistory";
import { DjClient } from "./domjudge/client";
import { BalloonService } from "./balloon/service";
import { PrintQueue } from "./print/queue";
import { JsonStore } from "./store/store";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { TeamStore } from "./store/teams";
import { SseBus } from "./sse/bus";
import { verifyTeamToken } from "./auth/token";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});

function makeTeamStore(dataDir: string): TeamStore {
  return new TeamStore(
    join(dataDir, "team-passwords.json"),
    new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))),
  );
}

describe("createApp", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "server-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET /health returns 200 and {\"ok\":true}", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

const TEAMS_JSON = [
  { id: "t1", icpc_id: "icpc1", name: "Team X", location: { description: "A-101" } },
];
const PROBLEMS_JSON = [{ id: "p1", label: "A", name: "Alpha" }];
const CONTEST_API: Record<string, unknown> = {
  "/api/v4/contests/C1/teams": TEAMS_JSON,
  "/api/v4/contests/C1/problems": PROBLEMS_JSON,
  "/api/v4/contests/C1/judgements": [
    { id: "j1", submission: "s1", judgement_type_id: "correct" },
  ],
  "/api/v4/contests/C1/judgement-types": [{ id: "correct", sorting_key: "correct" }],
  "/api/v4/contests/C1/submissions": [
    { id: "s1", problem: "p1", language: "cpp", team: "t1", time: "2026-01-01T00:00:00Z" },
  ],
};

const upstreamRequests: Array<{ method: string; path: string }> = [];
const upstream = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    upstreamRequests.push({ method: req.method, path });
    const data = CONTEST_API[path];
    if (data !== undefined) return Response.json(data);
    return new Response("upstream-ok", { status: 200 });
  },
});
afterAll(() => upstream.stop(true));

describe("DoD: full verify → proxy → print → admin chain", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "server-dod-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const makeCfg = () => ({
    ...loadConfigWithSecret(),
    contextPath: "",
    jwt: { secret: "dod-test-secret", ttlSeconds: 3600 },
    domjudge: {
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      adminUser: "admin",
      adminPassword: "pw",
      timeoutSeconds: 10,
    },
    teamLogin: { start: "", end: "" },
    print: { token: "print-tok" },
  });

  test("verify → cookie → proxy hit → print → admin list share one app instance", async () => {
    const teamStore = makeTeamStore(dataDir);
    teamStore.setPassword("icpc1", "team-pw");
    const teamCode = teamStore.setTeamCode("icpc1");
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    const app = createApp(makeCfg(), { dataDir, teamStore, printQueue });

    // 1. verify issues the team-token cookie carrying the icpcId
    const verifyRes = await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    expect(verifyRes.status).toBe(302);
    const setCookie = verifyRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("cxtool-token=");
    const token = /cxtool-token=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect((await verifyTeamToken("dod-test-secret", token))?.sub).toBe("icpc1");

    // 2. the cookie lets /dj/* reach the mock upstream
    const proxied = await app.request("/dj/anything", {
      headers: { cookie: `cxtool-token=${token}` },
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).toBe("upstream-ok");
    expect(upstreamRequests).toContainEqual({ method: "GET", path: "/anything" });

    // 3. print callback writes the PDF and enqueues a pending task
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "code.pdf", { type: "application/pdf" }));
    form.set("location", "A-101");
    form.set("teamname", "Team X");
    form.set("teamid", "t1");
    const printRes = await app.request("/dj/print", {
      method: "POST",
      headers: { "org.domjudge.print-token": "print-tok" },
      body: form,
    });
    expect(printRes.status).toBe(200);
    const pdfDir = join(dataDir, "pdf");
    expect(readdirSync(pdfDir).length).toBe(1);

    // 4. admin API lists the pending print task
    const tasks = await (await app.request("/admin/api/print-tasks", { headers: await adminAuthHeaders(makeCfg()) })).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].teamName).toBe("Team X");
    expect(tasks[0].location).toBe("A-101");
    // server-local pdfPath must not leak to the admin API
    expect(tasks[0].pdfPath).toBeUndefined();
  });

  test("verify → proxy chain works through a /wxt mount", async () => {
    const teamStore = makeTeamStore(dataDir);
    const teamCode = teamStore.setTeamCode("icpc2");
    const cfg = { ...makeCfg(), contextPath: "/wxt" };
    const app = new Hono().route("/wxt", createApp(cfg, { dataDir, teamStore }));

    const verifyRes = await app.request(`/wxt/dj/verify?code=${teamCode}`, { redirect: "manual" });
    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.get("location")).toBe("/wxt/dj/");
    const setCookie = verifyRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/wxt/dj");
    const token = /cxtool-token=([^;]+)/.exec(setCookie)?.[1] ?? "";

    const proxied = await app.request("/wxt/dj/anything", {
      headers: { cookie: `cxtool-token=${token}; DOMjudgeSID=keep` },
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).toBe("upstream-ok");
    expect(upstreamRequests).toContainEqual({ method: "GET", path: "/anything" });
  });

  test("every successful verify appends a login-history entry, newest first", async () => {
    const teamStore = makeTeamStore(dataDir);
    const code1 = teamStore.setTeamCode("icpc1");
    const code2 = teamStore.setTeamCode("icpc2");
    const history = new LoginHistoryStore(join(dataDir, "hist.json"));
    const app = createApp(makeCfg(), { dataDir, teamStore, loginHistory: history });

    await app.request(`/dj/verify?code=${code1}`, { redirect: "manual" });
    await app.request(`/dj/verify?code=${code2}`, { redirect: "manual" });

    const res = await app.request("/admin/api/login-history", {
      headers: await adminAuthHeaders(makeCfg()),
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ icpcId: string; teamCode: string; at: string; ip: string | null }>;
    expect(rows.map((r) => r.icpcId)).toEqual(["icpc2", "icpc1"]);
    expect(rows[0].teamCode).toBe(code2);
    expect(rows.every((r) => typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)))).toBe(true);
  });

  test("wrong team code never issues a cookie", async () => {
    const teamStore = makeTeamStore(dataDir);
    const app = createApp(makeCfg(), { dataDir, teamStore });
    const res = await app.request("/dj/verify?code=zzzzzzzzzzzz");
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("import-excel with an invalid file returns 400 invalid excel file", async () => {
    const teamStore = makeTeamStore(dataDir);
    const app = createApp(makeCfg(), {
      dataDir,
      teamStore,
      teamsStore: new JsonStore(join(dataDir, "teams.json"), []),
    });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], "bad.xlsx"));
    const res = await app.request("/admin/api/teams/import-excel", { method: "POST", headers: await adminAuthHeaders(makeCfg()), body: form });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid excel file" });
  });

  test("team sync refreshes the balloon service label/name lookups", async () => {
    const cfg = makeCfg();
    const client = new DjClient(cfg.domjudge);
    const bus = new SseBus();
    const balloonService = new BalloonService({
      client,
      store: new JsonStore(join(dataDir, "balloon-tasks.json"), []),
      bus,
      contestId: "C1",
      pollIntervalSeconds: 30,
      schedule: () => {}, // no background polling in tests
    });
    const app = createApp(cfg, {
      dataDir,
      djClient: client,
      teamsStore: new JsonStore(join(dataDir, "teams.json"), []),
      balloonService,
    });

    const syncRes = await app.request("/admin/api/teams/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ contestId: "C1" }),
    });
    expect(syncRes.status).toBe(200);
    expect(await syncRes.json()).toEqual({ count: 1, problemsMapped: true });

    // balloon service must resolve team/problem ids via refreshed lookups
    const created = await balloonService.pollOnce();
    expect(created).toBe(1);
    const tasks = await (await app.request("/admin/api/balloon-tasks", { headers: await adminAuthHeaders(cfg) })).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].teamName).toBe("Team X");
    expect(tasks[0].problemLabel).toBe("A");
    expect(tasks[0].location).toBe("A-101");
  });

  // Demo-debugged regression: a silently swallowed getProblems failure left
  // balloon tasks with raw problem ids as labels (1095 demo tasks).
  test("team sync still returns teams count with problemsMapped=false when the problems fetch fails", async () => {
    const cfg = makeCfg();
    let problemsFail = true;
    const client = {
      getTeams: async () => TEAMS_JSON,
      getProblems: async () => {
        if (problemsFail) throw new Error("problems endpoint down");
        return PROBLEMS_JSON;
      },
      getJudgementTypes: async () => CONTEST_API["/api/v4/contests/C1/judgement-types"],
      getJudgings: async () => CONTEST_API["/api/v4/contests/C1/judgements"],
      getSubmissions: async () => CONTEST_API["/api/v4/contests/C1/submissions"],
    } as unknown as DjClient;
    const bus = new SseBus();
    const balloonService = new BalloonService({
      client,
      store: new JsonStore(join(dataDir, "balloon-tasks-fail.json"), []),
      bus,
      contestId: "C1",
      pollIntervalSeconds: 30,
      schedule: () => {},
    });
    const app = createApp(cfg, {
      dataDir,
      djClient: client,
      teamsStore: new JsonStore(join(dataDir, "teams-fail.json"), []),
      balloonService,
    });

    const syncRes = await app.request("/admin/api/teams/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ contestId: "C1" }),
    });
    expect(syncRes.status).toBe(200);
    expect(await syncRes.json()).toEqual({ count: 1, problemsMapped: false });

    // The balloon service must have received EMPTY problems: a subsequent
    // poll falls back to the raw problem id (and logs, not silently maps).
    const created = await balloonService.pollOnce();
    expect(created).toBe(1);
    expect(balloonService.list()[0].problemLabel).toBe("p1");

    // A later successful sync re-labels the pending task to the real label.
    problemsFail = false;
    const retryRes = await app.request("/admin/api/teams/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ contestId: "C1" }),
    });
    expect(retryRes.status).toBe(200);
    expect(await retryRes.json()).toEqual({ count: 1, problemsMapped: true });
    expect(balloonService.list()[0].problemLabel).toBe("A");
  });
});

describe("static hosting", () => {
  let root: string;
  let staticDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "static-test-"));
    staticDir = join(root, "static");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><html><head><title>admin</title></head><body>ADMIN-INDEX</body></html>");
    writeFileSync(join(staticDir, "assets", "app-H4SH.js"), "console.log('fixture-js');");
    writeFileSync(join(staticDir, "logo.svg"), "<svg></svg>");
    writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const makeCfg = () => ({ ...loadConfigWithSecret(), contextPath: "/wxt" });
  const makeApp = () => new Hono().route("/wxt", createApp(makeCfg(), { dataDir: mkdtempSync(join(tmpdir(), "static-data-")), staticDir }));

  test("GET /wxt/ serves index.html as text/html", async () => {
    const res = await makeApp().request("/wxt/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ADMIN-INDEX");
  });

  test("GET .js asset returns application/javascript", async () => {
    const res = await makeApp().request("/wxt/assets/app-H4SH.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript");
    expect(await res.text()).toContain("fixture-js");
  });

  test("GET .svg asset returns image/svg+xml", async () => {
    const res = await makeApp().request("/wxt/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  test.each([
    "/wxt/%2e%2e/secret.txt",
    "/wxt/assets/%2e%2e/%2e%2e/secret.txt",
    "/wxt/assets/..%2fsecret.txt",
    "/wxt/..%5csecret.txt",
  ])("GET %s never leaks files outside staticDir", async (path) => {
    const res = await makeApp().request(path);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  test("deep link /wxt/login falls back to index.html", async () => {
    const res = await makeApp().request("/wxt/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ADMIN-INDEX");
  });

  test("SPA fallback does not swallow /admin/api 404s", async () => {
    const res = await makeApp().request("/wxt/admin/api/no-such-route");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("SPA fallback does not swallow /dj 404s", async () => {
    const res = await makeApp().request("/wxt/dj/no-such-route", { redirect: "manual" });
    // Team paths redirect humans to the type-in verify form.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/wxt/dj/verify");
  });

  test("non-GET miss does not fall back to index.html", async () => {
    const res = await makeApp().request("/wxt/login", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

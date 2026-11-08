import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { AuthQueue } from "./queue/authQueue";
import { createApp } from "./server";
import { adminAuthHeaders } from "./admin/auth";
import { DjClient } from "./domjudge/client";
import { BalloonService } from "./balloon/service";
import { PrintQueue } from "./print/queue";
import { JsonStore } from "./store/store";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { TeamStore } from "./store/teams";
import { SseBus } from "./sse/bus";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});
const CAPTURE_FILE = "fingerprints.jsonl";

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

  test("capture=true records a fingerprint line per request", async () => {
    const cfg = { ...loadConfigWithSecret(), oms: { strategies: [], uaRegexes: [], capture: true } };
    const app = createApp(cfg, { dataDir });
    await app.request("/health");
    const capturePath = join(dataDir, CAPTURE_FILE);
    expect(existsSync(capturePath)).toBe(true);
    const lines = readFileSync(capturePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const fp = JSON.parse(lines[0]);
    expect(fp.method).toBe("GET");
    expect(fp.path).toBe("/health");
  });

  test("capture=false writes no capture file", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    await app.request("/health");
    expect(existsSync(join(dataDir, CAPTURE_FILE))).toBe(false);
  });

  test("identified request is enqueued and auto-done when autoAccept is on", async () => {
    const cfg = {
      ...loadConfigWithSecret(),
      oms: { strategies: ["ua-regex"], uaRegexes: [], capture: false },
    };
    const queue = new AuthQueue(join(dataDir, "auth-tasks.json"));
    queue.autoAccept = true;
    const app = createApp(cfg, { dataDir, authQueue: queue });
    const res = await app.request("/health", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.7" },
    });
    expect(res.status).toBe(200);
    const tasks = await (await app.request("/admin/api/auth-tasks?status=auto-done", { headers: await adminAuthHeaders(cfg) })).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].examNum).toBe("unknown");
    expect(tasks[0].strategy).toBe("ua-regex");
    expect(tasks[0].clientId).toBeNull();
  });

  test("unidentified request does not enqueue", async () => {
    const cfg = {
      ...loadConfigWithSecret(),
      oms: { strategies: ["ua-regex"], uaRegexes: [], capture: false },
    };
    const queue = new AuthQueue(join(dataDir, "auth-tasks.json"));
    const app = createApp(cfg, { dataDir, authQueue: queue });
    await app.request("/health", { headers: { "user-agent": "curl/8.0" } });
    expect(queue.list().length).toBe(0);
  });

  test("uses deps.server.requestIP for the client ip in captured fingerprints", async () => {
    const cfg = { ...loadConfigWithSecret(), oms: { strategies: [], uaRegexes: [], capture: true } };
    const app = createApp(cfg, {
      dataDir,
      server: { requestIP: () => ({ address: "1.2.3.4" }) },
    });
    await app.request("/health");
    const fp = JSON.parse(readFileSync(join(dataDir, CAPTURE_FILE), "utf8"));
    expect(fp.ip).toBe("1.2.3.4");
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
    },
    oms: { strategies: ["ua-regex"], uaRegexes: [], capture: false },
    print: { token: "print-tok" },
  });

  test("verify → cookie → proxy hit → print → admin list share one app instance", async () => {
    const queue = new AuthQueue(join(dataDir, "auth-tasks.json"));
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E1", clientId: "client-1", strategy: "ua-regex" });
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    const app = createApp(makeCfg(), { dataDir, authQueue: queue, printQueue });

    // 1. verify issues the team-token cookie
    const verifyRes = await app.request("/dj/verify?examNum=E1", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.7", "x-oms-client-id": "client-1" },
    });
    expect(verifyRes.status).toBe(302);
    const setCookie = verifyRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("cxtool-token=");
    const token = /cxtool-token=([^;]+)/.exec(setCookie)?.[1] ?? "";

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

  test("verify → proxy chain works through a /cxtool mount", async () => {
    const queue = new AuthQueue(join(dataDir, "auth-tasks-mount.json"));
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E2", clientId: "client-2", strategy: "ua-regex" });
    const cfg = { ...makeCfg(), contextPath: "/cxtool" };
    const app = new Hono().route("/cxtool", createApp(cfg, { dataDir, authQueue: queue }));

    const verifyRes = await app.request("/cxtool/dj/verify?examNum=E2", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.7", "x-oms-client-id": "client-2" },
      redirect: "manual",
    });
    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.get("location")).toBe("/cxtool/dj/");
    const setCookie = verifyRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/cxtool/dj");
    const token = /cxtool-token=([^;]+)/.exec(setCookie)?.[1] ?? "";

    const proxied = await app.request("/cxtool/dj/anything", {
      headers: { cookie: `cxtool-token=${token}; DOMjudgeSID=keep` },
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).toBe("upstream-ok");
    expect(upstreamRequests).toContainEqual({ method: "GET", path: "/anything" });
  });

  test("import-excel with an invalid file returns 400 invalid excel file", async () => {
    const teamStore = new TeamStore(
      join(dataDir, "team-passwords.json"),
      new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))),
    );
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
    expect(await syncRes.json()).toEqual({ count: 1 });

    // balloon service must resolve team/problem ids via refreshed lookups
    const created = await balloonService.pollOnce();
    expect(created).toBe(1);
    const tasks = await (await app.request("/admin/api/balloon-tasks", { headers: await adminAuthHeaders(cfg) })).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].teamName).toBe("Team X");
    expect(tasks[0].problemLabel).toBe("A");
    expect(tasks[0].location).toBe("A-101");
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

  const makeCfg = () => ({ ...loadConfigWithSecret(), contextPath: "/cxtool" });
  const makeApp = () => new Hono().route("/cxtool", createApp(makeCfg(), { dataDir: mkdtempSync(join(tmpdir(), "static-data-")), staticDir }));

  test("GET /cxtool/ serves index.html as text/html", async () => {
    const res = await makeApp().request("/cxtool/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ADMIN-INDEX");
  });

  test("GET .js asset returns application/javascript", async () => {
    const res = await makeApp().request("/cxtool/assets/app-H4SH.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript");
    expect(await res.text()).toContain("fixture-js");
  });

  test("GET .svg asset returns image/svg+xml", async () => {
    const res = await makeApp().request("/cxtool/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  test.each([
    "/cxtool/%2e%2e/secret.txt",
    "/cxtool/assets/%2e%2e/%2e%2e/secret.txt",
    "/cxtool/assets/..%2fsecret.txt",
    "/cxtool/..%5csecret.txt",
  ])("GET %s never leaks files outside staticDir", async (path) => {
    const res = await makeApp().request(path);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  test("deep link /cxtool/login falls back to index.html", async () => {
    const res = await makeApp().request("/cxtool/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ADMIN-INDEX");
  });

  test("SPA fallback does not swallow /admin/api 404s", async () => {
    const res = await makeApp().request("/cxtool/admin/api/no-such-route");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("SPA fallback does not swallow /dj 404s", async () => {
    const res = await makeApp().request("/cxtool/dj/no-such-route");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("non-GET miss does not fall back to index.html", async () => {
    const res = await makeApp().request("/cxtool/login", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

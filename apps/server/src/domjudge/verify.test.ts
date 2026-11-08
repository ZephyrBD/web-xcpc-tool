import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { loadConfig } from "../config";
import { AuthQueue } from "../queue/authQueue";
import { verifyTeamToken } from "../auth/token";
import { verifyClient } from "./verify";
import { createApp } from "../server";

const SECRET = "test-secret";

function testQueue(): AuthQueue {
  return new AuthQueue(join(tmpdir(), `verify-test-${crypto.randomUUID()}.json`));
}

function testCfg() {
  return {
    ...loadConfig("/nonexistent/settings.json"),
    contextPath: "",
    jwt: { secret: SECRET, ttlSeconds: 600 },
    domjudge: { baseUrl: "http://test.local", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    oms: { strategies: ["ua-regex"], uaRegexes: [], capture: false },
  };
}

describe("verifyClient", () => {
  test("approved/auto-done task with matching examNum+clientId yields a verifiable token", async () => {
    const cfg = testCfg();
    const queue = testQueue();
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E123", clientId: null, strategy: "ua-regex" });
    const res = await verifyClient(
      {
        ip: "1.2.3.4",
        method: "GET",
        path: "/dj/verify",
        headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
      },
      "E123",
      queue.list(),
      cfg,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const payload = await verifyTeamToken(SECRET, res.token);
    expect(payload?.examNum).toBe("E123");
  });

  test("no approved task → 403 reason not approved", async () => {
    const cfg = testCfg();
    const queue = testQueue();
    const res = await verifyClient(
      {
        ip: "1.2.3.4",
        method: "GET",
        path: "/dj/verify",
        headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
      },
      "E123",
      queue.list(),
      cfg,
    );
    expect(res).toEqual({ ok: false, reason: "not approved" });
  });

  test("UA matches no strategy → 403 reason illegal client", async () => {
    const cfg = testCfg();
    const queue = testQueue();
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E123", clientId: null, strategy: "ua-regex" });
    const res = await verifyClient(
      {
        ip: "1.2.3.4",
        method: "GET",
        path: "/dj/verify",
        headers: { "user-agent": "curl/8.0" },
      },
      "E123",
      queue.list(),
      cfg,
    );
    expect(res).toEqual({ ok: false, reason: "illegal client" });
  });

  test("clientId header must match the task's clientId", async () => {
    const cfg = testCfg();
    const queue = testQueue();
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E123", clientId: "client-a", strategy: "client-id" });
    const res = await verifyClient(
      {
        ip: "1.2.3.4",
        method: "GET",
        path: "/dj/verify",
        headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3", "x-oms-client-id": "client-b" },
      },
      "E123",
      queue.list(),
      cfg,
    );
    expect(res).toEqual({ ok: false, reason: "not approved" });
  });
});

describe("GET /dj/verify route", () => {
  test("success redirects to this server's dj path with cxtool-token cookie", async () => {
    const cfg = testCfg();
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E456", clientId: null, strategy: "ua-regex" });
    const app = createApp(cfg, { authQueue: queue });
    const res = await app.request("/dj/verify?examNum=E456", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dj/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("cxtool-token=");
    expect(cookie).toContain("Path=/dj");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const token = /cxtool-token=([^;]+)/.exec(cookie)?.[1] ?? "";
    const payload = await verifyTeamToken(SECRET, token);
    expect(payload?.examNum).toBe("E456");
  });

  test("under /cxtool mount, redirect and cookie path carry the contextPath", async () => {
    const cfg = { ...testCfg(), contextPath: "/cxtool" };
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    queue.autoAccept = true;
    queue.enqueue({ examNum: "E789", clientId: null, strategy: "ua-regex" });
    const sub = createApp(cfg, { authQueue: queue });
    const app = new Hono().route("/cxtool", sub);
    const res = await app.request("/cxtool/dj/verify?examNum=E789", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/cxtool/dj/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Path=/cxtool/dj");
    const token = /cxtool-token=([^;]+)/.exec(cookie)?.[1] ?? "";
    const payload = await verifyTeamToken(SECRET, token);
    expect(payload?.examNum).toBe("E789");
  });

  test("unrecognized client returns 403 HTML miss page echoing the exam number", async () => {
    const cfg = testCfg();
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    const app = createApp(cfg, { authQueue: queue });
    const res = await app.request("/dj/verify?examNum=E456", {
      headers: { "user-agent": "curl/8.0" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("E456");
    expect(text).toContain("未识别到考位信息");
  });

  test("pending task returns 200 HTML wait page", async () => {
    const cfg = testCfg();
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    queue.enqueue({ examNum: "E777", clientId: null, strategy: "ua-regex" });
    const app = createApp(cfg, { authQueue: queue });
    const res = await app.request("/dj/verify?examNum=E777", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("等待监考批准");
  });

  test("rejected task returns 403 HTML rejection page", async () => {
    const cfg = testCfg();
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    const task = queue.enqueue({ examNum: "E888", clientId: null, strategy: "ua-regex" });
    queue.reject(task.id);
    const app = createApp(cfg, { authQueue: queue });
    const res = await app.request("/dj/verify?examNum=E888", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("认证被拒绝");
  });

  test("pending page auto-refreshes so approval takes effect without manual reload", async () => {
    const cfg = testCfg();
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    queue.enqueue({ examNum: "E777", clientId: null, strategy: "ua-regex" });
    const app = createApp(cfg, { authQueue: queue });
    const res = await app.request("/dj/verify?examNum=E777", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
    });
    expect(await res.text()).toContain('http-equiv="refresh"');
  });

  test("examNum is escaped in the miss page (XSS regression)", async () => {
    const cfg = testCfg();
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    const app = createApp(cfg, { authQueue: queue });
    const res = await app.request("/dj/verify?examNum=<script>alert(1)</script>", {
      headers: { "user-agent": "curl/8.0" },
    });
    const text = await res.text();
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain("<script>alert(1)</script>");
  });

  test("pending page renders under a /cxtool mount", async () => {
    const cfg = { ...testCfg(), contextPath: "/cxtool" };
    const queue = new AuthQueue(join(tmpdir(), `verify-route-${crypto.randomUUID()}.json`));
    queue.enqueue({ examNum: "E999", clientId: null, strategy: "ua-regex" });
    const sub = createApp(cfg, { authQueue: queue });
    const app = new Hono().route("/cxtool", sub);
    const res = await app.request("/cxtool/dj/verify?examNum=E999", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.5.3" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

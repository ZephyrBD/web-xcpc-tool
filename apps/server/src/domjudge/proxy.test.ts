import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { signAdminToken, signTeamToken } from "../auth/token";
import { createApp } from "../server";
import { handleRootDjProxy, makeRootDispatch } from "./proxy";
import { SecretBox } from "../store/secretbox";
import { setDataDir } from "../store/store";
import { TeamStore } from "../store/teams";

const SECRET = "proxy-test-secret";
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function testStore(): TeamStore {
  setDataDir(mkdtempSync(join(tmpdir(), "proxy-teams-")));
  return new TeamStore("teams.json", new SecretBox(KEY));
}

let hits = 0;
let lastReq: { method: string; path: string; body: string; cookie: string | null; headers: Record<string, string> } | null = null;
let upstreamPort = 0;

const upstream = Bun.serve({
  port: 0,
  fetch: async (req) => {
    hits++;
    lastReq = {
      method: req.method,
      path: new URL(req.url).pathname,
      body: await req.text(),
      cookie: req.headers.get("cookie"),
      headers: Object.fromEntries(req.headers.entries()),
    };
    return new Response(JSON.stringify({ echo: "upstream-ok" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-upstream": "mock" },
    });
  },
});
upstreamPort = upstream.port as number;
afterAll(() => upstream.stop(true));

describe("DOMjudge reverse proxy", () => {
  afterEach(() => {
    hits = 0;
    lastReq = null;
  });

  const makeCfg = (contextPath = "") => ({
    ...loadConfig("/nonexistent/settings.json"),
    contextPath,
    jwt: { secret: SECRET, ttlSeconds: 3600 },
    domjudge: { baseUrl: `http://127.0.0.1:${upstreamPort}`, adminUser: "", adminPassword: "", timeoutSeconds: 10 },
  });

  test("valid token forwards to upstream and passes the response through", async () => {
    const app = createApp(makeCfg());
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await app.request("/dj/api/contests?limit=5", {
      headers: { cookie: `cxtool-token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: "upstream-ok" });
    expect(res.headers.get("x-upstream")).toBe("mock");
    expect(hits).toBe(1);
    expect(lastReq?.method).toBe("GET");
    expect(lastReq?.path).toBe("/api/contests");
    // other cookies must survive, only cxtool-token is stripped
    expect(lastReq?.cookie).toBeNull();

    const res2 = await app.request("/dj/api/contests", {
      headers: { cookie: `cxtool-token=${token}; DOMjudgeSID=keep` },
    });
    expect(res2.status).toBe(200);
    expect(lastReq?.cookie).toBe("DOMjudgeSID=keep");
  });

  test("admin token cookie is rejected at the proxy (role separation)", async () => {
    const app = createApp(makeCfg());
    const token = await signAdminToken(SECRET, 3600, "admin");
    const res = await app.request("/dj/api/contests", {
      headers: { cookie: `cxtool-token=${token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dj/verify");
    expect(hits).toBe(0);
  });

  test("missing cookie redirects to the verify form and upstream hit count stays 0", async () => {
    const app = createApp(makeCfg());
    const res = await app.request("/dj/api/contests", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dj/verify");
    expect(hits).toBe(0);
  });

  test("missing cookie under a contextPath mount redirects to /wxt/dj/verify", async () => {
    const sub = createApp(makeCfg("/wxt"));
    const app = new Hono().route("/wxt", sub);
    const res = await app.request("/wxt/dj/api/contests", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/wxt/dj/verify");
    expect(hits).toBe(0);
  });

  test("tampered token redirects to the verify form", async () => {
    const app = createApp(makeCfg());
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await app.request("/dj/api/contests", {
      headers: { cookie: `cxtool-token=${token.slice(0, -4)}AAAA` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dj/verify");
    expect(hits).toBe(0);
  });

  test("unreachable upstream returns 502 and does not crash", async () => {
    const cfg = {
      ...makeCfg(),
      domjudge: { baseUrl: "http://127.0.0.1:1", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    };
    const app = createApp(cfg);
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await app.request("/dj/api/contests", {
      headers: { cookie: `cxtool-token=${token}` },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: "upstream error" });
  });

  test("POST body is forwarded to upstream", async () => {
    const app = createApp(makeCfg());
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await app.request("/dj/api/submissions", {
      method: "POST",
      headers: { cookie: `cxtool-token=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ problem: "A", language: "cpp" }),
    });
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
    expect(lastReq?.method).toBe("POST");
    expect(lastReq?.body).toBe('{"problem":"A","language":"cpp"}');
    expect(lastReq?.path).toBe("/api/submissions");
  });

  test("request to upstream /login injects X-DOMjudge-Login/Pass from the team store", async () => {
    const store = testStore();
    store.setPassword("2025001", "s3cret pw");
    const app = createApp(makeCfg(), { teamStore: store });
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await app.request("/dj/login", {
      method: "POST",
      headers: { cookie: `cxtool-token=${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: "username=ignored&password=ignored",
    });
    expect(res.status).toBe(200);
    expect(lastReq?.path).toBe("/login");
    expect(lastReq?.headers["x-domjudge-login"]).toBe("2025001");
    expect(lastReq?.headers["x-domjudge-pass"]).toBe(Buffer.from("s3cret pw", "utf8").toString("base64"));
  });

  test("non-printable characters are stripped from the injected X-DOMjudge-Login value", async () => {
    const store = testStore();
    store.setPassword("2025 001\t", "pw");
    const app = createApp(makeCfg(), { teamStore: store });
    const token = await signTeamToken(SECRET, 3600, "2025 001\t");
    await app.request("/dj/login", { headers: { cookie: `cxtool-token=${token}` } });
    expect(lastReq?.headers["x-domjudge-login"]).toBe("2025001");
  });

  describe("root DOMjudge proxy (outside contextPath)", () => {
    test("valid team token forwards the root path to upstream", async () => {
      const token = await signTeamToken(SECRET, 3600, "2025001");
      const res = await handleRootDjProxy(
        new Request(`http://127.0.0.1:${upstreamPort}/some/dj/page`, { headers: { cookie: `cxtool-token=${token}` } }),
        makeCfg("/wxt"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ echo: "upstream-ok" });
      expect(lastReq?.path).toBe("/some/dj/page");
    });

    test("missing token redirects to the team verify page carrying next", async () => {
      const res = await handleRootDjProxy(
        new Request(`http://127.0.0.1:${upstreamPort}/scoreboard?foo=1`),
        makeCfg("/wxt"),
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/wxt/dj/verify?next=");
      expect(location).toContain(encodeURIComponent("/scoreboard?foo=1"));
      expect(hits).toBe(0);
    });

    test("dispatcher keeps the contextPath admin UI intact and proxies the rest", async () => {
      const app = createApp(makeCfg("/wxt"), { teamStore: testStore() });
      const serving = new Hono().route("/wxt", app);
      const dispatch = makeRootDispatch(serving, makeCfg("/wxt"));
      // /wxt paths reach the admin app, not the proxy
      const adminRes = await dispatch(new Request(`http://127.0.0.1:${upstreamPort}/wxt/login`, { redirect: "manual" }));
      expect(hits).toBe(0);
      expect(adminRes.status).not.toBe(302);
      // root paths reach the proxy
      const token = await signTeamToken(SECRET, 3600, "2025001");
      const proxied = await dispatch(
        new Request(`http://127.0.0.1:${upstreamPort}/api/contests`, { headers: { cookie: `cxtool-token=${token}` } }),
      );
      expect(proxied.status).toBe(200);
      expect(lastReq?.path).toBe("/api/contests");
    });
  });

  test("non-/login paths do NOT get X-Headers injected", async () => {
    const store = testStore();
    store.setPassword("2025001", "s3cret pw");
    const app = createApp(makeCfg(), { teamStore: store });
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await app.request("/dj/api/contests", { headers: { cookie: `cxtool-token=${token}` } });
    expect(lastReq?.headers["x-domjudge-login"]).toBeUndefined();
    expect(lastReq?.headers["x-domjudge-pass"]).toBeUndefined();
  });

  test("a team without a stored credential falls back to no injection on /login", async () => {
    const store = testStore(); // no password for "nobody"
    const app = createApp(makeCfg(), { teamStore: store });
    const token = await signTeamToken(SECRET, 3600, "nobody");
    const res = await app.request("/dj/login", { headers: { cookie: `cxtool-token=${token}` } });
    expect(res.status).toBe(200);
    expect(lastReq?.headers["x-domjudge-login"]).toBeUndefined();
    expect(lastReq?.headers["x-domjudge-pass"]).toBeUndefined();
  });

  test("cxtool-token is stripped from the upstream request on /login too", async () => {
    const store = testStore();
    store.setPassword("2025001", "pw");
    const app = createApp(makeCfg(), { teamStore: store });
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await app.request("/dj/login", { headers: { cookie: `cxtool-token=${token}; DOMjudgeSID=keep` } });
    expect(lastReq?.cookie).toBe("DOMjudgeSID=keep");
  });

  test("large binary body streams through intact", async () => {
    const payload = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    const capture = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const buf = await req.arrayBuffer();
        const match = buf.byteLength === payload.length && new Uint8Array(buf).every((b, i) => b === payload[i]);
        return new Response(match ? "match" : "mismatch");
      },
    });
    try {
      const cfg = { ...makeCfg(), domjudge: { ...makeCfg().domjudge, baseUrl: `http://127.0.0.1:${capture.port}` } };
      const app = createApp(cfg);
      const token = await signTeamToken(SECRET, 3600, "2025001");
      const res = await app.request("/dj/upload", {
        method: "POST",
        headers: { cookie: `cxtool-token=${token}`, "content-type": "application/octet-stream" },
        body: payload,
      });
      expect(await res.text()).toBe("match");
    } finally {
      capture.stop(true);
    }
  });

  test("proxyFilter and resolveTarget helpers", async () => {
    const { proxyFilter, resolveTarget } = await import("./proxy");
    const cfg = makeCfg();
    const fakeCtx = (path: string) => ({ req: { url: `http://host${path}` } }) as unknown as Context;
    expect(proxyFilter(fakeCtx("/dj/api/contests"), cfg)).toBe("/api/contests");
    expect(proxyFilter(fakeCtx("/dj/"), cfg)).toBe("/");
    expect(proxyFilter(fakeCtx("/dj"), cfg)).toBe("/");
    expect(proxyFilter(fakeCtx("/djx/api"), cfg)).toBeNull();
    expect(proxyFilter(fakeCtx("/wxt/dj/api/contests"), makeCfg("/wxt"))).toBe("/api/contests");
    expect(resolveTarget(cfg, "/api/contests")).toBe(`http://127.0.0.1:${upstreamPort}/api/contests`);
    expect(resolveTarget(cfg, "api/x")).toBe(`http://127.0.0.1:${upstreamPort}/api/x`);
  });
});

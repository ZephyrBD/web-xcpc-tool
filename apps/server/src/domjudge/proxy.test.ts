import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { loadConfig } from "../config";
import { signTeamToken } from "../auth/token";
import { createApp } from "../server";

const SECRET = "proxy-test-secret";

let hits = 0;
let lastReq: { method: string; path: string; body: string; cookie: string | null } | null = null;
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

  test("missing cookie returns 401 and upstream hit count stays 0", async () => {
    const app = createApp(makeCfg());
    const res = await app.request("/dj/api/contests");
    expect(res.status).toBe(401);
    expect(hits).toBe(0);
  });

  test("tampered token returns 401", async () => {
    const app = createApp(makeCfg());
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await app.request("/dj/api/contests", {
      headers: { cookie: `cxtool-token=${token.slice(0, -4)}AAAA` },
    });
    expect(res.status).toBe(401);
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
    expect(proxyFilter(fakeCtx("/cxtool/dj/api/contests"), makeCfg("/cxtool"))).toBe("/api/contests");
    expect(resolveTarget(cfg, "/api/contests")).toBe(`http://127.0.0.1:${upstreamPort}/api/contests`);
    expect(resolveTarget(cfg, "api/x")).toBe(`http://127.0.0.1:${upstreamPort}/api/x`);
  });
});

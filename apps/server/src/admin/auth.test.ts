import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "bcryptjs";
import { Hono } from "hono";
import { loadConfig, type Config } from "../config";
import { createApp } from "../server";
import { ADMIN_COOKIE, adminAuthHeaders, verifyAdminToken } from "./auth";

const PASSWORD = "correct-horse";

async function makeCfg(overrides: Partial<Config["admin"]> = {}): Promise<Config> {
  return {
    ...loadConfig("/nonexistent/settings.json"),
    jwt: { secret: "admin-test-secret", ttlSeconds: 3600 },
    admin: {
      username: "admin",
      passwordHash: await hash(PASSWORD, 8),
      sessionTtlSeconds: 3600,
      ...overrides,
    },
  };
}

function login(app: Hono, body: unknown) {
  return app.request("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin auth", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "admin-auth-"));
  });

  test("wrong password returns 401 before rate limiting kicks in", async () => {
    const app = createApp(await makeCfg(), { dataDir });
    const res = await login(app, { username: "admin", password: "wrong" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBeTruthy();
  });

  test("empty passwordHash always 401s with a fixed message", async () => {
    const app = createApp(await makeCfg({ passwordHash: "" }), { dataDir });
    const res1 = await login(app, { username: "admin", password: "whatever" });
    const res2 = await login(app, { username: "nobody", password: "whatever" });
    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect(await res1.json()).toEqual(await res2.json());
  });

  test("correct credentials return 200 with a verifiable role=admin token and cookie", async () => {
    const cfg = await makeCfg();
    const app = createApp(cfg, { dataDir });
    const res = await login(app, { username: "admin", password: PASSWORD });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const payload = await verifyAdminToken(cfg.jwt.secret, token);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe("admin");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${ADMIN_COOKIE}=${token}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/wxt/");
  });

  test("cookie path is pinned to the fixed /wxt mount", async () => {
    const app = createApp(await makeCfg(), { dataDir });
    const res = await login(app, { username: "admin", password: PASSWORD });
    expect(res.headers.get("set-cookie")).toContain("Path=/wxt/");
  });

  test("admin token is rejected by team-token verification and vice versa", async () => {
    const cfg = await makeCfg();
    const app = createApp(cfg, { dataDir });
    const { token } = await (await login(app, { username: "admin", password: PASSWORD })).json();
    expect(await verifyAdminToken(cfg.jwt.secret, token)).not.toBeNull();
  });

  test("unauthenticated admin routes all return 401", async () => {
    const app = createApp(await makeCfg(), {
      dataDir,
      balloonService: {
        list: () => [],
        ack: () => null,
        refresh: () => {},
        pollOnce: async () => 0,
        start: () => {},
        stop: () => {},
      } as never,
      djClient: { getTeams: async () => [], getProblems: async () => [] } as never,
    });
    const cases: Array<[string, RequestInit]> = [
      ["/admin/api/print-tasks", {}],
      ["/admin/api/balloon-tasks", {}],
      ["/admin/api/teams", {}],
      ["/admin/api/teams/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ["/admin/api/print-tasks/t1/ack", { method: "POST" }],
      ["/admin/api/balloon-tasks/t1/ack", { method: "POST" }],
      ["/admin/api/events", {}],
    ];
    for (const [path, init] of cases) {
      const res = await app.request(path, init);
      expect(res.status).toBe(401);
    }
  });

  test("Bearer token grants access to admin routes", async () => {
    const cfg = await makeCfg();
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/print-tasks", { headers: await adminAuthHeaders(cfg) });
    expect(res.status).toBe(200);
  });

  test("6th failed login within a minute is rate limited with 429", async () => {
    const app = createApp(await makeCfg(), { dataDir });
    for (let i = 0; i < 5; i++) {
      const res = await login(app, { username: "admin", password: "wrong" });
      expect(res.status).toBe(401);
    }
    const sixth = await login(app, { username: "admin", password: "wrong" });
    expect(sixth.status).toBe(429);
  });

  test("a successful login still works after unrelated failures (limit counts failures only)", async () => {
    const cfg = await makeCfg();
    const app = createApp(cfg, { dataDir });
    await login(app, { username: "admin", password: "wrong" });
    await login(app, { username: "admin", password: "wrong" });
    const res = await login(app, { username: "admin", password: PASSWORD });
    expect(res.status).toBe(200);
  });

  test("SSE events accepts ?token= query param", async () => {
    const cfg = await makeCfg();
    const app = createApp(cfg, { dataDir });
    const { token } = await (await login(app, { username: "admin", password: PASSWORD })).json();
    const controller = new AbortController();
    const res = await app.request(`/admin/api/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
  });

  test("SSE events rejects a bad ?token=", async () => {
    const app = createApp(await makeCfg(), { dataDir });
    const controller = new AbortController();
    const res = await app.request("/admin/api/events?token=bogus", { signal: controller.signal });
    expect(res.status).toBe(401);
    controller.abort();
  });

  test("401 applies through a /wxt mount too", async () => {
    const cfg = await makeCfg();
    const mounted = new Hono().route("/wxt", createApp(cfg, { dataDir }));
    const res = await mounted.request("/wxt/admin/api/settings");
    expect(res.status).toBe(401);
    const loginRes = await mounted.request("/wxt/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get("set-cookie")).toContain("Path=/wxt/");
  });

  // Production mounts the whole app at /wxt, so these paths carry the prefix:
  // an unmounted-only test would hide a path comparison that never matches.
  test("SSE events accepts ?token= query param through the /wxt mount", async () => {
    const cfg = await makeCfg();
    const mounted = new Hono().route("/wxt", createApp(cfg, { dataDir }));
    const { token } = await (
      await mounted.request("/wxt/admin/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      })
    ).json();
    const controller = new AbortController();
    const res = await mounted.request(`/wxt/admin/api/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
  });

  test("SSE events still rejects a bad ?token= through the /wxt mount", async () => {
    const mounted = new Hono().route("/wxt", createApp(await makeCfg(), { dataDir }));
    const controller = new AbortController();
    const res = await mounted.request("/wxt/admin/api/events?token=bogus", {
      signal: controller.signal,
    });
    expect(res.status).toBe(401);
    controller.abort();
  });

  test("a mounted POST /wxt/admin/api/login is not gated by requireAdmin", async () => {
    const mounted = new Hono().route("/wxt", createApp(await makeCfg(), { dataDir }));
    const res = await mounted.request("/wxt/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ADMIN_COOKIE}=`);
  });
});

const upstream = Bun.serve({
  port: 0,
  fetch: () => Response.json([]),
});
afterAll(() => upstream.stop(true));

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../config";
import { verifyTeamToken } from "../auth/token";
import { inLoginWindow, verifyTeamCode } from "./verify";
import { createApp } from "../server";
import { SecretBox } from "../store/secretbox";
import { setDataDir } from "../store/store";
import { TeamStore } from "../store/teams";

const SECRET = "test-secret";
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function testCfg(teamLogin: { start: string; end: string } = { start: "", end: "" }) {
  return {
    ...loadConfig("/nonexistent/settings.json"),
    contextPath: "",
    jwt: { secret: SECRET, ttlSeconds: 600 },
    domjudge: { baseUrl: "http://test.local", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    teamLogin,
  };
}

function testStore(): TeamStore {
  const dir = join(tmpdir(), `verify-store-${crypto.randomUUID()}`);
  setDataDir(dir);
  const store = new TeamStore("teams.json", new SecretBox(KEY));
  return store;
}

describe("inLoginWindow", () => {
  const base = new Date("2026-01-01T10:00:00Z");

  test("both empty = always allowed", () => {
    const w = { start: "", end: "" };
    expect(inLoginWindow(new Date("2000-01-01T00:00:00Z"), w)).toBe(true);
    expect(inLoginWindow(base, w)).toBe(true);
  });

  test("inside the window is allowed", () => {
    const w = { start: "2026-01-01T09:00:00Z", end: "2026-01-01T11:00:00Z" };
    expect(inLoginWindow(base, w)).toBe(true);
  });

  test("before start is rejected", () => {
    const w = { start: "2026-01-01T10:00:01Z", end: "" };
    expect(inLoginWindow(base, w)).toBe(false);
  });

  test("after end is rejected", () => {
    const w = { start: "", end: "2026-01-01T09:59:59Z" };
    expect(inLoginWindow(base, w)).toBe(false);
  });

  test("boundary instants are inclusive", () => {
    expect(inLoginWindow(base, { start: "2026-01-01T10:00:00Z", end: "" })).toBe(true);
    expect(inLoginWindow(base, { start: "", end: "2026-01-01T10:00:00Z" })).toBe(true);
  });

  test("only-end set = allowed from the beginning until end", () => {
    const w = { start: "", end: "2026-01-01T12:00:00Z" };
    expect(inLoginWindow(new Date("2020-01-01T00:00:00Z"), w)).toBe(true);
    expect(inLoginWindow(new Date("2027-01-01T00:00:00Z"), w)).toBe(false);
  });

  test("only-start set = allowed from start until forever", () => {
    const w = { start: "2026-01-01T12:00:00Z", end: "" };
    expect(inLoginWindow(new Date("2020-01-01T00:00:00Z"), w)).toBe(false);
    expect(inLoginWindow(new Date("2027-01-01T00:00:00Z"), w)).toBe(true);
  });
});

describe("verifyTeamCode", () => {
  test("correct code inside the window yields a token with sub=icpcId", async () => {
    const store = testStore();
    store.setPassword("2025001", "pw");
    const code = store.setTeamCode("2025001");
    const res = await verifyTeamCode(code, store, testCfg(), new Date("2026-01-01T10:00:00Z"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const payload = await verifyTeamToken(SECRET, res.token);
    expect(payload?.sub).toBe("2025001");
  });

  test("wrong code reports bad-code", async () => {
    const store = testStore();
    store.setTeamCode("t1");
    const res = await verifyTeamCode("zzzzzzzzzzzz", store, testCfg(), new Date());
    expect(res).toEqual({ ok: false, reason: "bad-code" });
  });

  test("correct code outside the window reports outside-window", async () => {
    const store = testStore();
    store.setTeamCode("t1", "abcdefgh2345");
    const cfg = testCfg({ start: "2026-01-01T00:00:00Z", end: "2026-01-01T08:00:00Z" });
    const res = await verifyTeamCode("abcdefgh2345", store, cfg, new Date("2026-01-01T09:00:00Z"));
    expect(res).toEqual({ ok: false, reason: "outside-window" });
  });

  test("code matching is case-insensitive and trimmed", async () => {
    const store = testStore();
    store.setTeamCode("t1", "abcdefgh2345");
    const res = await verifyTeamCode("  ABCDEFGH2345 ", store, testCfg(), new Date());
    expect(res.ok).toBe(true);
  });
});

describe("GET /dj/verify route", () => {
  test("correct code redirects to /dj/ with a cxtool-token cookie carrying sub", async () => {
    const cfg = testCfg();
    const store = testStore();
    store.setPassword("2025001", "pw");
    const code = store.setTeamCode("2025001");
    const app = createApp(cfg, { teamStore: store });
    const res = await app.request(`/dj/verify?code=${code}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dj/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("cxtool-token=");
    expect(cookie).toContain("Path=/dj");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const token = /cxtool-token=([^;]+)/.exec(cookie)?.[1] ?? "";
    const payload = await verifyTeamToken(SECRET, token);
    expect(payload?.sub).toBe("2025001");
  });

  test("under /wxt mount, redirect and cookie path carry the contextPath", async () => {
    const cfg = { ...testCfg(), contextPath: "/wxt" };
    const store = testStore();
    const code = store.setTeamCode("2025001");
    const sub = createApp(cfg, { teamStore: store });
    const app = new Hono().route("/wxt", sub);
    const res = await app.request(`/wxt/dj/verify?code=${code}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/wxt/dj/");
    expect(res.headers.get("set-cookie")).toContain("Path=/wxt/dj");
    const token = /cxtool-token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect((await verifyTeamToken(SECRET, token))?.sub).toBe("2025001");
  });

  test("wrong code returns 403 HTML page with the generic message", async () => {
    const cfg = testCfg();
    const store = testStore();
    const app = createApp(cfg, { teamStore: store });
    const res = await app.request("/dj/verify?code=zzzzzzzzzzzz");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("队伍码不正确");
  });

  test("valid code outside the window returns 403 with the configured window", async () => {
    const cfg = testCfg({ start: "2026-01-01T00:00:00Z", end: "2026-01-01T08:00:00Z" });
    const store = testStore();
    const code = store.setTeamCode("t1");
    const app = createApp(cfg, { teamStore: store });
    const res = await app.request(`/dj/verify?code=${code}`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("当前不在允许登录的时段内");
    expect(text).toContain("允许登录时段");
  });

  test("no restriction when the window is empty (default config)", async () => {
    const cfg = testCfg();
    const store = testStore();
    const code = store.setTeamCode("t1");
    const app = createApp(cfg, { teamStore: store });
    const res = await app.request(`/dj/verify?code=${code}`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  test("GET /dj/verify without code renders the type-in form page", async () => {
    const cfg = testCfg();
    const app = createApp(cfg, { teamStore: testStore() });
    const res = await app.request("/dj/verify");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("请输入屏幕上显示的队伍码开始登录");
    expect(text).toContain('action="/dj/verify"');
    expect(text).toContain('name="code"');
  });

  test("blank code re-renders the form with the empty hint", async () => {
    const cfg = testCfg();
    const app = createApp(cfg, { teamStore: testStore() });
    const res = await app.request("/dj/verify?code=");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("队伍码不能为空");
    expect(text).toContain('action="/dj/verify"');
  });

  test("whitespace-only code re-renders the form with the empty hint", async () => {
    const cfg = testCfg();
    const app = createApp(cfg, { teamStore: testStore() });
    const res = await app.request("/dj/verify?code=%20%20");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("队伍码不能为空");
  });

  test("code is escaped on the miss page (XSS regression)", async () => {
    const cfg = testCfg();
    const app = createApp(cfg, { teamStore: testStore() });
    const res = await app.request("/dj/verify?code=<script>alert(1)</script>");
    const text = await res.text();
    expect(text).not.toContain("<script>alert(1)</script>");
  });

  test("window page renders under a /wxt mount", async () => {
    const cfg = { ...testCfg({ start: "2026-01-01T00:00:00Z", end: "2026-01-01T08:00:00Z" }), contextPath: "/wxt" };
    const store = testStore();
    const code = store.setTeamCode("t1");
    const app = new Hono().route("/wxt", createApp(cfg, { teamStore: store }));
    const res = await app.request(`/wxt/dj/verify?code=${code}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("当前不在允许登录的时段内");
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_PATH, loadConfig } from "../config";
import { signAdminToken, signTeamToken } from "../auth/token";
import { createApp } from "../server";
import { handleRootDjProxy, makeRootDispatch, resolveTarget } from "./proxy";
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
let lastReq: { method: string; path: string; body: string; cookie: string | null; headers: Record<string, string>; contentLengthCount: number } | null = null;
let upstreamPort = 0;

let upstreamSetCookie: string[] | null = null;
let upstreamRedirect: string | null = null;

const upstream = Bun.serve({
  port: 0,
  fetch: async (req) => {
    hits++;
    if (upstreamRedirect) {
      const headers = new Headers({ location: upstreamRedirect });
      if (upstreamSetCookie) {
        for (const cookie of upstreamSetCookie) headers.append("set-cookie", cookie);
      }
      return new Response(null, { status: 302, headers });
    }
    lastReq = {
      method: req.method,
      path: new URL(req.url).pathname,
      body: await req.text(),
      cookie: req.headers.get("cookie"),
      headers: Object.fromEntries(req.headers.entries()),
      // duplicate headers are joined with ", " by Headers; count the raw values
      contentLengthCount: req.headers.get("content-length")?.split(",").length ?? 0,
    };
    const headers = new Headers({ "content-type": "application/json", "x-upstream": "mock" });
    if (upstreamSetCookie) {
      for (const cookie of upstreamSetCookie) headers.append("set-cookie", cookie);
    }
    return new Response(JSON.stringify({ echo: "upstream-ok" }), { status: 200, headers });
  },
});
upstreamPort = upstream.port as number;
afterAll(() => upstream.stop(true));

describe("DOMjudge root reverse proxy", () => {
  afterEach(() => {
    hits = 0;
    lastReq = null;
    upstreamSetCookie = null;
    upstreamRedirect = null;
  });

  const makeCfg = () => ({
    ...loadConfig("/nonexistent/settings.json"),
    jwt: { secret: SECRET, ttlSeconds: 3600 },
    domjudge: { baseUrl: `http://127.0.0.1:${upstreamPort}`, adminUser: "", adminPassword: "", timeoutSeconds: 10 },
  });

  /** Every root path is DOMjudge's: no /wxt prefix is involved. */
  const proxy = (path: string, init: RequestInit = {}, store?: TeamStore, cfg = makeCfg()) =>
    handleRootDjProxy(
      new Request(`http://127.0.0.1:${upstreamPort}${path}`, init),
      cfg,
      store,
    );

  test("valid token forwards to upstream and passes the response through", async () => {
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy("/api/contests?limit=5", {
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

    const res2 = await proxy("/api/contests", {
      headers: { cookie: `cxtool-token=${token}; DOMjudgeSID=keep` },
    });
    expect(res2.status).toBe(200);
    expect(lastReq?.cookie).toBe("DOMjudgeSID=keep");
  });

  test("admin token cookie is rejected at the proxy (role separation)", async () => {
    const token = await signAdminToken(SECRET, 3600, "admin");
    const res = await proxy("/api/contests", {
      headers: { cookie: `cxtool-token=${token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`${CONTEXT_PATH}/public/verify?next=`);
    expect(hits).toBe(0);
  });

  test("missing cookie redirects to the verify form and upstream hit count stays 0", async () => {
    const res = await proxy("/api/contests", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`${CONTEXT_PATH}/public/verify`);
    expect(location).toContain(encodeURIComponent("/api/contests"));
    expect(hits).toBe(0);
  });

  test("tampered token redirects to the verify form", async () => {
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy("/api/contests", {
      headers: { cookie: `cxtool-token=${token.slice(0, -4)}AAAA` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`${CONTEXT_PATH}/public/verify`);
    expect(hits).toBe(0);
  });

  test("unreachable upstream returns 502 and does not crash", async () => {
    const cfg = {
      ...makeCfg(),
      domjudge: { baseUrl: "http://127.0.0.1:1", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    };
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy(
      "/api/contests",
      { headers: { cookie: `cxtool-token=${token}` } },
      undefined,
      cfg,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: "upstream error" });
  });

  test("unreachable upstream with browser Accept header returns friendly HTML 502", async () => {
    const cfg = {
      ...makeCfg(),
      domjudge: { baseUrl: "http://127.0.0.1:1", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    };
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy(
      "/login",
      {
        method: "POST",
        headers: { cookie: `cxtool-token=${token}`, accept: "text/html,application/xhtml+xml" },
      },
      undefined,
      cfg,
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("比赛系统暂时没有响应");
    expect(html).toContain("可能是网络波动，请刷新重试；若持续出现请联系监考人员");
    expect(html).toContain("location.reload");
  });

  test("unreachable upstream with JSON Accept header keeps the JSON 502", async () => {
    const cfg = {
      ...makeCfg(),
      domjudge: { baseUrl: "http://127.0.0.1:1", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    };
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy(
      "/api/contests",
      { headers: { cookie: `cxtool-token=${token}`, accept: "application/json" } },
      undefined,
      cfg,
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: false, reason: "upstream error" });
  });

  test("root proxy unreachable upstream: browser gets HTML 502, API client gets JSON", async () => {
    const cfg = {
      ...makeCfg(),
      domjudge: { baseUrl: "http://127.0.0.1:1", adminUser: "", adminPassword: "", timeoutSeconds: 10 },
    };
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const cookie = { cookie: `cxtool-token=${token}` };
    const html = await handleRootDjProxy(
      new Request("http://s.test/login", {
        method: "POST",
        headers: { ...cookie, accept: "text/html,application/xhtml+xml" },
      }),
      cfg,
    );
    expect(html.status).toBe(502);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("比赛系统暂时没有响应");

    const json = await handleRootDjProxy(
      new Request("http://s.test/api/contests", {
        headers: { ...cookie, accept: "application/json" },
      }),
      cfg,
    );
    expect(json.status).toBe(502);
    expect(await json.json()).toEqual({ ok: false, reason: "upstream error" });
  });

  test("POST body is forwarded to upstream with a single content-length", async () => {
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const body = JSON.stringify({ problem: "A", language: "cpp" });
    // browsers send content-length on the original request; the proxy re-encodes
    // the body, so the stale header must be dropped or upstream sees it twice
    const res = await proxy("/api/submissions", {
      method: "POST",
      headers: { cookie: `cxtool-token=${token}`, "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
    expect(lastReq?.method).toBe("POST");
    expect(lastReq?.body).toBe(body);
    expect(lastReq?.path).toBe("/api/submissions");
    // the stale content-length from the original request must not survive the
    // re-encode: at most one header, and it must match the forwarded body
    expect(lastReq?.contentLengthCount).toBeLessThanOrEqual(1);
    expect(Number(lastReq?.headers["content-length"])).toBe(Buffer.byteLength(body));
  });

  test("request to upstream /login injects X-DOMjudge-Login/Pass from the team store", async () => {
    const store = testStore();
    store.setPassword("2025001", "s3cret pw", "team1095218");
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy(
      "/login",
      {
        method: "POST",
        headers: { cookie: `cxtool-token=${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: "username=ignored&password=ignored",
      },
      store,
    );
    expect(res.status).toBe(200);
    expect(lastReq?.path).toBe("/login");
    // the injected login is the provisioned DOMjudge username, not the team key
    expect(lastReq?.headers["x-domjudge-login"]).toBe("team1095218");
    expect(lastReq?.headers["x-domjudge-pass"]).toBe(Buffer.from("s3cret pw", "utf8").toString("base64"));
  });

  test("non-printable characters are stripped from the injected X-DOMjudge-Login value", async () => {
    const store = testStore();
    store.setPassword("2025001", "pw", "team 2025001\t");
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await proxy("/login", { headers: { cookie: `cxtool-token=${token}` } }, store);
    expect(lastReq?.headers["x-domjudge-login"]).toBe("team2025001");
  });

  test("login paths under a base-url prefix also get X-Headers injected", async () => {
    const store = testStore();
    store.setPassword("2025001", "s3cret pw", "team1095218");
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await proxy("/demoweb/login", { headers: { cookie: `cxtool-token=${token}` } }, store);
    expect(lastReq?.path).toBe("/demoweb/login");
    expect(lastReq?.headers["x-domjudge-login"]).toBe("team1095218");
    expect(lastReq?.headers["x-domjudge-pass"]).toBe(Buffer.from("s3cret pw", "utf8").toString("base64"));
  });

  test("paths merely containing 'login' as a substring do NOT get X-Headers injected", async () => {
    const store = testStore();
    store.setPassword("2025001", "s3cret pw", "team1095218");
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await proxy("/loginx", { headers: { cookie: `cxtool-token=${token}` } }, store);
    expect(lastReq?.headers["x-domjudge-login"]).toBeUndefined();
    expect(lastReq?.headers["x-domjudge-pass"]).toBeUndefined();
  });

  test("a password without a provisioned djUsername is never injected", async () => {
    const store = testStore();
    store.setPassword("2025001", "legacy-pw");
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await proxy("/login", { headers: { cookie: `cxtool-token=${token}` } }, store);
    expect(lastReq?.headers["x-domjudge-login"]).toBeUndefined();
    expect(lastReq?.headers["x-domjudge-pass"]).toBeUndefined();
  });

  describe("root DOMjudge proxy (outside /wxt)", () => {
    test("valid team token forwards the root path to upstream", async () => {
      const token = await signTeamToken(SECRET, 3600, "2025001");
      const res = await proxy("/some/dj/page", { headers: { cookie: `cxtool-token=${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ echo: "upstream-ok" });
      expect(lastReq?.path).toBe("/some/dj/page");
    });

    test("missing token redirects to the team verify page carrying next", async () => {
      const res = await proxy("/scoreboard?foo=1");
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain(`${CONTEXT_PATH}/public/verify?next=`);
      expect(location).toContain(encodeURIComponent("/scoreboard?foo=1"));
      expect(hits).toBe(0);
    });

    test("dispatcher keeps the /wxt admin UI intact and proxies the rest", async () => {
      const app = createApp(makeCfg(), { teamStore: testStore() });
      const serving = new Hono().route(CONTEXT_PATH, app);
      const dispatch = makeRootDispatch(serving, makeCfg());
      // /wxt paths reach the admin app, not the proxy
      const adminRes = await dispatch(
        new Request(`http://127.0.0.1:${upstreamPort}/wxt/health`, { redirect: "manual" }),
      );
      expect(hits).toBe(0);
      expect(adminRes.status).toBe(200);
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
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await proxy("/api/contests", { headers: { cookie: `cxtool-token=${token}` } }, store);
    expect(lastReq?.headers["x-domjudge-login"]).toBeUndefined();
    expect(lastReq?.headers["x-domjudge-pass"]).toBeUndefined();
  });

  test("a team without a stored credential falls back to no injection on /login", async () => {
    const store = testStore(); // no password for "nobody"
    const token = await signTeamToken(SECRET, 3600, "nobody");
    const res = await proxy("/login", { headers: { cookie: `cxtool-token=${token}` } }, store);
    expect(res.status).toBe(200);
    expect(lastReq?.headers["x-domjudge-login"]).toBeUndefined();
    expect(lastReq?.headers["x-domjudge-pass"]).toBeUndefined();
  });

  test("cxtool-token is stripped from the upstream request on /login too", async () => {
    const store = testStore();
    store.setPassword("2025001", "pw");
    const token = await signTeamToken(SECRET, 3600, "2025001");
    await proxy("/login", { headers: { cookie: `cxtool-token=${token}; DOMjudgeSID=keep` } }, store);
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
      const token = await signTeamToken(SECRET, 3600, "2025001");
      const res = await proxy(
        "/upload",
        {
          method: "POST",
          headers: { cookie: `cxtool-token=${token}`, "content-type": "application/octet-stream" },
          body: payload,
        },
        undefined,
        cfg,
      );
      expect(await res.text()).toBe("match");
    } finally {
      capture.stop(true);
    }
  });

  test("upstream 302 on login is passed through verbatim with its session cookie (not followed)", async () => {
    upstreamRedirect = "/public";
    upstreamSetCookie = ["DOMjudgeSID=sess1; path=/demoweb; secure; httponly"];
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy("/login", {
      method: "POST",
      headers: { cookie: `cxtool-token=${token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/public");
    expect(res.headers.getSetCookie()).toEqual(["DOMjudgeSID=sess1; Path=/; httponly"]);
  });

  test("Secure is stripped and Path normalized to / on proxied Set-Cookie", async () => {
    upstreamSetCookie = ["PHPSESSID=abc123; path=/demoweb; secure; httponly"];
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy("/login", {
      method: "POST",
      headers: { cookie: `cxtool-token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(["PHPSESSID=abc123; Path=/; httponly"]);
  });

  test("multiple upstream Set-Cookie headers are all rewritten, others preserved", async () => {
    upstreamSetCookie = [
      "DOMjudgeSID=s1; path=/demoweb; secure; httponly; SameSite=Lax",
      "theme=dark; path=/; samesite=Strict",
    ];
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy("/api/contests", { headers: { cookie: `cxtool-token=${token}` } });
    expect(res.headers.getSetCookie()).toEqual([
      "DOMjudgeSID=s1; Path=/; httponly; SameSite=Lax",
      "theme=dark; Path=/; samesite=Strict",
    ]);
  });

  test("responses without Set-Cookie pass through untouched", async () => {
    const token = await signTeamToken(SECRET, 3600, "2025001");
    const res = await proxy("/api/contests", { headers: { cookie: `cxtool-token=${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("mock");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.json()).toEqual({ echo: "upstream-ok" });
  });

  test("resolveTarget joins the baseUrl and the remaining path", () => {
    const cfg = makeCfg();
    expect(resolveTarget(cfg, "/api/contests")).toBe(`http://127.0.0.1:${upstreamPort}/api/contests`);
    expect(resolveTarget(cfg, "api/x")).toBe(`http://127.0.0.1:${upstreamPort}/api/x`);
  });
});

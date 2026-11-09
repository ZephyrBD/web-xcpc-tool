import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { hashSync } from "bcryptjs";
import { loadConfig } from "./config";
import { createApp, resolveStaticDir } from "./server";
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
import { LoginRequestStore } from "./auth/loginRequests";
import { ConfigStore } from "./store/configStore";

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

  // ack is async (domjudge balloon sync); an unknown id must still 404, not 200 {}.
  test("balloon ack for unknown id returns 404", async () => {
    const cfg = loadConfigWithSecret();
    const bus = new SseBus();
    const balloonService = new BalloonService({
      client: {} as DjClient,
      store: new JsonStore(join(dataDir, "balloon-tasks-404.json"), []),
      bus,
      contestId: "C1",
      pollIntervalSeconds: 30,
      schedule: () => {},
    });
    const app = createApp(cfg, { dataDir, balloonService });

    const res = await app.request("/admin/api/balloon-tasks/unknown/ack", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("login approval flow (outside the login window)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "server-approval-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // end in the past → the window is permanently closed for these tests.
  const makeCfg = () => ({
    ...loadConfigWithSecret(),
    contextPath: "",
    teamLogin: { start: "", end: "2000-01-01T00:00:00Z" },
  });

  const setup = () => {
    const teamStore = makeTeamStore(dataDir);
    const teamCode = teamStore.setTeamCode("icpc1");
    const loginRequests = new LoginRequestStore(join(dataDir, "login-requests.json"));
    const bus = new SseBus();
    const app = createApp(makeCfg(), { dataDir, teamStore, loginRequests, bus });
    return { app, teamCode, loginRequests, bus };
  };

  test("correct code outside the window returns the waiting page and creates one pending request", async () => {
    const { app, teamCode, loginRequests } = setup();
    const res = await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const pending = loginRequests.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].icpcId).toBe("icpc1");
    expect(await res.text()).toContain(pending[0].id);
    // resubmitting the same team code reuses the existing pending request
    await app.request(`/dj/verify?code=${teamCode}`);
    expect(loginRequests.listAll().length).toBe(1);
  });

  test("approved request claims a token exactly once; a replayed claim is 403", async () => {
    const { app, teamCode, loginRequests } = setup();
    await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    const id = loginRequests.listPending()[0].id;

    const statusRes = await app.request(`/dj/verify/status?req=${id}`);
    expect(await statusRes.json()).toEqual({ status: "pending" });
    expect(loginRequests.decide(id, "approved")?.status).toBe("approved");

    const claim = await app.request(`/dj/verify/claim?req=${id}`, { redirect: "manual" });
    expect(claim.status).toBe(302);
    expect(claim.headers.get("location")).toBe("/dj/");
    const setCookie = claim.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("cxtool-token=");
    expect(setCookie).toContain("Path=/; HttpOnly; SameSite=Lax");
    const token = /cxtool-token=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect((await verifyTeamToken("test-secret", token))?.sub).toBe("icpc1");

    const again = await app.request(`/dj/verify/claim?req=${id}`, { redirect: "manual" });
    expect(again.status).toBe(403);
    expect(await again.text()).toContain("队伍登录");
  });

  test("a rejected request cannot claim and the status poll reports it", async () => {
    const { app, teamCode, loginRequests } = setup();
    await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    const id = loginRequests.listPending()[0].id;
    loginRequests.decide(id, "rejected");

    const statusRes = await app.request(`/dj/verify/status?req=${id}`);
    expect(await statusRes.json()).toEqual({ status: "rejected" });
    const claim = await app.request(`/dj/verify/claim?req=${id}`, { redirect: "manual" });
    expect(claim.status).toBe(403);
    expect(claim.headers.get("set-cookie")).toBeNull();
  });

  test("waiting page keeps a deep-link next value in the poll JS and claim honors it", async () => {
    const { app, teamCode, loginRequests } = setup();
    // encodeURIComponent escapes every ? & = / here — the JS literal must hold
    // the encoded form as-is (HTML entities would corrupt the claim URL).
    const next = "/scoreboard?tab=full&x=1";
    const res = await app.request(
      `/dj/verify?code=${teamCode}&next=${encodeURIComponent(next)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&next=%2Fscoreboard%3Ftab%3Dfull%26x%3D1");
    expect(html).not.toContain("&amp;next=");
    const id = loginRequests.listPending()[0].id;
    loginRequests.decide(id, "approved");
    const claim = await app.request(
      `/dj/verify/claim?req=${id}&next=${encodeURIComponent(next)}`,
      { redirect: "manual" },
    );
    expect(claim.status).toBe(302);
    expect(claim.headers.get("location")).toBe(next);
  });

  test("wrong code outside the window still returns the 403 miss page and creates no request", async () => {
    const { app, loginRequests } = setup();
    const res = await app.request("/dj/verify?code=zzzzzzzzzzzz");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("队伍码不正确");
    expect(loginRequests.listAll().length).toBe(0);
  });

  test("inside the login window no approval request is ever created", async () => {
    const teamStore = makeTeamStore(dataDir);
    const teamCode = teamStore.setTeamCode("icpc1");
    const loginRequests = new LoginRequestStore(join(dataDir, "login-requests.json"));
    const cfg = { ...loadConfigWithSecret(), contextPath: "", teamLogin: { start: "", end: "" } };
    const app = createApp(cfg, { dataDir, teamStore, loginRequests });

    const res = await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(loginRequests.listAll().length).toBe(0);
  });
});

describe("settings hot reload", () => {
  let dataDir: string;
  /** bcrypt hash of "live-pass": stands in for a password bootstrapped at boot. */
  const liveHash = hashSync("live-pass", 4);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "server-hot-reload-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a PUT that closes the login window takes effect on the same app instance", async () => {
    const store = new ConfigStore({ ...loadConfigWithSecret(), contextPath: "", teamLogin: { start: "", end: "" } });
    const teamStore = makeTeamStore(dataDir);
    const teamCode = teamStore.setTeamCode("icpc1");
    const loginRequests = new LoginRequestStore(join(dataDir, "login-requests.json"));
    const app = createApp(store, { dataDir, teamStore, loginRequests });

    // Window open: the valid code logs in directly.
    const open = await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    expect(open.status).toBe(302);
    expect(loginRequests.listAll().length).toBe(0);

    // Close the window in the past through the admin API (same instance).
    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(store.current),
      body: JSON.stringify({ teamLogin: { start: "", end: "2000-01-01T00:00:00Z" } }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { note?: string }).note).toBe("已保存，立即生效");

    const closed = await app.request(`/dj/verify?code=${teamCode}`, { redirect: "manual" });
    expect(closed.status).toBe(200);
    expect(await closed.text()).toContain("等待管理员审批");
    expect(loginRequests.listPending().length).toBe(1);

    // GET reflects the live values too.
    const view = await (await app.request("/admin/api/settings", { headers: await adminAuthHeaders(store.current) })).json();
    expect((view as { teamLogin: unknown }).teamLogin).toEqual({ start: "", end: "2000-01-01T00:00:00Z" });
  });

  test("a ConfigStore passed to createApp is updated in place by a PUT", async () => {
    const store = new ConfigStore({ ...loadConfigWithSecret(), contextPath: "", teamLogin: { start: "", end: "" } });
    const app = createApp(store, { dataDir });
    const changes: string[] = [];
    store.onChange((next) => changes.push(next.teamLogin.end));

    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(store.current),
      body: JSON.stringify({ teamLogin: { end: "2001-01-01T00:00:00Z" } }),
    });
    expect(put.status).toBe(200);
    expect(store.current.teamLogin.end).toBe("2001-01-01T00:00:00Z");
    expect(changes).toEqual(["2001-01-01T00:00:00Z"]);
  });

  test("replacing print.token hot-reloads the print callback auth", async () => {
    const store = new ConfigStore({ ...loadConfigWithSecret(), contextPath: "", print: { token: "old-token" } });
    const app = createApp(store, { dataDir });

    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(store.current),
      body: JSON.stringify({ print: { token: "new-token" } }),
    });
    expect(put.status).toBe(200);

    const form = () => {
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("%PDF-1.4 test")], "a.pdf"));
      return fd;
    };
    const stale = await app.request("/dj/print", { method: "POST", headers: { "org.domjudge.print-token": "old-token" }, body: form() });
    expect(stale.status).toBe(403);
    const fresh = await app.request("/dj/print", { method: "POST", headers: { "org.domjudge.print-token": "new-token" }, body: form() });
    expect(fresh.status).toBe(200);
  });

  test("an admin password change is usable for login on the same instance", async () => {
    const store = new ConfigStore({
      ...loadConfigWithSecret(),
      contextPath: "",
      admin: { username: "admin", passwordHash: "", sessionTtlSeconds: 28800 },
    });
    const app = createApp(store, { dataDir });
    // No hash configured yet → bootstrap one via PUT with a known password.
    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(store.current),
      body: JSON.stringify({ admin: { password: "brand-new-pass", username: "chief" } }),
    });
    expect(put.status).toBe(200);
    const login = await app.request("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "chief", password: "brand-new-pass" }),
    });
    expect(login.status).toBe(200);
  });

  test("an unrelated PUT cannot wipe a live admin password when settings.json lacks the admin block", async () => {
    // settings.json is hand-maintained in the field: a partial file (generated
    // by an older build, or edited by hand) has no admin block. The disk value
    // must not overwrite the live hash that the running process bootstrapped.
    const cfg = {
      ...loadConfigWithSecret(),
      contextPath: "",
      admin: { username: "admin", passwordHash: "", password: undefined, sessionTtlSeconds: 28800 },
    };
    writeFileSync(
      join(dataDir, "settings.json"),
      JSON.stringify({ port: 8080, contextPath: "", teamLogin: { start: "", end: "" } }),
    );
    // The live config carries a real bcrypt hash (as ensureAdminPassword would
    // have produced at boot), the file does not.
    const store = new ConfigStore({ ...cfg, admin: { ...cfg.admin, passwordHash: liveHash, password: "live-pass" } });
    const app = createApp(store, { dataDir });
    const headers = await adminAuthHeaders(store.current);

    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ balloon: { contestId: "contest-x" } }),
    });
    expect(put.status).toBe(200);
    expect(store.current.balloon.contestId).toBe("contest-x");
    // The live admin block survives the merge instead of being blanked out.
    expect(store.current.admin.passwordHash).toBe(liveHash);
    expect(store.current.admin.username).toBe("admin");
    // …and the running password still logs in.
    const login = await app.request("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "live-pass" }),
    });
    expect(login.status).toBe(200);
    // The on-disk file is rewritten with the restored block, so a later restart
    // keeps the operator logged in with the same password.
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.admin.passwordHash).toBe(liveHash);
    expect(saved.balloon.contestId).toBe("contest-x");
  });

  test("a username-only PUT keeps the stored password and is not reverted by the partial-file guard", async () => {
    // Real-world shape: settings.json on disk has no admin block (older build /
    // hand-edited), while the running process bootstrapped a hash at startup.
    // A rename must land, and the guard must backfill only the hash — never the
    // old username, which is what spreading the whole live block would do.
    const diskCfg = {
      ...loadConfigWithSecret(),
      contextPath: "",
      admin: { username: "admin", passwordHash: "", sessionTtlSeconds: 28800 },
    };
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(diskCfg));
    const store = new ConfigStore({ ...diskCfg, admin: { ...diskCfg.admin, passwordHash: liveHash, password: "live-pass" } });
    const app = createApp(store, { dataDir });

    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(store.current),
      body: JSON.stringify({ admin: { username: "chief" } }),
    });
    expect(put.status).toBe(200);
    expect(store.current.admin.username).toBe("chief");
    expect(store.current.admin.passwordHash).toBe(liveHash);
    // The old password still works under the new username.
    const login = await app.request("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "chief", password: "live-pass" }),
    });
    expect(login.status).toBe(200);
    // …and the rename is what is persisted, not the previous username.
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.admin.username).toBe("chief");
    expect(saved.admin.passwordHash).toBe(liveHash);
    expect(saved.admin.password).toBe("live-pass");
  });
  test("a username-only PUT on a complete settings.json keeps the stored password", async () => {
    // Same assertion against the steady-state file (hash already on disk): the
    // guard is a no-op here and the rename must simply work.
    const diskCfg = {
      ...loadConfigWithSecret(),
      contextPath: "",
      admin: { username: "admin", passwordHash: liveHash, password: "live-pass", sessionTtlSeconds: 28800 },
    };
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(diskCfg));
    const store = new ConfigStore(diskCfg);
    const app = createApp(store, { dataDir });

    const put = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(store.current),
      body: JSON.stringify({ admin: { username: "chief" } }),
    });
    expect(put.status).toBe(200);
    expect(store.current.admin.username).toBe("chief");
    expect(store.current.admin.passwordHash).toBe(liveHash);
    const login = await app.request("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "chief", password: "live-pass" }),
    });
    expect(login.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.admin.username).toBe("chief");
    expect(saved.admin.passwordHash).toBe(liveHash);
  });
});

describe("admin login-request review API", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "server-login-req-api-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const makeCfg = () => ({
    ...loadConfigWithSecret(),
    contextPath: "",
    teamLogin: { start: "", end: "2000-01-01T00:00:00Z" },
  });

  /** Two teams so the "recent" ordering (requestedAt desc) is meaningful. */
  const setup = () => {
    const teamStore = makeTeamStore(dataDir);
    const code1 = teamStore.setTeamCode("icpc1");
    const code2 = teamStore.setTeamCode("icpc2");
    const loginRequests = new LoginRequestStore(join(dataDir, "login-requests.json"));
    const bus = new SseBus();
    const cfg = makeCfg();
    const app = createApp(cfg, { dataDir, teamStore, loginRequests, bus });
    const teamLogin = (code: string) => app.request(`/dj/verify?code=${code}`, { redirect: "manual" });
    const auth = () => adminAuthHeaders(cfg);
    const decide = async (id: string, decision: unknown) =>
      app.request(`/admin/api/login-requests/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth()) },
        body: JSON.stringify({ decision }),
      });
    return { app, cfg, teamStore, loginRequests, bus, code1, code2, teamLogin, auth, decide };
  };

  test("both endpoints reject unauthenticated requests with 401", async () => {
    const { app } = setup();
    const list = await app.request("/admin/api/login-requests");
    expect(list.status).toBe(401);
    const post = await app.request("/admin/api/login-requests/any/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(post.status).toBe(401);
  });

  test("GET returns pending and recent lists; decisions move requests to recent, newest first", async () => {
    const { app, teamLogin, auth, decide, code1, code2, loginRequests } = setup();
    await teamLogin(code1);
    await teamLogin(code2);
    const [r2, r1] = loginRequests.listPending(); // store prepends: newest first
    expect(r1.icpcId).toBe("icpc1");
    expect(r2.icpcId).toBe("icpc2");

    const initial = await (await app.request("/admin/api/login-requests", { headers: await auth() })).json();
    expect(initial.pending.map((r: { icpcId: string }) => r.icpcId).sort()).toEqual(["icpc1", "icpc2"]);
    expect(initial.recent).toEqual([]);

    const approvedRes = await decide(r1.id, "approved");
    expect(approvedRes.status).toBe(200);
    const approved = await approvedRes.json();
    expect(approved.id).toBe(r1.id);
    expect(approved.status).toBe("approved");
    expect(typeof approved.decidedAt).toBe("string");
    await decide(r2.id, "rejected");

    const after = await (await app.request("/admin/api/login-requests", { headers: await auth() })).json();
    expect(after.pending).toEqual([]);
    // both are stamped "now", so ordering is decided by requestedAt desc; r2 was created last.
    expect(after.recent.map((r: { icpcId: string }) => r.icpcId)).toEqual(["icpc2", "icpc1"]);
    const times = after.recent.map((r: { requestedAt: string }) => Date.parse(r.requestedAt));
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
  });

  test("recent is capped at 50 and holds every decided request, claimed included", async () => {
    const { app, auth, loginRequests } = setup();
    // 55 decided + 1 still pending; seeding the store directly keeps this fast.
    for (let i = 0; i < 55; i++) {
      const r = loginRequests.create({ icpcId: `icpc${i}`, teamCode: `code${i}`, teamName: `Team ${i}`, ip: null });
      loginRequests.decide(r.id, i % 2 === 0 ? "approved" : "rejected");
    }
    loginRequests.create({ icpcId: "pending-team", teamCode: "pending-code", teamName: "Pending", ip: null });
    // A claimed (already consumed) request stays in history: it is decided, not pending.
    const claimed = loginRequests.create({ icpcId: "claimed-team", teamCode: "claimed-code", teamName: "Claimed", ip: null });
    loginRequests.decide(claimed.id, "approved");
    loginRequests.consume(claimed.id);

    const body = await (await app.request("/admin/api/login-requests", { headers: await auth() })).json();
    expect(body.pending.length).toBe(1);
    expect(body.pending[0].icpcId).toBe("pending-team");
    // 56 decided entries, newest (the claimed one) first, capped at 50.
    expect(body.recent.length).toBe(50);
    expect(body.recent[0]).toMatchObject({ icpcId: "claimed-team", status: "claimed" });
    expect(body.recent.every((r: { status: string }) => r.status !== "pending")).toBe(true);
  });

  test("decision on an unknown id is 404 and a bad decision value is 400", async () => {
    const { teamLogin, decide, code1, loginRequests } = setup();
    await teamLogin(code1);
    const id = loginRequests.listPending()[0].id;

    expect((await decide("no-such-request", "approved")).status).toBe(404);
    for (const bad of ["pending", "claimed", "", 42, null]) {
      const res = await decide(id, bad);
      expect(res.status).toBe(400);
    }
    // no bad decision leaked through: the request is still pending
    expect(loginRequests.get(id)?.status).toBe("pending");

    const okRes = await decide(id, "rejected");
    expect((await okRes.json()).status).toBe("rejected");
    // already decided: the store only mutates pending requests, so the
    // request is unchanged and there is no pending request left to decide
    expect((await decide(id, "approved")).status).toBe(404);
    expect(loginRequests.get(id)?.status).toBe("rejected");
  });

  test("a new approval request publishes a login-request event on the admin channel", async () => {
    const { app, bus, teamLogin, code1, code2, loginRequests } = setup();
    const events: Array<{ event: string; data: unknown }> = [];
    const off = bus.subscribe("admin", (e) => events.push(e));

    await teamLogin(code1);
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("login-request");
    expect(events[0].data).toMatchObject({ icpcId: "icpc1", status: "pending" });

    // re-submitting the same code reuses the pending request → no second event
    await teamLogin(code1);
    expect(events.length).toBe(1);
    // …but another team's request does publish
    await teamLogin(code2);
    expect(events.length).toBe(2);

    // wrong codes never reach the approval store
    await teamLogin("zzzzzzzzzzzz");
    expect(events.length).toBe(2);
    expect(loginRequests.listAll().length).toBe(2);
    off();
  });

  test("the admin SSE stream carries the login-request event", async () => {
    const { app, cfg, teamLogin, code1 } = setup();
    const token = (await adminAuthHeaders(cfg)).authorization.slice("Bearer ".length);
    const controller = new AbortController();
    const res = await app.request(`/admin/api/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    await teamLogin(code1);
    const reader = res.body!.getReader();
    let text = "";
    // The ping frame is written first, so the login-request frame follows it.
    while (!text.includes("login-request")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain("event: login-request");
    expect(text).toContain(`"icpcId":"icpc1"`);
  });
});

const TEAMS_JSON = [
  { id: "t1", icpc_id: "icpc1", name: "Team X", location: { description: "A-101" } },
];
const PROBLEMS_JSON = [{ id: "p1", label: "A", name: "Alpha" }];
const BALLOONS_JSON = [
  { balloonid: "b1", teamid: "t1", problem: "p1", contestproblem: { id: "p1", label: "A" }, done: false },
];
const CONTEST_API: Record<string, unknown> = {
  "/api/v4/contests/C1/teams": TEAMS_JSON,
  "/api/v4/contests/C1/problems": PROBLEMS_JSON,
  // Balloon tasks come from this endpoint only (Task 4); the judgements /
  // submissions entries stay so any accidental synthesis would still show.
  "/api/v4/contests/C1/balloons": BALLOONS_JSON,
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
    expect(setCookie).toContain("Path=/");
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

  test("team sync refreshes the balloon service team lookups", async () => {
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

    // pollOnce reads the balloons API and resolves team name/location plus the
    // contestproblem label from the local team table.
    const created = await balloonService.pollOnce();
    expect(created).toBe(1);
    const tasks = await (await app.request("/admin/api/balloon-tasks", { headers: await adminAuthHeaders(cfg) })).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({
      id: "b1",
      teamName: "Team X",
      problemLabel: "A",
      location: "A-101",
      status: "pending",
    });
  });

  // Old behaviour synthesized tasks from AC judgements; Task 4 reads DOMjudge's
  // balloons API instead, so a problems-endpoint failure cannot affect them
  // (there is no label mapping left to silently skip) and the failed endpoint
  // is simply never called.
  test("team sync tolerates a problems endpoint failure without touching balloon tasks", async () => {
    const cfg = makeCfg();
    let problemsCalled = 0;
    const client = {
      getTeams: async () => TEAMS_JSON,
      getProblems: async () => {
        problemsCalled++;
        throw new Error("problems endpoint down");
      },
      getBalloons: async () => BALLOONS_JSON,
      getJudgements: async () => {
        throw new Error("balloon tasks must not be synthesized from judgements");
      },
      getSubmissions: async () => {
        throw new Error("balloon tasks must not be synthesized from submissions");
      },
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
    expect(await syncRes.json()).toEqual({ count: 1 });
    expect(problemsCalled).toBe(0);

    const created = await balloonService.pollOnce();
    expect(created).toBe(1);
    expect(balloonService.list()[0]).toMatchObject({ id: "b1", problemLabel: "A", teamName: "Team X" });
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

describe("resolveStaticDir fallback chain", () => {
  const makeDirs = () => {
    const root = mkdtempSync(join(tmpdir(), "static-resolve-"));
    return { root, moduleDir: join(root, "module-static"), cwdDir: join(root, "cwd-static") };
  };

  const withEnv = async (value: string | undefined, fn: () => void | Promise<void>) => {
    const prev = process.env.WXT_STATIC_DIR;
    if (value === undefined) delete process.env.WXT_STATIC_DIR;
    else process.env.WXT_STATIC_DIR = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.WXT_STATIC_DIR;
      else process.env.WXT_STATIC_DIR = prev;
    }
  };

  test("explicit env dir wins over module and cwd candidates", () => {
    const { root, moduleDir, cwdDir } = makeDirs();
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(cwdDir, { recursive: true });
    withEnv(join(root, "env-static"), () => {
      mkdirSync(join(root, "env-static"), { recursive: true });
      expect(resolveStaticDir({ moduleStaticDir: moduleDir, cwdStaticDir: cwdDir })).toBe(
        join(root, "env-static"),
      );
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("falls back to the module dir when env is unset", () => {
    const { root, moduleDir, cwdDir } = makeDirs();
    mkdirSync(moduleDir, { recursive: true });
    withEnv(undefined, () => {
      expect(resolveStaticDir({ moduleStaticDir: moduleDir, cwdStaticDir: cwdDir })).toBe(
        moduleDir,
      );
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("falls back to the cwd dir when env and module dir are missing", () => {
    const { root, cwdDir } = makeDirs();
    mkdirSync(cwdDir, { recursive: true });
    withEnv(undefined, () => {
      // Compiled binaries have no ../static next to import.meta.dir, so
      // cwd/static is what a release package relies on.
      expect(resolveStaticDir({ moduleStaticDir: join(root, "missing"), cwdStaticDir: cwdDir })).toBe(
        cwdDir,
      );
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("returns the cwd candidate (resolved) when nothing exists, so hosting is simply skipped", () => {
    const { root, moduleDir, cwdDir } = makeDirs();
    withEnv(undefined, () => {
      expect(resolveStaticDir({ moduleStaticDir: moduleDir, cwdStaticDir: cwdDir })).toBe(cwdDir);
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("createApp serves a package-root static dir via WXT_STATIC_DIR (release layout)", async () => {
    const { root, cwdDir } = makeDirs();
    mkdirSync(cwdDir, { recursive: true });
    writeFileSync(join(cwdDir, "index.html"), "<!doctype html><body>PKG-INDEX</body></html>");
    // apps/server/static cannot be hidden here (the dev server holds it open),
    // so the env override stands in for "module dir missing"; the ordering
    // itself (env → module → cwd) is covered by the resolveStaticDir unit tests.
    await withEnv(cwdDir, async () => {
      const app = new Hono().route(
        "/wxt",
        createApp(loadConfigWithSecret(), {
          dataDir: mkdtempSync(join(tmpdir(), "static-cwd-data-")),
        }),
      );
      const res = await app.request("/wxt/");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("PKG-INDEX");
    });
    rmSync(root, { recursive: true, force: true });
  });
});

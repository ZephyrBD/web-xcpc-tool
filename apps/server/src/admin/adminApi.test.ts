import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { createApp } from "../server";
import { adminAuthHeaders } from "./auth";
import { LoginHistoryStore } from "./loginHistory";
import { JsonStore } from "../store/store";
import { SecretBox, ensureKeyFile } from "../store/secretbox";
import { TeamStore } from "../store/teams";
import { DjClient } from "../domjudge/client";

const cfg = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "admin-api-test-secret", ttlSeconds: 3600 },
  contextPath: "",
});

const TEAMS = [
  { id: "t1", icpc_id: "icpc1", name: "队伍一", display_name: "Team One" },
  { id: "t2", icpc_id: "icpc2", name: "队伍二" },
  { id: "t3", icpc_id: "icpc3", name: "队伍三" },
];

describe("admin team-code & login-history API", () => {
  let dataDir: string;
  let teamStore: TeamStore;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "admin-api-"));
    teamStore = new TeamStore(
      join(dataDir, "team-passwords.json"),
      new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))),
    );
    teamStore.setPassword("icpc1", "secret-pw-1");
    teamStore.setTeamCode("icpc1");
    app = createApp(cfg(), {
      dataDir,
      teamStore,
      teamsStore: new JsonStore(join(dataDir, "teams.json"), TEAMS),
    });
    headers = await adminAuthHeaders(cfg());
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET /admin/api/team-codes joins teams with codes, never passwords", async () => {
    const res = await app.request("/admin/api/team-codes", { headers });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({
      icpcId: "icpc1",
      name: "Team One",
      teamCode: teamStore.getTeamCode("icpc1"),
      hasPassword: true,
    });
    expect(rows[1]).toEqual({ icpcId: "icpc2", name: "队伍二", teamCode: null, hasPassword: false });
    expect(JSON.stringify(rows)).not.toContain("secret-pw-1");
    expect(JSON.stringify(rows)).not.toContain("password");
  });

  test("POST generate for a single team returns the new code and replaces the old one", async () => {
    const oldCode = teamStore.getTeamCode("icpc1");
    const res = await app.request("/admin/api/team-codes/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ icpcId: "icpc1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { icpcId: string; teamCode: string };
    expect(body.icpcId).toBe("icpc1");
    expect(body.teamCode).not.toBe(oldCode);
    expect(teamStore.getTeamCode("icpc1")).toBe(body.teamCode);
    expect(teamStore.findByTeamCode(oldCode ?? "")).toBeNull();
  });

  test("POST generate for an unknown team returns 404", async () => {
    const res = await app.request("/admin/api/team-codes/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ icpcId: "nobody" }),
    });
    expect(res.status).toBe(404);
  });

  test("POST generate with all:true assigns only missing codes and returns the count", async () => {
    const res = await app.request("/admin/api/team-codes/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
    // idempotent: nothing left to assign
    const again = await app.request("/admin/api/team-codes/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ all: true }),
    });
    expect(await again.json()).toEqual({ count: 0 });
    expect(teamStore.getTeamCode("icpc2")).not.toBeNull();
  });

  test("GET export returns CSV attachment with BOM, decrypted passwords, and Chinese headers", async () => {
    const res = await app.request("/admin/api/team-codes/export", { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toMatch(/filename="?team-codes-\d{4}-\d{2}-\d{2}\.csv"?/);
    const text = await res.text();
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain("队伍名,DOMjudge用户名,队伍码,DOMjudge密码");
    // decryption correctness: the plaintext password appears in the row
    expect(text).toContain("Team One,icpc1,");
    expect(text).toContain("secret-pw-1");
  });

  test("unauthenticated requests to team-codes, export and login-history return 401", async () => {
    for (const path of ["/admin/api/team-codes", "/admin/api/team-codes/export", "/admin/api/login-history"]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
    }
  });
});

describe("admin team-code API: teams without icpc_id fall back to the DOMjudge team id", () => {
  const TEAMS_WITHOUT_ICPC = [
    { id: "t1", icpc_id: "icpc1", name: "队伍一", display_name: "Team One" },
    { id: "djteam9", name: "DOMjudge", display_name: "Demo Team" },
  ];
  let dataDir: string;
  let teamStore: TeamStore;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "admin-api-noicpc-"));
    teamStore = new TeamStore(
      join(dataDir, "team-passwords.json"),
      new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))),
    );
    teamStore.setPassword("icpc1", "secret-pw-1");
    app = createApp(cfg(), {
      dataDir,
      teamStore,
      teamsStore: new JsonStore(join(dataDir, "teams.json"), TEAMS_WITHOUT_ICPC),
    });
    headers = await adminAuthHeaders(cfg());
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("generate all assigns a code keyed by the DOMjudge team id", async () => {
    const res = await app.request("/admin/api/team-codes/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
    expect(teamStore.getTeamCode("djteam9")).not.toBeNull();
  });

  test("team-codes list reports the team id as icpcId", async () => {
    const code = teamStore.setTeamCode("djteam9");
    const res = await app.request("/admin/api/team-codes", { headers });
    const rows = (await res.json()) as Array<{ icpcId: string; name: string; teamCode: string | null; hasPassword: boolean }>;
    expect(rows[1]).toEqual({ icpcId: "djteam9", name: "Demo Team", teamCode: code, hasPassword: false });
  });

  test("export lists the DOMjudge team id as the username", async () => {
    const code = teamStore.setTeamCode("djteam9");
    const res = await app.request("/admin/api/team-codes/export", { headers });
    const text = await res.text();
    expect(text).toContain(`Demo Team,djteam9,${code},`);
  });

  test("verify with its code signs a token whose sub is the team id", async () => {
    const { verifyTeamToken } = await import("../auth/token");
    const code = teamStore.setTeamCode("djteam9");
    const res = await app.request(`/dj/verify?code=${code}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const token = /cxtool-token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect((await verifyTeamToken("admin-api-test-secret", token))?.sub).toBe("djteam9");
  });

  test("proxy /login injects x-domjudge-login with the team id", async () => {
    const { signTeamToken } = await import("../auth/token");
    const injected: { login: string | null; pass: string | null } = { login: null, pass: null };
    const upstream = Bun.serve({
      port: 0,
      fetch: (req) => {
        injected.login = req.headers.get("x-domjudge-login");
        injected.pass = req.headers.get("x-domjudge-pass");
        return new Response("login-ok");
      },
    });
    try {
      const djApp = createApp(
        {
          ...cfg(),
          domjudge: { baseUrl: `http://127.0.0.1:${upstream.port}`, adminUser: "", adminPassword: "", timeoutSeconds: 5 },
        },
        { dataDir, teamStore },
      );
      teamStore.setPassword("djteam9", "dj-pw");
      const token = await signTeamToken("admin-api-test-secret", 3600, "djteam9");
      const res = await djApp.request("/dj/login", { headers: { cookie: `cxtool-token=${token}` } });
      expect(res.status).toBe(200);
      expect(injected.login).toBe("djteam9");
      expect(injected.pass).toBe(Buffer.from("dj-pw", "utf8").toString("base64"));
    } finally {
      upstream.stop(true);
    }
  });
});

describe("POST /admin/api/team-codes/provision", () => {
  // Mock DOMjudge user directory covering the roles guard matrix.
  const DJ_USERS = [
    { id: "7", username: "icpc1", roles: ["team"] },
    { id: "2", username: "icpc2", roles: ["admin"] },
    { id: "3", username: "icpc4", roles: ["jury"] },
    // Roles missing entirely: cannot prove it is a team account.
    { id: "4", username: "icpc5" },
    { id: "5", username: "icpc6", roles: ["team", "admin"] },
  ];
  let dataDir: string;
  let teamStore: TeamStore;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;
  const djCalls: Array<{ method: string; url: string; body: unknown }> = [];
  // Teams for the guard tests: icpc4 (jury), icpc5 (roles missing), icpc6 (team+admin).
  const TEAMS_PROVISION = [
    ...TEAMS,
    { id: "t4", icpc_id: "icpc4", name: "队伍四" },
    { id: "t5", icpc_id: "icpc5", name: "队伍五" },
    { id: "t6", icpc_id: "icpc6", name: "队伍六" },
  ];

  beforeEach(async () => {
    djCalls.length = 0;
    dataDir = mkdtempSync(join(tmpdir(), "provision-"));
    teamStore = new TeamStore(
      join(dataDir, "team-passwords.json"),
      new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))),
    );
    const djFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      djCalls.push({
        method: init?.method ?? "GET",
        url: u.pathname.replace(/^.*\/api\/v4\//, "") + u.search,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const path = u.pathname;
      if (path.endsWith("/users") && (init?.method ?? "GET") === "GET") {
        const username = u.searchParams.get("username");
        const users = DJ_USERS.filter((user) => user.username === username);
        return new Response(JSON.stringify(users), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/users\/\d+$/.test(path) && init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "7", username: "icpc1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "nope" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DjClient({ baseUrl: "https://dj.example.com", adminUser: "admin", adminPassword: "pw", timeoutSeconds: 5 }, djFetch);
    app = createApp(cfg(), {
      dataDir,
      teamStore,
      teamsStore: new JsonStore(join(dataDir, "teams.json"), TEAMS_PROVISION),
      djClient: client,
    });
    headers = await adminAuthHeaders(cfg());
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("patches the DOMjudge user password and stores it encrypted", async () => {
    const res = await app.request("/admin/api/team-codes/provision", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ icpcId: "icpc1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provisioned: number; skipped: number; errors: unknown[] };
    expect(body).toEqual({ provisioned: 1, skipped: 0, errors: [] });
    // user lookup by username, then PATCH {password} on /users/{id}
    expect(djCalls[0]).toMatchObject({ method: "GET", url: "users?username=icpc1" });
    expect(djCalls[1].method).toBe("PATCH");
    expect(djCalls[1].url).toBe("users/7");
    const password = (djCalls[1].body as { password: string }).password;
    expect(password).toHaveLength(16);
    expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{16}$/);
    // raw password must never appear in the store file
    const raw = Bun.file(join(dataDir, "team-passwords.json"));
    expect((await raw.text())).not.toContain(password);
    expect(teamStore.getPassword("icpc1")).toBe(password);
    // a team code was assigned too
    expect(teamStore.getTeamCode("icpc1")).not.toBeNull();
  });

  test("unknown DOMjudge user is skipped, not a batch failure", async () => {
    teamStore.setTeamCode("icpc3");
    const res = await app.request("/admin/api/team-codes/provision", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ icpcId: "icpc3" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provisioned: number;
      skipped: number;
      errors: Array<{ icpcId: string; reason: string }>;
    };
    expect(body.provisioned).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.errors).toEqual([{ icpcId: "icpc3", reason: expect.any(String) }]);
    // no password stored for the skipped team
    expect(teamStore.hasPassword("icpc3")).toBe(false);
    expect(djCalls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test.each([
    ["icpc2", "admin user"],
    ["icpc4", "jury user"],
    ["icpc5", "user with missing roles"],
    ["icpc6", "team+admin hybrid user"],
  ])("refuses non-team user (%s)", async (icpcId) => {
    teamStore.setTeamCode(icpcId);
    const res = await app.request("/admin/api/team-codes/provision", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ icpcId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provisioned: number; skipped: number; errors: Array<{ reason: string }> };
    expect(body.provisioned).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.errors[0].reason).toContain("refusing non-team user");
    expect(teamStore.hasPassword(icpcId)).toBe(false);
    expect(djCalls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("all:true targets teams missing a code or a password", async () => {
    teamStore.setTeamCode("icpc2");
    teamStore.setPassword("icpc2", "already-set");
    const res = await app.request("/admin/api/team-codes/provision", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ all: true }),
    });
    const body = (await res.json()) as { provisioned: number; skipped: number; errors: Array<{ icpcId: string; reason: string }> };
    // icpc1 (team roles) → provisioned; icpc2 complete → not targeted;
    // icpc3 has no DOMjudge user, icpc4/5/6 fail the team-roles guard → skipped
    expect(body.provisioned).toBe(1);
    expect(body.skipped).toBe(4);
    expect(body.errors.map((e) => e.icpcId).sort()).toEqual(["icpc3", "icpc4", "icpc5", "icpc6"]);
  });

  test("without a domjudge client returns 503", async () => {
    const bare = createApp(cfg(), { dataDir, teamStore });
    const res = await bare.request("/admin/api/team-codes/provision", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ icpcId: "icpc1" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /admin/api/login-history", () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;
  let history: LoginHistoryStore;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "login-history-api-"));
    history = new LoginHistoryStore(join(dataDir, "login-history.json"));
    history.append({ icpcId: "icpc1", teamCode: "codeA", at: "2026-01-01T08:00:00.000Z", ip: null });
    history.append({ icpcId: "icpc2", teamCode: "codeB", at: "2026-01-01T09:00:00.000Z", ip: "10.0.0.2" });
    app = createApp(cfg(), { dataDir, loginHistory: history });
    headers = await adminAuthHeaders(cfg());
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("returns entries newest first", async () => {
    const res = await app.request("/admin/api/login-history", { headers });
    const rows = (await res.json()) as Array<{ icpcId: string; teamCode: string; at: string; ip: string | null }>;
    expect(rows.map((r) => r.icpcId)).toEqual(["icpc2", "icpc1"]);
    expect(rows[1]).toEqual({ icpcId: "icpc1", teamCode: "codeA", at: "2026-01-01T08:00:00.000Z", ip: null });
  });

  test("limit is respected (default 100, capped at 500)", async () => {
    const res = await app.request("/admin/api/login-history?limit=1", { headers });
    expect(((await res.json()) as unknown[]).length).toBe(1);
    const bad = await app.request("/admin/api/login-history?limit=0", { headers });
    expect(bad.status).toBe(400);
    const badText = await app.request("/admin/api/login-history?limit=abc", { headers });
    expect(badText.status).toBe(400);
  });
});

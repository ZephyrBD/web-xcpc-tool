import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashSync } from "bcryptjs";
import { loadConfig, type Config } from "../config";
import { createApp } from "../server";
import { adminAuthHeaders, isSameOriginRequest } from "./auth";
import { purgePulledData, type PurgeDeps } from "./purge";
import { LoginHistoryStore } from "./loginHistory";
import { LoginRequestStore } from "../auth/loginRequests";
import { ConfigStore } from "../store/configStore";
import { JsonStore } from "../store/store";
import { SecretBox, ensureKeyFile } from "../store/secretbox";
import { TeamStore } from "../store/teams";
import { PrintQueue } from "../print/queue";
import type { BalloonTask } from "../balloon/service";
import type { DjTeam } from "../domjudge/client";

const cfg = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "purge-test-secret", ttlSeconds: 3600 },
  contextPath: "",
  ...overrides,
});

/** Valid 64-hex SecretBox key; the purge must leave this exact file alone. */
const KEEP_KEY = "a".repeat(32) + "b".repeat(32);

const DJ_BLOCK = {
  baseUrl: "http://dj.example.com",
  adminUser: "djadmin",
  adminPassword: "dj-pass",
  timeoutSeconds: 10,
};
const ADMIN_BLOCK = {
  username: "chief",
  passwordHash: "$2b$10$purgetesthashpurgetesthashpu",
  password: "chief-pass",
  sessionTtlSeconds: 28800,
};

/** Seeds settings.json + secret.key. */
function seedSettings(dataDir: string) {
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify(
      {
        port: 8080,
        contextPath: "",
        domjudge: DJ_BLOCK,
        jwt: { secret: "purge-test-secret", ttlSeconds: 3600 },
        teamLogin: { start: "", end: "" },
        print: { token: "print-token" },
        balloon: { contestId: "contest-1", pollIntervalSeconds: 45 },
        admin: ADMIN_BLOCK,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dataDir, "secret.key"), KEEP_KEY);
}

/** Seeds every store and both archive dirs; returns the purge deps over those files. */
function seed(dataDir: string): PurgeDeps {
  seedSettings(dataDir);

  const teams = new JsonStore<DjTeam[]>(join(dataDir, "teams.json"), []);
  const teamStore = new TeamStore(
    join(dataDir, "team-passwords.json"),
    new SecretBox(ensureKeyFile(join(dataDir, "secret.key"))),
  );
  const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
  const balloonTasks = new JsonStore<BalloonTask[]>(join(dataDir, "balloon-tasks.json"), []);
  const loginHistory = new LoginHistoryStore(join(dataDir, "login-history.json"));
  const loginRequests = new LoginRequestStore(join(dataDir, "login-requests.json"));

  teams.save([{ id: "t1", icpc_id: "icpc1", name: "队伍一" } as DjTeam]);
  teamStore.setPassword("icpc1", "pw-1");
  teamStore.setTeamCode("icpc1");
  printQueue.add({
    location: "A",
    teamName: "队伍一",
    teamId: "t1",
    originalFilename: "a.pdf",
    pdfPath: join(dataDir, "pdf", "a.pdf"),
  });
  balloonTasks.save([
    {
      id: "b1",
      contestId: "contest-1",
      problemLabel: "A",
      teamName: "队伍一",
      location: null,
      status: "pending",
      createdAt: new Date().toISOString(),
    },
  ]);
  loginHistory.append({ icpcId: "icpc1", teamCode: "code", at: "2026-01-01T00:00:00Z", ip: null });
  loginRequests.create({ icpcId: "icpc1", teamCode: "code", teamName: "队伍一", ip: null });

  mkdirSync(join(dataDir, "printed"), { recursive: true });
  mkdirSync(join(dataDir, "pdf", "sub"), { recursive: true });
  writeFileSync(join(dataDir, "printed", "source.cpp"), "int main(){}");
  writeFileSync(join(dataDir, "pdf", "a.pdf"), "%PDF-1.4");
  // One level down: proves filesRemoved recurses instead of only listing the
  // top level (a non-recursive purge would report 2 and leave this behind).
  writeFileSync(join(dataDir, "pdf", "sub", "x.pdf"), "%PDF-1.4");

  return {
    dataDir,
    liveCfg: cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } }),
    teams,
    teamCredentials: teamStore.store as JsonStore<Record<string, unknown>>,
    printTasks: printQueue.store,
    balloonTasks,
    loginHistory: loginHistory.store,
    loginRequests: loginRequests.store,
  };
}

describe("purgePulledData", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "purge-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("empties every store, deletes archive dirs, resets contestId, keeps secrets", () => {
    const deps = seed(dataDir);
    const reset: Config[] = [];
    const report = purgePulledData({ ...deps, contestIdReset: (next) => reset.push(next) });

    // team-passwords.json holds 1 password + 1 team code, both for team icpc1.
    expect(report.teams).toBe(1);
    expect(report.passwords).toBe(1);
    expect(report.teamCodes).toBe(1);
    expect(report.printTasks).toBe(1);
    expect(report.balloonTasks).toBe(1);
    expect(report.loginHistory).toBe(1);
    expect(report.loginRequests).toBe(1);
    expect(report.filesRemoved).toBe(3);

    expect(deps.teams.load()).toEqual([]);
    expect(deps.teamCredentials.load()).toEqual({});
    expect(deps.printTasks.load()).toEqual([]);
    expect(deps.balloonTasks.load()).toEqual([]);
    expect(deps.loginHistory.load()).toEqual([]);
    expect(deps.loginRequests.load()).toEqual([]);
    expect(existsSync(join(dataDir, "printed"))).toBe(false);
    expect(existsSync(join(dataDir, "pdf"))).toBe(false);
    expect(existsSync(join(dataDir, "pdf", "sub"))).toBe(false);
    expect(reset.length).toBe(1);
    expect(reset[0].balloon.contestId).toBe("");

    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.balloon.contestId).toBe("");
    expect(saved.balloon.pollIntervalSeconds).toBe(45);
    expect(saved.domjudge).toEqual(DJ_BLOCK);
    expect(saved.admin).toEqual(ADMIN_BLOCK);
    expect(saved.jwt.secret).toBe("purge-test-secret");
    expect(saved.print.token).toBe("print-token");
    expect(saved.teamLogin).toEqual({ start: "", end: "" });
    // Schema-valid after the atomic rewrite.
    expect(loadConfig(join(dataDir, "settings.json")).balloon.contestId).toBe("");
    expect(readFileSync(join(dataDir, "secret.key"), "utf8")).toBe(KEEP_KEY);
  });

  test("tolerates missing dirs and missing settings.json", () => {
    const report = purgePulledData({
      dataDir,
      liveCfg: cfg(),
      teams: new JsonStore(join(dataDir, "teams.json"), []),
      teamCredentials: new JsonStore<Record<string, unknown>>(join(dataDir, "team-passwords.json"), {}),
      printTasks: new JsonStore(join(dataDir, "print-tasks.json"), []),
      balloonTasks: new JsonStore(join(dataDir, "balloon-tasks.json"), []),
      loginHistory: new JsonStore(join(dataDir, "login-history.json"), []),
      loginRequests: new JsonStore(join(dataDir, "login-requests.json"), []),
    });
    expect(report.teams).toBe(0);
    expect(report.filesRemoved).toBe(0);
  });
});

describe("isSameOriginRequest", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost/admin/api/data/purge", { method: "POST", headers });

  test("allows requests without Origin/Referer", () => {
    expect(isSameOriginRequest(req({ host: "localhost:8080" }))).toBe(true);
  });

  test("matches the Origin host and scheme against the request", () => {
    expect(isSameOriginRequest(req({ host: "localhost:8080", origin: "http://localhost:8080" }))).toBe(true);
    expect(isSameOriginRequest(req({ host: "localhost:8080", origin: "https://evil.example" }))).toBe(false);
    // A different scheme on the same host:port is still cross-origin.
    expect(isSameOriginRequest(req({ host: "localhost:8080", origin: "https://localhost:8080" }))).toBe(false);
    // ...unless the reverse proxy says TLS terminates upstream.
    expect(
      isSameOriginRequest(req({ host: "localhost:8080", origin: "https://localhost:8080", "x-forwarded-proto": "https" })),
    ).toBe(true);
  });

  test("falls back to Referer, then to x-forwarded-host", () => {
    expect(isSameOriginRequest(req({ host: "localhost:8080", referer: "http://localhost:8080/admin/" }))).toBe(true);
    expect(isSameOriginRequest(req({ host: "localhost:8080", referer: "https://evil.example/x" }))).toBe(false);
    // Reverse proxy keeps the public host in x-forwarded-host (see proxy.ts).
    expect(
      isSameOriginRequest(
        req({
          host: "127.0.0.1:8080",
          "x-forwarded-host": "ct.example.com",
          "x-forwarded-proto": "https",
          origin: "https://ct.example.com",
        }),
      ),
    ).toBe(true);
    // Forwarded host alone is not enough when the scheme still disagrees.
    expect(
      isSameOriginRequest(req({ host: "127.0.0.1:8080", "x-forwarded-host": "ct.example.com", origin: "https://ct.example.com" })),
    ).toBe(false);
  });

  test("rejects the opaque 'null' origin and malformed values", () => {
    expect(isSameOriginRequest(req({ host: "localhost:8080", origin: "null" }))).toBe(false);
    expect(isSameOriginRequest(req({ host: "localhost:8080", referer: "not a url" }))).toBe(false);
  });

  test("still checks the origin when the request carries no Host header", () => {
    // HTTP/1.0 clients can omit Host; the request URL still knows its host.
    const noHost = (origin: string) =>
      new Request("http://localhost:8080/admin/api/data/purge", {
        method: "POST",
        headers: { origin },
      });
    expect(isSameOriginRequest(noHost("https://evil.example"))).toBe(false);
    expect(isSameOriginRequest(noHost("http://localhost:8080"))).toBe(true);
  });
});

describe("POST /admin/api/data/purge", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "purge-route-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("requires admin auth", async () => {
    const app = createApp(cfg(), { dataDir });
    const res = await app.request("/admin/api/data/purge", { method: "POST" });
    expect(res.status).toBe(401);
    // Unauthenticated purge must not touch anything.
    expect(existsSync(join(dataDir, "teams.json"))).toBe(false);
  });

  test("returns the PurgeReport after an authenticated purge", async () => {
    seed(dataDir);
    const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
    const app = createApp(live, { dataDir });
    const res = await app.request("/admin/api/data/purge", {
      method: "POST",
      headers: await adminAuthHeaders(live),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    for (const key of [
      "teams",
      "passwords",
      "teamCodes",
      "printTasks",
      "balloonTasks",
      "loginHistory",
      "loginRequests",
      "filesRemoved",
    ]) {
      expect(typeof body[key]).toBe("number");
    }
    expect(body.teams).toBe(1);
    expect(body.printTasks).toBe(1);
    expect(body.filesRemoved).toBe(3);
    expect(JSON.parse(readFileSync(join(dataDir, "balloon-tasks.json"), "utf8"))).toEqual([]);
  });

  test("the balloon poller is stopped BEFORE the balloon store is wiped", async () => {
    // Order matters: a poll that is already past its generation check would
    // otherwise write its stale snapshot back over the emptied file.
    seed(dataDir);
    const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
    const events: string[] = [];
    const balloonService = {
      stop: () => events.push("stop"),
      reconfigure: () => events.push("reconfigure"),
      refresh: () => events.push("refresh"),
    } as unknown as NonNullable<Parameters<typeof createApp>[1]>["balloonService"];
    const app = createApp(live, {
      dataDir,
      balloonService,
      balloonTasks: {
        load: () => [],
        save: (next: unknown[]) => {
          events.push("balloonTasks.save");
          void next;
        },
      } as never,
    });

    const res = await app.request("/admin/api/data/purge", {
      method: "POST",
      headers: await adminAuthHeaders(live),
    });
    expect(res.status).toBe(200);
    expect(events[0]).toBe("stop");
    expect(events).toContain("balloonTasks.save");
    expect(events.indexOf("stop")).toBeLessThan(events.indexOf("balloonTasks.save"));
  });

  test("after purging, a new contest id can be set (round trip)", async () => {
    seed(dataDir);
    // A ConfigStore exercises the live path: replace() must reach subscribers.
    const store = new ConfigStore(cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } }));
    const seen: string[] = [];
    store.onChange((next) => seen.push(next.balloon.contestId));
    const app = createApp(store, { dataDir });
    const headers = await adminAuthHeaders(store.current);

    const locked = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ balloon: { contestId: "contest-2" } }),
    });
    expect(locked.status).toBe(403);

    expect((await app.request("/admin/api/data/purge", { method: "POST", headers })).status).toBe(200);
    // The live config saw the emptied id (that is what stops the poller).
    expect(store.current.balloon.contestId).toBe("");
    expect(seen).toEqual([""]);

    const setNew = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ balloon: { contestId: "contest-2" } }),
    });
    expect(setNew.status).toBe(200);
    expect(store.current.balloon.contestId).toBe("contest-2");
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.balloon.contestId).toBe("contest-2");
  });

  describe("same-origin guard (CSRF)", () => {
    const purgeWith = (app: ReturnType<typeof createApp>, headers: Record<string, string>) =>
      app.request("/admin/api/data/purge", { method: "POST", headers });

    test("a same-origin Origin is allowed", async () => {
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      const res = await purgeWith(app, {
        ...(await adminAuthHeaders(live)),
        host: "localhost:8080",
        origin: "http://localhost:8080",
      });
      expect(res.status).toBe(200);
    });

    test("a cross-origin Origin is rejected with 403 and purges nothing", async () => {
      seed(dataDir);
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      const res = await purgeWith(app, {
        ...(await adminAuthHeaders(live)),
        host: "localhost:8080",
        origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross-origin forbidden" });
      // Nothing was touched: the seeded rows and both dirs survive.
      expect(JSON.parse(readFileSync(join(dataDir, "teams.json"), "utf8")).length).toBe(1);
      expect(existsSync(join(dataDir, "printed"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).balloon.contestId).toBe(
        "contest-1",
      );
    });

    test("a cross-origin request with no Host header is rejected", async () => {
      seed(dataDir);
      // HTTP/1.0-style request: no Host header, only a foreign Origin.
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      const res = await app.request(
        new Request("http://localhost/admin/api/data/purge", {
          method: "POST",
          headers: { ...(await adminAuthHeaders(live)), origin: "https://evil.example" },
        }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross-origin forbidden" });
      expect(JSON.parse(readFileSync(join(dataDir, "teams.json"), "utf8")).length).toBe(1);
    });

    test("the guard covers other mutating admin routes too", async () => {
      seed(dataDir);
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir, teamsStore: new JsonStore(join(dataDir, "teams.json"), []) });
      const auth = await adminAuthHeaders(live);
      const foreign = { ...auth, host: "localhost:8080", origin: "https://evil.example" };
      const sameOrigin = { ...auth, host: "localhost:8080", origin: "http://localhost:8080" };

      // team-codes/generate: foreign origin is refused, same-origin works.
      const genForeign = await app.request("/admin/api/team-codes/generate", {
        method: "POST",
        headers: foreign,
        body: JSON.stringify({ all: true }),
      });
      expect(genForeign.status).toBe(403);
      expect(await genForeign.json()).toEqual({ error: "cross-origin forbidden" });
      // The seeded team already had a code; a refused call must not add rows.
      expect(Object.keys(JSON.parse(readFileSync(join(dataDir, "team-passwords.json"), "utf8")))).toEqual(["icpc1"]);

      const genSame = await app.request("/admin/api/team-codes/generate", {
        method: "POST",
        headers: sameOrigin,
        body: JSON.stringify({ all: true }),
      });
      expect(genSame.status).toBe(200);

      // settings PUT: foreign origin is refused and writes nothing.
      const putForeign = await app.request("/admin/api/settings", {
        method: "PUT",
        headers: foreign,
        body: JSON.stringify({ domjudge: { baseUrl: "http://evil.example" } }),
      });
      expect(putForeign.status).toBe(403);
      expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).domjudge.baseUrl).toBe(
        DJ_BLOCK.baseUrl,
      );

      const putSame = await app.request("/admin/api/settings", {
        method: "PUT",
        headers: sameOrigin,
        body: JSON.stringify({ print: { token: "new-token" } }),
      });
      expect(putSame.status).toBe(200);
    });

    test("read-only admin routes are not origin-gated", async () => {
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      const res = await app.request("/admin/api/settings", {
        headers: { ...(await adminAuthHeaders(live)), host: "localhost:8080", origin: "https://evil.example" },
      });
      expect(res.status).toBe(200);
    });

    test("a same-site but different-port Origin is rejected", async () => {
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      const res = await purgeWith(app, {
        ...(await adminAuthHeaders(live)),
        host: "localhost:8080",
        origin: "http://localhost:8081",
      });
      expect(res.status).toBe(403);
    });

    test("no Origin and no Referer is allowed (curl, server-side callers)", async () => {
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      expect((await purgeWith(app, await adminAuthHeaders(live))).status).toBe(200);
    });

    test("Referer is checked when Origin is absent", async () => {
      const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
      const app = createApp(live, { dataDir });
      const headers = await adminAuthHeaders(live);
      const evil = await purgeWith(app, { ...headers, host: "localhost:8080", referer: "https://evil.example/x" });
      expect(evil.status).toBe(403);
      const same = await purgeWith(app, {
        ...headers,
        host: "localhost:8080",
        referer: "http://localhost:8080/admin/",
      });
      expect(same.status).toBe(200);
    });
  });

  test("a failure mid-purge reports that part of the data is already gone", async () => {
    seed(dataDir);
    const live = cfg({ balloon: { contestId: "contest-1", pollIntervalSeconds: 45 } });
    const app = createApp(live, { dataDir });
    // Make the final settings rewrite fail (the file is a directory): by then
    // the stores and archive dirs are already gone — a genuine partial state.
    const settingsFile = join(dataDir, "settings.json");
    rmSync(settingsFile);
    mkdirSync(join(settingsFile, "blocker"), { recursive: true });

    const res = await app.request("/admin/api/data/purge", {
      method: "POST",
      headers: await adminAuthHeaders(live),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("已清空部分数据");
    // The partial state is real: data rows and archives are already gone.
    expect(JSON.parse(readFileSync(join(dataDir, "teams.json"), "utf8"))).toEqual([]);
    expect(existsSync(join(dataDir, "printed"))).toBe(false);
  });
});

describe("purge keeps the live secrets when settings.json is partial", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "purge-partial-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("admin login still works and the same jwt secret stays in effect", async () => {
    // A file generated without an admin block or a jwt secret: both were
    // bootstrapped in memory at startup (ensureAdminPassword/ensureJwtSecret).
    const liveHash = hashSync("bootstrapped-pass", 4);
    const live = cfg({
      admin: { username: "admin", passwordHash: liveHash, password: "bootstrapped-pass", sessionTtlSeconds: 28800 },
      jwt: { secret: "bootstrapped-secret", ttlSeconds: 3600 },
      balloon: { contestId: "contest-1", pollIntervalSeconds: 45 },
    });
    writeFileSync(
      join(dataDir, "settings.json"),
      JSON.stringify({ port: 8080, contextPath: "", teamLogin: { start: "", end: "" } }),
    );
    const store = new ConfigStore(live);
    const app = createApp(store, { dataDir });

    // Hold a token minted before the purge; it must still verify afterwards.
    const headers = await adminAuthHeaders(live);
    const res = await app.request("/admin/api/data/purge", { method: "POST", headers });
    expect(res.status).toBe(200);

    expect(store.current.admin.passwordHash).toBe(liveHash);
    expect(store.current.admin.password).toBe("bootstrapped-pass");
    expect(store.current.jwt.secret).toBe("bootstrapped-secret");
    expect(store.current.balloon.contestId).toBe("");

    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.admin.passwordHash).toBe(liveHash);
    expect(saved.admin.password).toBe("bootstrapped-pass");
    expect(saved.jwt.secret).toBe("bootstrapped-secret");
    expect(saved.balloon.contestId).toBe("");

    // The pre-purge admin token still authenticates (same secret).
    const after = await app.request("/admin/api/settings", { headers });
    expect(after.status).toBe(200);

    // And the bootstrapped password still logs in (same hash).
    const login = await app.request("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "bootstrapped-pass" }),
    });
    expect(login.status).toBe(200);
  });
});

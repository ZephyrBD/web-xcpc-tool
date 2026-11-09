import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../config";
import { createApp } from "../server";
import { adminAuthHeaders } from "./auth";
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
  mkdirSync(join(dataDir, "pdf"), { recursive: true });
  writeFileSync(join(dataDir, "printed", "source.cpp"), "int main(){}");
  writeFileSync(join(dataDir, "pdf", "a.pdf"), "%PDF-1.4");
  writeFileSync(join(dataDir, "pdf", "nested.tmp"), "x");

  return {
    dataDir,
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
});

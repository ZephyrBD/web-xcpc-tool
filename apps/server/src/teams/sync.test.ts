import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { DjClient, type DjTeam } from "../domjudge/client";
import { JsonStore, setDataDir } from "../store/store";
import { createApp } from "../server";
import { adminAuthHeaders } from "../admin/auth";
import { syncTeamsFromDomjudge } from "./sync";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teams-sync-"));
  setDataDir(dir);
});

afterEach(() => {
  setDataDir("");
  rmSync(dir, { recursive: true, force: true });
});

function makeStores() {
  const teamsStore = new JsonStore<DjTeam[]>("teams.json", []);
  return { teamsStore };
}

const TEAMS: DjTeam[] = [
  { id: "1", icpc_id: "t1", name: "Team One" },
  { id: "2", icpc_id: "t2", name: "Team Two" },
];

describe("syncTeamsFromDomjudge", () => {
  test("fetches teams and writes them to the store, returning the count", async () => {
    const { teamsStore } = makeStores();
    const cfg = loadConfigWithSecret();
    const client = new DjClient(
      { ...cfg.domjudge, baseUrl: "http://dj.test" },
      (async () =>
        new Response(JSON.stringify(TEAMS), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const count = await syncTeamsFromDomjudge(client, "demo", teamsStore);
    expect(count).toBe(2);
    expect(teamsStore.load()).toEqual(TEAMS);
    expect(readFileSync(join(dir, "teams.json"), "utf8")).toContain("Team One");
  });
});

describe("team routes", () => {
  function makeApp() {
    const { teamsStore } = makeStores();
    const cfg = loadConfigWithSecret();
    const client = new DjClient(
      { ...cfg.domjudge, baseUrl: "http://dj.test" },
      (async () =>
        new Response(JSON.stringify(TEAMS), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const app = createApp(cfg, {
      dataDir: dir,
      teamsStore,
      djClient: client,
    });
    return { app, cfg, teamsStore };
  }

  test("POST /admin/api/teams/sync returns the count", async () => {
    const { app, cfg } = makeApp();
    const res = await app.request("/admin/api/teams/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ contestId: "demo" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
  });

  test("GET /admin/api/teams returns teams with no password anywhere in the response", async () => {
    const { app, cfg, teamsStore } = makeApp();
    teamsStore.save(TEAMS);
    const res = await app.request("/admin/api/teams", { headers: await adminAuthHeaders(cfg) });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("password");
    expect(text).toContain("Team One");
  });
});

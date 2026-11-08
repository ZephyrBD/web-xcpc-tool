import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { loadConfig } from "../config";
import { DjClient, type DjTeam } from "../domjudge/client";
import { SecretBox } from "../store/secretbox";
import { JsonStore, setDataDir } from "../store/store";
import { TeamStore } from "../store/teams";
import { createApp } from "../server";
import { adminAuthHeaders } from "../admin/auth";
import { importTeamsFromExcel, syncTeamsFromDomjudge } from "./import";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teams-import-"));
  setDataDir(dir);
});

afterEach(() => {
  setDataDir("");
  rmSync(dir, { recursive: true, force: true });
});

function makeExcel(rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function makeStores() {
  const box = new SecretBox(KEY);
  const teamStore = new TeamStore("team-passwords.json", box);
  const teamsStore = new JsonStore<DjTeam[]>("teams.json", []);
  return { teamStore, teamsStore };
}

const TEAMS: DjTeam[] = [
  { id: "1", icpc_id: "t1", name: "Team One" },
  { id: "2", icpc_id: "t2", name: "Team Two" },
];

describe("importTeamsFromExcel", () => {
  test("imports passwords and roundtrips via getPassword", async () => {
    const { teamStore } = makeStores();
    const buf = makeExcel([
      ["ICPC_ID", "PASSWORD"],
      ["t1", "pw-one"],
      ["t2", "pw-two"],
    ]);
    const result = await importTeamsFromExcel(buf, TEAMS, teamStore);
    expect(result).toEqual({ imported: 2, skipped: 0 });
    expect(teamStore.getPassword("t1")).toBe("pw-one");
    expect(teamStore.getPassword("t2")).toBe("pw-two");
  });

  test("headers are matched case-insensitively and trimmed", async () => {
    const { teamStore } = makeStores();
    const buf = makeExcel([
      [" icpc_id ", " Password "],
      ["t1", "secret"],
    ]);
    const result = await importTeamsFromExcel(buf, TEAMS, teamStore);
    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(teamStore.getPassword("t1")).toBe("secret");
  });

  test("unknown icpc_id counts as skipped, not an error", async () => {
    const { teamStore } = makeStores();
    const buf = makeExcel([
      ["ICPC_ID", "PASSWORD"],
      ["t1", "pw-one"],
      ["ghost", "nope"],
    ]);
    const result = await importTeamsFromExcel(buf, TEAMS, teamStore);
    expect(result).toEqual({ imported: 1, skipped: 1 });
    expect(teamStore.getPassword("ghost")).toBeNull();
  });

  test("blank icpc_id or password cells are skipped", async () => {
    const { teamStore } = makeStores();
    const buf = makeExcel([
      ["ICPC_ID", "PASSWORD"],
      ["t1", "   "],
      ["  ", "pw"],
      ["t2", "pw-two"],
    ]);
    const result = await importTeamsFromExcel(buf, TEAMS, teamStore);
    expect(result).toEqual({ imported: 1, skipped: 2 });
    expect(teamStore.getPassword("t2")).toBe("pw-two");
  });

  test("no password plaintext lands on disk", async () => {
    const { teamStore } = makeStores();
    const buf = makeExcel([
      ["ICPC_ID", "PASSWORD"],
      ["t1", "super-secret-pw"],
    ]);
    await importTeamsFromExcel(buf, TEAMS, teamStore);
    const raw = readFileSync(join(dir, "team-passwords.json"), "utf8");
    expect(raw).not.toContain("super-secret-pw");
  });
});

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
    const { teamStore, teamsStore } = makeStores();
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
      teamStore,
      teamsStore,
      djClient: client,
    });
    return { app, cfg, teamStore, teamsStore };
  }

  test("POST /admin/api/teams/import-excel imports passwords from multipart file", async () => {
    const { app, cfg, teamStore } = makeApp();
    await app.request("/admin/api/teams/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ contestId: "demo" }),
    });
    const buf = makeExcel([
      ["ICPC_ID", "PASSWORD"],
      ["t1", "route-pw"],
    ]);
    const form = new FormData();
    form.append("file", new File([new Uint8Array(buf)], "pw.xlsx"));
    const res = await app.request("/admin/api/teams/import-excel", {
      method: "POST",
      headers: await adminAuthHeaders(cfg),
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, skipped: 0 });
    expect(teamStore.getPassword("t1")).toBe("route-pw");
  });

  test("POST /admin/api/teams/sync returns the count", async () => {
    const { app, cfg } = makeApp();
    const res = await app.request("/admin/api/teams/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ contestId: "demo" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2, problemsMapped: true });
  });

  test("GET /admin/api/teams returns teams with no password anywhere in the response", async () => {
    const { app, cfg, teamStore, teamsStore } = makeApp();
    teamsStore.save(TEAMS);
    teamStore.setPassword("t1", "plaintext-leak-pw");
    const res = await app.request("/admin/api/teams", { headers: await adminAuthHeaders(cfg) });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("plaintext-leak-pw");
    expect(text).toContain("Team One");
  });
});

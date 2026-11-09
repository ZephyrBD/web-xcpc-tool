import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compare } from "bcryptjs";
import { loadConfig, resetContextPathNotice } from "../config";
import { initLogger } from "../log/logger";
import { createApp } from "../server";
import { adminAuthHeaders } from "./auth";
import { applySettingsPatch, assertContestIdMutable, maskToken } from "./settings";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});

describe("settings routes", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "settings-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET /admin/api/settings masks secrets and never returns passwords", async () => {
    const cfg = {
      ...loadConfigWithSecret(),
      print: { token: "super-secret-token-1234" },
      admin: { username: "admin", passwordHash: "$2b$10$hashhashhash", sessionTtlSeconds: 28800 },
      domjudge: { baseUrl: "http://dj.example.com", adminUser: "djadmin", adminPassword: "dj-pass", timeoutSeconds: 10 },
    };
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/settings", { headers: await adminAuthHeaders(cfg) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.domjudge as Record<string, unknown>).baseUrl).toBe("http://dj.example.com");
    expect((body.domjudge as Record<string, unknown>).adminUser).toBe("djadmin");
    expect((body.print as Record<string, unknown>).tokenMasked).toBe(maskToken("super-secret-token-1234"));
    const text = JSON.stringify(body);
    expect(text).not.toContain("dj-pass");
    expect(text).not.toContain("$2b$10$hashhashhash");
    expect(text).not.toContain("super-secret-token-1234");
    expect(text).not.toContain("adminPassword");
    expect(text).not.toContain("passwordHash");
  });

  test("GET /admin/api/settings exposes version info for the footer", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/settings", { headers: await adminAuthHeaders(cfg) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version?: { hash: string; year: number } };
    expect(body.version).toBeDefined();
    expect(body.version?.hash).toMatch(/^(dev|[0-9a-f]{7,})$/);
    expect(body.version?.year).toBe(new Date().getFullYear());
  });

  test("GET /admin/api/settings requires admin auth", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/settings");
    expect(res.status).toBe(401);
  });

  test("PUT merges provided fields and leaves adminPassword intact on empty string", async () => {
    const cfg = loadConfigWithSecret();
    const settingsPath = join(dataDir, "settings.json");
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    // Seed settings.json with an existing password via a first PUT.
    const seed = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ domjudge: { baseUrl: "http://dj.old", adminUser: "djadmin", adminPassword: "real-pass" } }),
    });
    expect(seed.status).toBe(200);

    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ domjudge: { baseUrl: "http://dj.new", adminPassword: "" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.note).toBe("已保存，立即生效");
    const text = JSON.stringify(body);
    expect(text).not.toContain("real-pass");

    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(saved.domjudge.baseUrl).toBe("http://dj.new");
    expect(saved.domjudge.adminUser).toBe("djadmin");
    expect(saved.domjudge.adminPassword).toBe("real-pass");
  });

  test("PUT writes a settings.json the config schema accepts", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const settingsPath = join(dataDir, "settings.json");
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(cfg),
      body: JSON.stringify({
        domjudge: { baseUrl: "https://domjudge.example.com" },
        balloon: { contestId: "contest-1", pollIntervalSeconds: 45 },
        print: { token: "print-token-xyz" },
        admin: { username: "chief" },
      }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(settingsPath)).toBe(true);
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(saved.balloon.contestId).toBe("contest-1");
    expect(saved.balloon.pollIntervalSeconds).toBe(45);
    expect(saved.print.token).toBe("print-token-xyz");
    expect(saved.admin.username).toBe("chief");
    // Re-parse through loadConfig to prove the file is schema-valid.
    const reparsed = loadConfig(settingsPath);
    expect(reparsed.balloon.pollIntervalSeconds).toBe(45);
    expect(reparsed.admin.username).toBe("chief");
  });

  test("PUT leaves print.token unchanged when token is an empty string", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ print: { token: "keep-me" } }),
    });
    await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ print: { token: "" } }),
    });
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.print.token).toBe("keep-me");
  });

  test("PUT with admin.password stores a bcrypt hash and never leaks the raw password", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const settingsPath = join(dataDir, "settings.json");
    const headers = await adminAuthHeaders(cfg);
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ admin: { password: "brand-new-pass" } }),
    });
    expect(res.status).toBe(200);
    const resText = JSON.stringify(await res.json());
    expect(resText).not.toContain("brand-new-pass");
    expect(resText).not.toContain("passwordHash");

    const savedRaw = readFileSync(settingsPath, "utf8");
    const saved = JSON.parse(savedRaw) as { admin: { passwordHash: string; password?: string } };
    expect(await compare("brand-new-pass", saved.admin.passwordHash)).toBe(true);
    // Plaintext is kept alongside the hash so the startup banner can print it
    // (design: data/settings.json is gitignored, local-disk only).
    expect(saved.admin.password).toBe("brand-new-pass");
    // Hashed at the same cost as initial generation.
    expect(saved.admin.passwordHash.startsWith("$2b$10$")).toBe(true);
  });

  test("PUT with admin.password stores the plaintext alongside the hash so the banner can print it", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const settingsPath = join(dataDir, "settings.json");
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(cfg),
      body: JSON.stringify({ admin: { password: "brand-new-pass" } }),
    });
    expect(res.status).toBe(200);

    const saved = loadConfig(settingsPath);
    expect(saved.admin.password).toBe("brand-new-pass");
    expect(await compare("brand-new-pass", saved.admin.passwordHash)).toBe(true);

    // The new password is usable for login by a process started with the saved config.
    const restarted = createApp({ ...saved, jwt: { secret: "test-secret", ttlSeconds: 3600 } }, { dataDir });
    const login = await restarted.request("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: saved.admin.username, password: "brand-new-pass" }),
    });
    expect(login.status).toBe(200);

    // The GET view still never exposes the plaintext.
    const view = JSON.stringify(await (await restarted.request("/admin/api/settings", { headers: await adminAuthHeaders(saved) })).json());
    expect(view).not.toContain("brand-new-pass");
  });

  test("GET /admin/api/settings never exposes admin.password", async () => {
    const cfg = {
      ...loadConfigWithSecret(),
      admin: { username: "admin", passwordHash: "$2b$10$x", password: "plaintext-should-not-leak", sessionTtlSeconds: 28800 },
    };
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/settings", { headers: await adminAuthHeaders(cfg) });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("plaintext-should-not-leak");
    expect(text).not.toContain("password");
  });

  test("PUT with whitespace-only admin.password is rejected with 400 and no hash written", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ admin: { password: "   " } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("密码不能是空白字符");
    // A rejected PUT must not create settings.json at all.
    expect(existsSync(join(dataDir, "settings.json"))).toBe(false);
  });

  test("PUT with empty admin.password leaves the existing hash untouched", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ admin: { password: "keep-me-pass" } }),
    });
    const before = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ admin: { password: "", username: "chief" } }),
    });
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.admin.passwordHash).toBe(before.admin.passwordHash);
    expect(saved.admin.password).toBe(before.admin.password);
    expect(saved.admin.username).toBe("chief");
    expect(await compare("keep-me-pass", saved.admin.passwordHash)).toBe(true);
  });

  test("PUT strips direct passwordHash attempts in the admin section", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(cfg),
      body: JSON.stringify({ admin: { passwordHash: "$2b$10$evil" } as unknown as object }),
    });
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.admin.passwordHash).not.toBe("$2b$10$evil");
  });

  test("PUT accepts teamLogin window bounds and the view echoes them", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ teamLogin: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T12:00:00Z" } }),
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(view.teamLogin).toEqual({ start: "2026-01-01T08:00:00Z", end: "2026-01-01T12:00:00Z" });
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.teamLogin.start).toBe("2026-01-01T08:00:00Z");
    expect(saved.teamLogin.end).toBe("2026-01-01T12:00:00Z");
    // The saved file must re-parse through the full config schema.
    expect(loadConfig(join(dataDir, "settings.json")).teamLogin.end).toBe("2026-01-01T12:00:00Z");
  });

  test("PUT clears the teamLogin window when start/end are empty (留空 = 不限制)", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    // Set a window first so there is something to clear.
    await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ teamLogin: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T12:00:00Z" } }),
    });
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ teamLogin: { start: "", end: "" } }),
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(view.teamLogin).toEqual({ start: "", end: "" });
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.teamLogin.start).toBe("");
    expect(saved.teamLogin.end).toBe("");
  });

  test("PUT rejects a non-ISO teamLogin bound with 400", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(cfg),
      body: JSON.stringify({ teamLogin: { start: "next-tuesday" } }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(dataDir, "settings.json"))).toBe(false);
  });

  test("PUT rejects malformed payloads with 400", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: await adminAuthHeaders(cfg),
      body: JSON.stringify({ balloon: { pollIntervalSeconds: 0 } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("assertContestIdMutable (contest id lock)", () => {
  const cfgWithContest = (contestId: string) => ({
    ...loadConfigWithSecret(),
    balloon: { contestId, pollIntervalSeconds: 30 },
  });

  test("an empty current contest id accepts any patch value", () => {
    expect(assertContestIdMutable(cfgWithContest(""), { balloon: { contestId: "c1" } })).toEqual({ ok: true });
  });

  test("a patch that repeats the locked id is accepted (idempotent form saves)", () => {
    expect(assertContestIdMutable(cfgWithContest("c1"), { balloon: { contestId: "c1" } })).toEqual({ ok: true });
  });

  test("a patch that changes the locked id is rejected", () => {
    const result = assertContestIdMutable(cfgWithContest("c1"), { balloon: { contestId: "c2" } });
    expect(result).toEqual({ ok: false, reason: "locked" });
  });

  test("a patch that clears the id is accepted (purge flow)", () => {
    expect(assertContestIdMutable(cfgWithContest("c1"), { balloon: { contestId: "" } })).toEqual({ ok: true });
  });

  test("a patch without a balloon.contestId is accepted", () => {
    expect(assertContestIdMutable(cfgWithContest("c1"), {})).toEqual({ ok: true });
    expect(assertContestIdMutable(cfgWithContest("c1"), { balloon: { pollIntervalSeconds: 60 } })).toEqual({ ok: true });
  });
});

describe("contest id lock on PUT /admin/api/settings", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "contest-lock-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seed(app: ReturnType<typeof createApp>, headers: Record<string, string>, contestId: string) {
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ balloon: { contestId } }),
    });
    expect(res.status).toBe(200);
  }

  test("setting the contest id once is allowed, changing it afterwards is 403 with a Chinese message", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    await seed(app, headers, "contest-1");

    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ balloon: { contestId: "contest-2" } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("contest id locked");
    expect(body.message).toContain("比赛");

    // Nothing was written: disk still holds the original id.
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.balloon.contestId).toBe("contest-1");
  });

  test("re-saving the same contest id keeps working (idempotent settings form)", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    await seed(app, headers, "contest-1");

    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        balloon: { contestId: "contest-1", pollIntervalSeconds: 45 },
        domjudge: { baseUrl: "https://dj.example.com" },
      }),
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.balloon.contestId).toBe("contest-1");
    expect(saved.balloon.pollIntervalSeconds).toBe(45);
  });

  test("a padded contest id is trimmed before it is stored (and can still be re-saved)", async () => {
    // The field is write-once: storing "  C1  " verbatim would lock the real
    // "C1" out forever (a different string → 403), with no unlock but a purge.
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    await seed(app, headers, "  C1  ");

    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.balloon.contestId).toBe("C1");

    const again = await app.request("/admin/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ balloon: { contestId: "C1", pollIntervalSeconds: 30 } }),
    });
    expect(again.status).toBe(200);
  });

  test("applySettingsPatch trims a contest id even for a caller that bypassed the schema", () => {
    const live = loadConfigWithSecret();
    const updated = applySettingsPatch(live, { balloon: { contestId: "  C9  " } }, join(dataDir, "settings.json"));
    expect(updated.balloon.contestId).toBe("C9");
    const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    expect(saved.balloon.contestId).toBe("C9");
  });

  test("GET exposes balloon.locked so the UI can render the field read-only", async () => {
    const cfg = loadConfigWithSecret();
    const app = createApp(cfg, { dataDir });
    const headers = await adminAuthHeaders(cfg);
    const unlocked = (await (await app.request("/admin/api/settings", { headers })).json()) as {
      balloon: { locked?: boolean };
    };
    expect(unlocked.balloon.locked).toBe(false);

    await seed(app, headers, "contest-1");
    const locked = (await (await app.request("/admin/api/settings", { headers })).json()) as {
      balloon: { locked?: boolean };
    };
    expect(locked.balloon.locked).toBe(true);
  });
});

describe("applySettingsPatch disk-file behavior", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "settings-patch-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("repeated PUTs against a stale contextPath log the notice at most once", async () => {
    // A hand-edited file keeps `contextPath: "/old"` on disk: every PUT
    // re-parses it, and a per-parse INFO would spam the log on each save.
    const dir = mkdtempSync(join(tmpdir(), "settings-log-"));
    const logPath = join(dir, "latest.log");
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    initLogger({ logFilePath: logPath, stream, color: false });
    try {
      resetContextPathNotice();
      const settingsPath = join(dataDir, "settings.json");
      for (let i = 0; i < 3; i++) {
        writeFileSync(settingsPath, JSON.stringify({ port: 8080, contextPath: "/old", teamLogin: { start: "", end: "" } }));
        applySettingsPatch(loadConfigWithSecret(), { balloon: { contestId: "c9" } }, settingsPath);
      }
      expect(chunks.join("").match(/is no longer supported/g)?.length).toBe(1);
    } finally {
      resetContextPathNotice();
      initLogger({ logFilePath: false });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

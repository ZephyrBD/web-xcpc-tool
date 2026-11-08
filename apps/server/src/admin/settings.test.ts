import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compare } from "bcryptjs";
import { loadConfig } from "../config";
import { createApp } from "../server";
import { adminAuthHeaders } from "./auth";
import { maskToken } from "./settings";

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
    expect(body.note).toBe("已保存，重启服务后生效");
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
    expect(savedRaw).not.toContain("brand-new-pass");
    const saved = JSON.parse(savedRaw) as { admin: { passwordHash: string } };
    expect(await compare("brand-new-pass", saved.admin.passwordHash)).toBe(true);
    // Hashed at the same cost as initial generation.
    expect(saved.admin.passwordHash.startsWith("$2b$10$")).toBe(true);
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

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare } from "bcryptjs";
import { CONTEXT_PATH, ensureAdminPassword, ensureJwtSecret, loadConfig, normalizeContextPathFile, writeDefaultConfig } from "./config";

describe("loadConfig", () => {
  test("returns defaults when file does not exist", () => {
    const path = join(tmpdir(), "nonexistent-config-" + Date.now() + ".json");
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(8080);
    expect(cfg.contextPath).toBe(CONTEXT_PATH);
    expect(cfg.teamLogin).toEqual({ start: "", end: "" });
  });

  test("forces a stale contextPath back to the fixed /wxt", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ contextPath: "/cxtool" }));
    expect(loadConfig(path).contextPath).toBe(CONTEXT_PATH);
  });

  test("normalizeContextPathFile rewrites a stale value on disk and keeps other fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ port: 9999, contextPath: "/old" }));
    expect(normalizeContextPathFile(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.contextPath).toBe(CONTEXT_PATH);
    expect(saved.port).toBe(9999);
    // Second run is a no-op, so startup logging stays one line per real change.
    expect(normalizeContextPathFile(path)).toBe(false);
  });

  test("normalizeContextPathFile leaves a missing or unparseable file alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    expect(normalizeContextPathFile(join(dir, "absent.json"))).toBe(false);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(normalizeContextPathFile(broken)).toBe(false);
    expect(readFileSync(broken, "utf8")).toBe("{not json");
  });

  test("loads values from an existing JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ port: 9999 }));
    expect(loadConfig(path).port).toBe(9999);
  });

  test("parses provided domjudge.timeoutSeconds", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ domjudge: { timeoutSeconds: 65 } }));
    expect(loadConfig(path).domjudge.timeoutSeconds).toBe(65);
  });

  test("throws zod error on invalid field types", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ port: "x" }));
    expect(() => loadConfig(path)).toThrow();
  });
});

describe("writeDefaultConfig", () => {
  test("writes a JSON file containing all defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeDefaultConfig(path);
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(8080);
    expect(cfg.contextPath).toBe(CONTEXT_PATH);
    expect(cfg.domjudge).toEqual({ baseUrl: "", adminUser: "", adminPassword: "", timeoutSeconds: 10 });
    expect(cfg.jwt.ttlSeconds).toBeGreaterThan(0);
    expect(cfg.teamLogin).toEqual({ start: "", end: "" });
    expect(typeof cfg.admin.username).toBe("string");
    expect(typeof cfg.admin.passwordHash).toBe("string");
  });
});

describe("teamLogin config", () => {
  test("both bounds empty = no restriction", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({}));
    expect(loadConfig(path).teamLogin).toEqual({ start: "", end: "" });
  });

  test("accepts ISO datetime bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ teamLogin: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T12:00:00Z" } }),
    );
    expect(loadConfig(path).teamLogin.start).toBe("2026-01-01T08:00:00Z");
  });

  test("start after end is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ teamLogin: { start: "2026-01-02T08:00:00Z", end: "2026-01-01T12:00:00Z" } }),
    );
    expect(() => loadConfig(path)).toThrow();
  });

  test("non-ISO bound is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ teamLogin: { start: "not-a-date" } }));
    expect(() => loadConfig(path)).toThrow();
  });
});

describe("ensureJwtSecret", () => {
  test("writes a non-empty secret into an empty-secret config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    writeDefaultConfig(path);
    const cfg = loadConfig(path);
    expect(cfg.jwt.secret).toBe("");

    const secret = ensureJwtSecret(cfg, path);
    expect(secret.length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
    const onDisk = loadConfig(path);
    expect(onDisk.jwt.secret).toBe(secret);
  });

  test("merges into the existing file, preserving other fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ port: 9999, jwt: { secret: "", ttlSeconds: 60 } }));
    const secret = ensureJwtSecret(loadConfig(path), path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.port).toBe(9999);
    expect(raw.jwt.secret).toBe(secret);
    expect(raw.jwt.ttlSeconds).toBe(60);
  });

  test("returns the existing secret unchanged when already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ jwt: { secret: "abc", ttlSeconds: 60 } }));
    expect(ensureJwtSecret(loadConfig(path), path)).toBe("abc");
    expect(JSON.parse(readFileSync(path, "utf8")).jwt.secret).toBe("abc");
  });
});

describe("ensureAdminPassword", () => {
  test("first launch with an empty hash generates a 16-char password and persists hash + plaintext", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    writeDefaultConfig(path);
    const cfg = loadConfig(path);
    expect(cfg.admin.passwordHash).toBe("");

    const updated = ensureAdminPassword(cfg, path);
    expect(updated.admin.password).toHaveLength(16);
    // No confusables (0 O o 1 l I i) anywhere in the generated password.
    expect(updated.admin.password).toMatch(/^[A-HJ-NP-Za-hj-nkm-z2-9]{16}$/);
    expect(updated.admin.passwordHash.startsWith("$2b$10$")).toBe(true);

    const onDisk = loadConfig(path);
    expect(onDisk.admin.password).toBe(updated.admin.password!);
    expect(onDisk.admin.passwordHash).toBe(updated.admin.passwordHash);
    expect(onDisk.admin.username).toBe("admin");
    return compare(updated.admin.password!, onDisk.admin.passwordHash).then((ok) => expect(ok).toBe(true));
  });

  test("preserves the rest of settings.json while writing the generated password", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ port: 9999, domjudge: { baseUrl: "http://dj", timeoutSeconds: 42 } }),
    );
    ensureAdminPassword(loadConfig(path), path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.port).toBe(9999);
    expect(raw.domjudge.baseUrl).toBe("http://dj");
    expect(raw.domjudge.timeoutSeconds).toBe(42);
    expect(typeof raw.admin.passwordHash).toBe("string");
  });

  test("is idempotent: a second call keeps the existing hash and plaintext", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    writeDefaultConfig(path);
    const first = ensureAdminPassword(loadConfig(path), path);
    const second = ensureAdminPassword(loadConfig(path), path);
    expect(second.admin.password).toBe(first.admin.password!);
    expect(second.admin.passwordHash).toBe(first.admin.passwordHash);
  });

  test("never rewrites a hash that already exists but has no plaintext (legacy settings.json)", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    const legacyHash = "$2b$10$legacyhashlegacyhashlegacyha";
    writeFileSync(path, JSON.stringify({ admin: { username: "admin", passwordHash: legacyHash } }));
    const updated = ensureAdminPassword(loadConfig(path), path);
    expect(updated.admin.passwordHash).toBe(legacyHash);
    expect(updated.admin.password).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).admin.passwordHash).toBe(legacyHash);
  });

  test("keeps an existing hash + plaintext pair untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "settings.json");
    const stored = { username: "chief", passwordHash: "$2b$10$h", password: "known-pass" };
    writeFileSync(path, JSON.stringify({ admin: stored }));
    const updated = ensureAdminPassword(loadConfig(path), path);
    expect(updated.admin).toMatchObject(stored);
    expect(JSON.parse(readFileSync(path, "utf8")).admin).toMatchObject(stored);
  });

  test("generated passwords differ between installs", () => {
    const a = mkdtempSync(join(tmpdir(), "config-test-"));
    const b = mkdtempSync(join(tmpdir(), "config-test-"));
    const pa = join(a, "settings.json");
    const pb = join(b, "settings.json");
    writeDefaultConfig(pa);
    writeDefaultConfig(pb);
    expect(ensureAdminPassword(loadConfig(pa), pa).admin.password).not.toBe(
      ensureAdminPassword(loadConfig(pb), pb).admin.password!,
    );
  });
});

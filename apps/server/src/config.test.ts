import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureJwtSecret, loadConfig, writeDefaultConfig } from "./config";

describe("loadConfig", () => {
  test("returns defaults when file does not exist", () => {
    const path = join(tmpdir(), "nonexistent-config-" + Date.now() + ".json");
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(8080);
    expect(cfg.contextPath).toBe("/cxtool");
    expect(cfg.teamLogin).toEqual({ start: "", end: "" });
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
    expect(cfg.contextPath).toBe("/cxtool");
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

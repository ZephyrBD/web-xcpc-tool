import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeDefaultConfig } from "./config";

describe("loadConfig", () => {
  test("returns defaults when file does not exist", () => {
    const path = join(tmpdir(), "nonexistent-config-" + Date.now() + ".json");
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(8080);
    expect(cfg.contextPath).toBe("/cxtool");
    expect(cfg.oms.capture).toBe(false);
  });

  test("loads values from an existing JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ port: 9999 }));
    expect(loadConfig(path).port).toBe(9999);
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
    expect(cfg.domjudge).toEqual({ baseUrl: "" });
    expect(cfg.jwt.ttlSeconds).toBeGreaterThan(0);
    expect(Array.isArray(cfg.oms.strategies)).toBe(true);
    expect(cfg.oms.capture).toBe(false);
    expect(typeof cfg.admin.username).toBe("string");
    expect(typeof cfg.admin.passwordHash).toBe("string");
  });
});

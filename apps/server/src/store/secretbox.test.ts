import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBox, ensureKeyFile } from "./secretbox";

const KEY = "a".repeat(64);

describe("SecretBox", () => {
  it("roundtrips Chinese, English and special characters", () => {
    const box = new SecretBox(KEY);
    const plains = ["hello world", "密码123！@#¥", "line\nbreak\ttab", "🦊emoji", ""];
    for (const plain of plains) {
      expect(box.decrypt(box.encrypt(plain))).toBe(plain);
    }
  });

  it("produces payload in v1:iv:ct:tag format with fresh IVs", () => {
    const box = new SecretBox(KEY);
    const payload = box.encrypt("secret");
    const parts = payload.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toMatch(/^[0-9a-f]{24}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
    expect(parts[3]).toMatch(/^[0-9a-f]{32}$/);
    expect(box.encrypt("secret")).not.toBe(payload);
  });

  it("throws on decrypt with wrong key", () => {
    const box = new SecretBox(KEY);
    const other = new SecretBox("b".repeat(64));
    expect(() => other.decrypt(box.encrypt("secret"))).toThrow();
  });

  it("throws on malformed payload", () => {
    const box = new SecretBox(KEY);
    expect(() => box.decrypt("v2:00:00:00")).toThrow();
    expect(() => box.decrypt("v1:00:00")).toThrow();
    expect(() => box.decrypt("garbage")).toThrow();
    expect(() => box.decrypt("v1:zz:aa:bb")).toThrow();
  });
});

describe("ensureKeyFile", () => {
  it("creates the key once and returns the same hex afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "secretbox-"));
    const path = join(dir, "secret.key");
    const first = ensureKeyFile(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8").trim()).toBe(first);
    const second = ensureKeyFile(path);
    expect(second).toBe(first);
  });

  it("works for a bare filename in the cwd (dirname is '.', which already exists)", () => {
    const dir = mkdtempSync(join(tmpdir(), "secretbox-"));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      // mkdirSync(".") throws EEXIST; a fresh bare path must still create the key.
      const key = ensureKeyFile("secret.key");
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(dir, "secret.key"), "utf8").trim()).toBe(key);
    } finally {
      process.chdir(prev);
    }
  });
});

import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SecretBox } from "./secretbox";
import { setDataDir } from "./store";
import { TeamStore } from "./teams";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
afterEach(() => {
  setDataDir("");
});

function makeStore(): { store: TeamStore; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "teams-"));
  dirs.push(dir);
  setDataDir(dir);
  const box = new SecretBox(KEY);
  return { store: new TeamStore("teams.json", box), filePath: join(dir, "teams.json") };
}

describe("TeamStore", () => {
  test("set and get password roundtrip", () => {
    const { store } = makeStore();
    store.setPassword("team1", "s3cret!");
    expect(store.getPassword("team1")).toBe("s3cret!");
  });

  test("json on disk contains no plaintext password", () => {
    const { store, filePath } = makeStore();
    store.setPassword("team1", "plaintext-pw");
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("plaintext-pw");
    expect(raw).toContain("team1");
  });

  test("missing password returns null", () => {
    const { store } = makeStore();
    expect(store.getPassword("nobody")).toBeNull();
  });

  test("list returns icpcIds", () => {
    const { store } = makeStore();
    store.setPassword("a", "p1");
    store.setPassword("b", "p2");
    expect(store.list()).toEqual([{ icpcId: "a" }, { icpcId: "b" }]);
  });

  test("overwrites existing password", () => {
    const { store } = makeStore();
    store.setPassword("a", "old");
    store.setPassword("a", "new");
    expect(store.getPassword("a")).toBe("new");
  });
});

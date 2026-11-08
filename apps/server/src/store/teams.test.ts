import { readFileSync, writeFileSync } from "node:fs";
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

  test("setTeamCode generates a 12-char code with no ambiguous characters", () => {
    const { store } = makeStore();
    const code = store.setTeamCode("t1");
    expect(code).toHaveLength(12);
    expect(code).not.toMatch(/[0O1lI]/);
  });

  test("findByTeamCode finds the entry and misses unknown codes", () => {
    const { store } = makeStore();
    store.setPassword("t1", "pw");
    const code = store.setTeamCode("t1");
    expect(store.findByTeamCode(code)).toEqual({ icpcId: "t1", teamCode: code });
    expect(store.findByTeamCode("no-such-code")).toBeNull();
  });

  test("generated codes are unique across a batch of teams", () => {
    const { store } = makeStore();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(store.setTeamCode(`t${i}`));
    expect(codes.size).toBe(50);
  });

  test("re-calling setTeamCode regenerates the code and keeps the password", () => {
    const { store } = makeStore();
    store.setPassword("t1", "keep-pw");
    const first = store.setTeamCode("t1");
    const second = store.setTeamCode("t1");
    expect(second).not.toBe(first);
    expect(store.findByTeamCode(first)).toBeNull();
    expect(store.findByTeamCode(second)?.icpcId).toBe("t1");
    expect(store.getPassword("t1")).toBe("keep-pw");
  });

  test("an explicitly provided code is stored as-is", () => {
    const { store } = makeStore();
    expect(store.setTeamCode("t1", "myteamcode123")).toBe("myteamcode123");
    expect(store.findByTeamCode("MYTEAMCODE123")?.icpcId).toBe("t1");
  });

  test("team codes persist with the store on disk", () => {
    const { store, filePath } = makeStore();
    const code = store.setTeamCode("t1", "abcdef234567");
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.t1.teamCode).toBe(code);
    const reopened = new TeamStore(filePath, new SecretBox(KEY));
    expect(reopened.findByTeamCode(code)?.icpcId).toBe("t1");
  });

  test("djUsername roundtrip: setPassword stores it, re-set preserves it", () => {
    const { store } = makeStore();
    store.setPassword("t1", "pw", "team1095218");
    expect(store.getDjUsername("t1")).toBe("team1095218");
    // re-set without a username keeps the previous one
    store.setPassword("t1", "pw2");
    expect(store.getDjUsername("t1")).toBe("team1095218");
    store.setPassword("t1", "pw3", "team999");
    expect(store.getDjUsername("t1")).toBe("team999");
    // setTeamCode also preserves it
    store.setTeamCode("t1");
    expect(store.getDjUsername("t1")).toBe("team999");
    expect(store.getPassword("t1")).toBe("pw3");
  });

  test("missing djUsername returns null", () => {
    const { store } = makeStore();
    store.setPassword("t1", "pw");
    expect(store.getDjUsername("t1")).toBeNull();
    expect(store.getDjUsername("nobody")).toBeNull();
  });

  test("legacy string-valued entries migrate to the password field", () => {
    const { store, filePath } = makeStore();
    store.setPassword("legacy", "old-style");
    // Rewrite the file into the pre-teamCode shape (bare encrypted string).
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    writeFileSync(filePath, JSON.stringify({ legacy: raw.legacy.password }));
    const reopened = new TeamStore(filePath, new SecretBox(KEY));
    expect(reopened.getPassword("legacy")).toBe("old-style");
    expect(reopened.list()).toEqual([{ icpcId: "legacy" }]);
  });
});

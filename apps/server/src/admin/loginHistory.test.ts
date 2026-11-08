import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LoginHistoryStore } from "./loginHistory";

describe("LoginHistoryStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "login-history-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (icpcId: string, at: string) => ({ icpcId, teamCode: `code-${icpcId}`, at, ip: null });

  test("list returns newest first", () => {
    const s = new LoginHistoryStore(join(dir, "login-history.json"));
    s.append(entry("t1", "2026-01-01T08:00:00.000Z"));
    s.append(entry("t2", "2026-01-01T09:00:00.000Z"));
    const rows = s.list();
    expect(rows.length).toBe(2);
    expect(rows[0].icpcId).toBe("t2");
    expect(rows[1].icpcId).toBe("t1");
  });

  test("limit caps the returned rows", () => {
    const s = new LoginHistoryStore(join(dir, "login-history.json"));
    for (let i = 0; i < 5; i++) s.append(entry(`t${i}`, `2026-01-0${i + 1}T00:00:00.000Z`));
    expect(s.list(2).length).toBe(2);
    expect(s.list(2)[0].icpcId).toBe("t4");
  });

  test("cap keeps only the last N entries (injectable cap)", () => {
    const s = new LoginHistoryStore(join(dir, "login-history.json"), 3);
    for (let i = 0; i < 5; i++) s.append(entry(`t${i}`, `2026-01-0${i + 1}T00:00:00.000Z`));
    const rows = s.list(100);
    expect(rows.length).toBe(3);
    // oldest three dropped, newest survive
    expect(rows.map((r) => r.icpcId)).toEqual(["t4", "t3", "t2"]);
  });

  test("entries persist across store instances", () => {
    const path = join(dir, "login-history.json");
    const s = new LoginHistoryStore(path);
    s.append(entry("t1", "2026-01-01T08:00:00.000Z"));
    const s2 = new LoginHistoryStore(path);
    expect(s2.list().length).toBe(1);
    expect(s2.list()[0].teamCode).toBe("code-t1");
  });

  test("ip is stored verbatim (null allowed)", () => {
    const s = new LoginHistoryStore(join(dir, "login-history.json"));
    s.append({ icpcId: "t1", teamCode: "c", at: "2026-01-01T08:00:00.000Z", ip: "127.0.0.1" });
    expect(s.list()[0].ip).toBe("127.0.0.1");
  });
});

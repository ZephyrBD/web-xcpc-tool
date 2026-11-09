import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyDataDir } from "./dataRoot";
import { JsonStore, setDataDir } from "./store";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-root-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  setDataDir("");
});

describe("migrateLegacyDataDir", () => {
  it("moves store files from <root>/data/ up into <root>/", () => {
    const root = makeDir();
    const legacy = join(root, "data");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "teams.json"), JSON.stringify([{ id: "t1" }]), "utf8");
    writeFileSync(join(legacy, "settings.json"), JSON.stringify({ port: 9 }), "utf8");

    const moved = migrateLegacyDataDir(root);

    expect(moved.sort()).toEqual(["settings.json", "teams.json"]);
    expect(JSON.parse(readFileSync(join(root, "teams.json"), "utf8"))).toEqual([{ id: "t1" }]);
    expect(existsSync(join(legacy, "teams.json"))).toBe(false);
    expect(existsSync(join(legacy, "settings.json"))).toBe(false);
  });

  it("is a no-op when there is no legacy directory", () => {
    const root = makeDir();
    expect(migrateLegacyDataDir(root)).toEqual([]);
  });

  it("never overwrites a top-level file that already exists", () => {
    const root = makeDir();
    const legacy = join(root, "data");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(root, "settings.json"), '{"port":1}', "utf8");
    writeFileSync(join(legacy, "settings.json"), '{"port":2}', "utf8");
    writeFileSync(join(legacy, "teams.json"), "[]", "utf8");

    const moved = migrateLegacyDataDir(root);

    expect(moved).toEqual(["teams.json"]);
    expect(readFileSync(join(root, "settings.json"), "utf8")).toBe('{"port":1}');
    // the legacy copy is left in place, not deleted
    expect(readFileSync(join(legacy, "settings.json"), "utf8")).toBe('{"port":2}');
  });

  it("ignores files that are not stores", () => {
    const root = makeDir();
    const legacy = join(root, "data");
    mkdirSync(join(legacy, "pdf"), { recursive: true });
    writeFileSync(join(legacy, "notes.txt"), "x", "utf8");

    expect(migrateLegacyDataDir(root)).toEqual([]);
    expect(existsSync(join(legacy, "notes.txt"))).toBe(true);
  });

  it("is idempotent: a second run finds nothing left to move", () => {
    const root = makeDir();
    const legacy = join(root, "data");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "teams.json"), "[]", "utf8");

    expect(migrateLegacyDataDir(root)).toEqual(["teams.json"]);
    expect(migrateLegacyDataDir(root)).toEqual([]);
  });

  it("a store written through the absolute root lands next to settings.json", () => {
    const root = makeDir();
    const legacy = join(root, "data");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "team-passwords.json"), '{"icpc1":{"teamCode":"abc"}}', "utf8");

    const dataRoot = root;
    migrateLegacyDataDir(dataRoot);
    setDataDir(dataRoot);
    const store = new JsonStore<Record<string, unknown>>(join(dataRoot, "team-passwords.json"), {});
    store.save({ ...store.load(), icpc2: { teamCode: "def" } });

    // one level only: the store file sits beside settings.json, not in data/data/
    expect(existsSync(join(root, "data", "data"))).toBe(false);    expect(JSON.parse(readFileSync(join(root, "team-passwords.json"), "utf8"))).toEqual({
      icpc1: { teamCode: "abc" },
      icpc2: { teamCode: "def" },
    });
  });
});

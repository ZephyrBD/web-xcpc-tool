import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as realFs from "node:fs";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore, setDataDir } from "./store";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  setDataDir("");
});

describe("JsonStore", () => {
  it("save writes the file with parseable JSON content", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    const store = new JsonStore<{ count: number }>(file, { count: 0 });
    store.save({ count: 42 });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ count: 42 });
  });

  it("load returns defaultValue when the file is missing", () => {
    const dir = makeDir();
    const store = new JsonStore<string[]>(join(dir, "missing.json"), ["a"]);
    expect(store.load()).toEqual(["a"]);
  });

  it("load reads back what save wrote", () => {
    const dir = makeDir();
    const store = new JsonStore<{ n: number }>(join(dir, "data.json"), { n: 0 });
    store.save({ n: 7 });
    expect(store.load()).toEqual({ n: 7 });
  });

  it("update applies fn to current value and persists it", () => {
    const dir = makeDir();
    const store = new JsonStore<{ n: number }>(join(dir, "data.json"), { n: 1 });
    const result = store.update((cur) => ({ n: cur.n + 1 }));
    expect(result).toEqual({ n: 2 });
    expect(store.load()).toEqual({ n: 2 });
  });

  it("update leaves the main file untouched when rename fails", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    const store = new JsonStore<{ n: number }>(file, { n: 1 });
    store.save({ n: 1 });

    const spy = spyOn(realFs, "renameSync").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      expect(() => store.update((cur) => ({ n: cur.n + 100 }))).toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ n: 1 });
  });

  it("load throws an Error naming the file when the main file is corrupt", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    writeFileSync(file, "{oops", "utf8");
    const store = new JsonStore<number>(file, 0);
    expect(() => store.load()).toThrow(file);
  });

  it("load throws an Error naming the tmp file when only a corrupt tmp exists", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    writeFileSync(file + ".tmp", "{oops", "utf8");
    const store = new JsonStore<number>(file, 0);
    expect(() => store.load()).toThrow(file + ".tmp");
  });

  it("load recovers from the tmp file when the main file is missing", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    writeFileSync(file + ".tmp", JSON.stringify({ recovered: true }), "utf8");
    const store = new JsonStore<{ recovered: boolean }>(file, { recovered: false });
    expect(store.load()).toEqual({ recovered: true });
  });

  it("cleaning up after tmp recovery removes the tmp file", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    writeFileSync(file + ".tmp", JSON.stringify({ recovered: true }), "utf8");
    const store = new JsonStore<{ recovered: boolean }>(file, { recovered: false });
    store.load();
    expect(existsSync(file + ".tmp")).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it("resolves relative paths against the module-level data dir", () => {
    const dir = makeDir();
    setDataDir(dir);
    const store = new JsonStore<{ ok: boolean }>("sub/data.json", { ok: false });
    store.save({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, "sub", "data.json"), "utf8"))).toEqual({ ok: true });
  });

  it("ignores the data dir for absolute paths", () => {
    const dir = makeDir();
    setDataDir(dir);
    const file = join(dir, "abs.json");
    const store = new JsonStore<number>(file, 0);
    store.save(5);
    expect(JSON.parse(readFileSync(file, "utf8"))).toBe(5);
  });
});

describe("leftover tmp handling on save", () => {
  it("save replaces any pre-existing tmp file", () => {
    const dir = makeDir();
    const file = join(dir, "data.json");
    writeFileSync(file + ".tmp", "stale", "utf8");
    const store = new JsonStore<number>(file, 0);
    store.save(3);
    expect(JSON.parse(readFileSync(file, "utf8"))).toBe(3);
  });
});

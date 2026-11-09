import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warnLegacyDataDir } from "./dataRoot";
import { initLogger } from "../log/logger";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-root-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  initLogger({ logFilePath: false });
});

describe("warnLegacyDataDir", () => {
  it("logs one WARN when a legacy data/ subdirectory exists", () => {
    const dir = makeDir();
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    initLogger({ logFilePath: join(dir, "latest.log"), stream, color: false });

    mkdirSync(join(dir, "data"), { recursive: true });
    warnLegacyDataDir(dir);

    expect(chunks.join("")).toContain("旧版数据目录");
  });

  it("is silent without the legacy directory", () => {
    const dir = makeDir();
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    initLogger({ logFilePath: join(dir, "latest.log"), stream, color: false });

    warnLegacyDataDir(dir);

    expect(chunks.join("")).toBe("");
  });
});

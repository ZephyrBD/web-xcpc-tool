import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config";
import { createApp } from "./server";

const CAPTURE_FILE = "fingerprints.jsonl";

describe("createApp", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "server-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET /health returns 200 and {\"ok\":true}", async () => {
    const cfg = loadConfig("/nonexistent/settings.json");
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("capture=true records a fingerprint line per request", async () => {
    const cfg = { ...loadConfig("/nonexistent/settings.json"), oms: { strategies: [], uaRegexes: [], capture: true } };
    const app = createApp(cfg, { dataDir });
    await app.request("/health");
    const capturePath = join(dataDir, CAPTURE_FILE);
    expect(existsSync(capturePath)).toBe(true);
    const lines = readFileSync(capturePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const fp = JSON.parse(lines[0]);
    expect(fp.method).toBe("GET");
    expect(fp.path).toBe("/health");
  });

  test("capture=false writes no capture file", async () => {
    const cfg = loadConfig("/nonexistent/settings.json");
    const app = createApp(cfg, { dataDir });
    await app.request("/health");
    expect(existsSync(join(dataDir, CAPTURE_FILE))).toBe(false);
  });
});

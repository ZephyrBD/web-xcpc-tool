import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config";
import { AuthQueue } from "./queue/authQueue";
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

  test("identified request is enqueued and auto-done when autoAccept is on", async () => {
    const cfg = {
      ...loadConfig("/nonexistent/settings.json"),
      oms: { strategies: ["ua-regex"], uaRegexes: [], capture: false },
    };
    const queue = new AuthQueue(join(dataDir, "auth-tasks.json"));
    queue.autoAccept = true;
    const app = createApp(cfg, { dataDir, authQueue: queue });
    const res = await app.request("/health", {
      headers: { "user-agent": "Mozilla/5.0 QtWebEngine/6.7" },
    });
    expect(res.status).toBe(200);
    const tasks = await (await app.request("/admin/api/auth-tasks?status=auto-done")).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].examNum).toBe("unknown");
    expect(tasks[0].strategy).toBe("ua-regex");
    expect(tasks[0].clientId).toBeNull();
  });

  test("unidentified request does not enqueue", async () => {
    const cfg = {
      ...loadConfig("/nonexistent/settings.json"),
      oms: { strategies: ["ua-regex"], uaRegexes: [], capture: false },
    };
    const queue = new AuthQueue(join(dataDir, "auth-tasks.json"));
    const app = createApp(cfg, { dataDir, authQueue: queue });
    await app.request("/health", { headers: { "user-agent": "curl/8.0" } });
    expect(queue.list().length).toBe(0);
  });

  test("uses deps.server.requestIP for the client ip in captured fingerprints", async () => {
    const cfg = { ...loadConfig("/nonexistent/settings.json"), oms: { strategies: [], uaRegexes: [], capture: true } };
    const app = createApp(cfg, {
      dataDir,
      server: { requestIP: () => ({ address: "1.2.3.4" }) },
    });
    await app.request("/health");
    const fp = JSON.parse(readFileSync(join(dataDir, CAPTURE_FILE), "utf8"));
    expect(fp.ip).toBe("1.2.3.4");
  });
});

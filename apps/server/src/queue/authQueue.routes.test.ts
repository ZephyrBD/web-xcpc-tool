import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthQueue } from "./authQueue";
import { loadConfig } from "../config";
import { createApp } from "../server";
import { setDataDir } from "../store/store";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "authqueue-routes-"));
  setDataDir(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  setDataDir("");
});

describe("auth queue routes", () => {
  test("GET /admin/api/auth-tasks lists tasks", async () => {
    const cfg = loadConfig("/nonexistent/settings.json");
    const app = createApp(cfg, { dataDir });
    const res = await app.request("/admin/api/auth-tasks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST approve/reject transitions a task", async () => {
    const cfg = loadConfig("/nonexistent/settings.json");
    const q = new AuthQueue();
    q.autoAccept = false;
    const t = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    const app = createApp(cfg, { dataDir, authQueue: q });

    const res = await app.request(`/admin/api/auth-tasks/${t.id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");

    const list = await (await app.request("/admin/api/auth-tasks")).json();
    expect(list.length).toBe(1);
  });
});

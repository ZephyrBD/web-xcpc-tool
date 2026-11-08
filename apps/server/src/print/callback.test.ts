import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { createApp } from "../server";
import { adminAuthHeaders } from "../admin/auth";
import { PrintQueue } from "./queue";
import { SseBus } from "../sse/bus";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "printcb-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeMultipart(): BodyInit {
  const form = new FormData();
  form.set("location", "room1");
  form.set("teamname", "team-a");
  form.set("teamid", "42");
  form.set("original", "main.cpp");
  form.set("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" }), "main.pdf");
  return form;
}

describe("POST /dj/print", () => {
  test("correct token saves pdf, enqueues pending task, publishes SSE event", async () => {
    const cfg = { ...loadConfigWithSecret(), print: { token: "secret" } };
    const bus = new SseBus();
    const events: { event: string; data: unknown }[] = [];
    bus.subscribe("admin", (e) => events.push(e));
    const app = createApp(cfg, { dataDir, bus });

    const res = await app.request("/dj/print", {
      method: "POST",
      headers: { "org.domjudge.print-token": "secret" },
      body: makeMultipart(),
    });
    expect(res.status).toBe(200);

    const pdfDir = join(dataDir, "pdf");
    expect(existsSync(pdfDir)).toBe(true);
    const files = readdirSync(pdfDir);
    expect(files.length).toBe(1);
    expect(readFileSync(join(pdfDir, files[0])).byteLength).toBe(4);

    const tasks = await (await app.request("/admin/api/print-tasks", { headers: await adminAuthHeaders(cfg) })).json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].location).toBe("room1");
    expect(tasks[0].teamName).toBe("team-a");
    expect(tasks[0].teamId).toBe("42");
    expect(tasks[0].originalFilename).toBe("main.pdf");

    expect(events.length).toBe(1);
    expect(events[0].event).toBe("print-task");
    expect((events[0].data as { id: string }).id).toBe(tasks[0].id);
  });

  test("missing token is 403 and writes no file", async () => {
    const cfg = { ...loadConfigWithSecret(), print: { token: "secret" } };
    const app = createApp(cfg, { dataDir });

    const res = await app.request("/dj/print", { method: "POST", body: makeMultipart() });
    expect(res.status).toBe(403);
    expect(existsSync(join(dataDir, "pdf"))).toBe(false);
    expect((await (await app.request("/admin/api/print-tasks", { headers: await adminAuthHeaders(cfg) })).json()).length).toBe(0);
  });

  test("wrong token is 403", async () => {
    const cfg = { ...loadConfigWithSecret(), print: { token: "secret" } };
    const app = createApp(cfg, { dataDir });

    const res = await app.request("/dj/print", {
      method: "POST",
      headers: { "org.domjudge.print-token": "wrong" },
      body: makeMultipart(),
    });
    expect(res.status).toBe(403);
    expect(existsSync(join(dataDir, "pdf"))).toBe(false);
  });

  test("ack route transitions task status, default printed", async () => {
    const cfg = { ...loadConfigWithSecret(), print: { token: "secret" } };
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    const app = createApp(cfg, { dataDir, printQueue });
    const t = printQueue.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "main.pdf",
      pdfPath: "pdf/x.pdf",
    });

    const r1 = await app.request(`/admin/api/print-tasks/${t.id}/ack`, { method: "POST", headers: await adminAuthHeaders(cfg) });
    expect(r1.status).toBe(200);
    const a1 = await r1.json();
    expect(a1.status).toBe("printed");

    const t2 = printQueue.add({
      location: "room2",
      teamName: "b",
      teamId: "43",
      originalFilename: "b.pdf",
      pdfPath: "pdf/y.pdf",
    });
    const r2 = await app.request(`/admin/api/print-tasks/${t2.id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminAuthHeaders(cfg)) },
      body: JSON.stringify({ status: "failed" }),
    });
    expect(r2.status).toBe(200);
    expect((await r2.json()).status).toBe("failed");

    const r404 = await app.request("/admin/api/print-tasks/nope/ack", { method: "POST", headers: await adminAuthHeaders(cfg) });
    expect(r404.status).toBe(404);
  });
});

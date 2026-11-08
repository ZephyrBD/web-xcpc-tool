import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { createApp } from "../server";
import { adminAuthHeaders } from "../admin/auth";
import { PrintQueue } from "./queue";

const loadConfigWithSecret = () => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
});

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "srcroute-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /admin/api/print-tasks/:id/source-html", () => {
  function setup() {
    const cfg = loadConfigWithSecret();
    const printedDir = join(dataDir, "printed");
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    return { cfg, printedDir, printQueue };
  }

  function addTask(queue: PrintQueue, sourcePath?: string) {
    return queue.add({
      location: "I1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "main.cpp",
      pdfPath: join(dataDir, "pdf", `${queue.list().length}.pdf`),
      sourcePath,
    });
  }

  test("unauthenticated request is 401", async () => {
    const { cfg, printQueue } = setup();
    const task = addTask(printQueue, "whatever");
    const app = createApp(cfg, { dataDir, printQueue });
    const res = await app.request(`/admin/api/print-tasks/${task.id}/source-html`);
    expect(res.status).toBe(401);
  });

  test("unknown task id is 404", async () => {
    const { cfg, printQueue } = setup();
    const app = createApp(cfg, { dataDir, printQueue });
    const res = await app.request("/admin/api/print-tasks/nope/source-html", {
      headers: await adminAuthHeaders(cfg),
    });
    expect(res.status).toBe(404);
  });

  test("task without a source archive (legacy/PDF upload) is 404", async () => {
    const { cfg, printQueue } = setup();
    const task = addTask(printQueue);
    const app = createApp(cfg, { dataDir, printQueue });
    const res = await app.request(`/admin/api/print-tasks/${task.id}/source-html`, {
      headers: await adminAuthHeaders(cfg),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "source not archived" });
  });

  test("serves the print HTML document for the archived source", async () => {
    const { cfg, printedDir, printQueue } = setup();
    const sourceDir = join(printedDir, "task-1");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "main.cpp"), "int main(){\nprintf(\"hi\");\n}\n");
    const task = addTask(printQueue, join(sourceDir, "main.cpp"));
    const app = createApp(cfg, { dataDir, printQueue });

    const res = await app.request(`/admin/api/print-tasks/${task.id}/source-html`, {
      headers: await adminAuthHeaders(cfg),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<pre>");
    expect(html).toContain("[I1] team-a (42) | ");
    expect(html).toContain("printf(&quot;hi&quot;);");
    expect(html).toContain("--- Web XCPC Tool ---");
  });

  test("tampered sourcePath outside the printed dir never leaks file content", async () => {
    const { cfg, printQueue } = setup();
    const secretPath = join(dataDir, "secret.txt");
    writeFileSync(secretPath, "TOP-SECRET-DB-DUMP");
    const evil = addTask(printQueue, secretPath);
    const app = createApp(cfg, { dataDir, printQueue });

    const res = await app.request(`/admin/api/print-tasks/${evil.id}/source-html`, {
      headers: await adminAuthHeaders(cfg),
    });
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("TOP-SECRET-DB-DUMP");
  });

  test("the admin task list never exposes sourcePath", async () => {
    const { cfg, printedDir, printQueue } = setup();
    mkdirSync(printedDir, { recursive: true });
    addTask(printQueue, join(printedDir, "x.cpp"));
    const app = createApp(cfg, { dataDir, printQueue });
    const res = await app.request("/admin/api/print-tasks", {
      headers: await adminAuthHeaders(cfg),
    });
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("sourcePath");
  });
});

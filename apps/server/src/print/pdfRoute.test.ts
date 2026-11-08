import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  dataDir = mkdtempSync(join(tmpdir(), "pdfroute-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /admin/api/print-tasks/:id/pdf", () => {
  function setup() {
    const cfg = loadConfigWithSecret();
    const pdfDir = join(dataDir, "pdf");
    mkdirSync(pdfDir, { recursive: true });
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    writeFileSync(join(pdfDir, "abc.pdf"), pdfBytes);
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    const task = printQueue.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "main code.pdf",
      pdfPath: join(pdfDir, "abc.pdf"),
    });
    const app = createApp(cfg, { dataDir, printQueue });
    return { cfg, app, task, pdfBytes };
  }

  test("unauthenticated request is 401", async () => {
    const { app, task } = setup();
    const res = await app.request(`/admin/api/print-tasks/${task.id}/pdf`);
    expect(res.status).toBe(401);
  });

  test("unknown task id is 404", async () => {
    const { cfg, app } = setup();
    const res = await app.request("/admin/api/print-tasks/nope/pdf", {
      headers: await adminAuthHeaders(cfg),
    });
    expect(res.status).toBe(404);
  });

  test("valid task serves byte-identical pdf inline", async () => {
    const { cfg, app, task, pdfBytes } = setup();
    const res = await app.request(`/admin/api/print-tasks/${task.id}/pdf`, {
      headers: await adminAuthHeaders(cfg),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(pdfBytes);
    expect(body.byteLength).toBe(pdfBytes.byteLength);
  });

  test("tampered pdfPath outside the pdf dir never leaks file content", async () => {
    const { cfg } = setup();
    const secretBytes = new TextEncoder().encode("TOP-SECRET-DB-DUMP");
    const secretPath = join(dataDir, "secret.txt");
    writeFileSync(secretPath, secretBytes);
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    const evil = printQueue.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "evil.pdf",
      pdfPath: secretPath,
    });
    const app = createApp(cfg, { dataDir, printQueue });

    const res = await app.request(`/admin/api/print-tasks/${evil.id}/pdf`, {
      headers: await adminAuthHeaders(cfg),
    });
    expect([403, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("TOP-SECRET-DB-DUMP");
  });

  test("traversal-style pdfPath escaping the pdf dir is rejected", async () => {
    const { cfg } = setup();
    const printQueue = new PrintQueue(join(dataDir, "print-tasks.json"));
    const evil = printQueue.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "evil.pdf",
      pdfPath: join(dataDir, "pdf", "..", "..", "etc", "passwd"),
    });
    const app = createApp(cfg, { dataDir, printQueue });

    const res = await app.request(`/admin/api/print-tasks/${evil.id}/pdf`, {
      headers: await adminAuthHeaders(cfg),
    });
    expect([403, 404]).toContain(res.status);
  });
});

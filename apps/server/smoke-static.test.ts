import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { loadConfig } from "./src/config";
import { createApp } from "./src/server";

// End-to-end smoke: serve the real production build output under /cxtool.
describe("production static smoke", () => {
  const staticDir = join(import.meta.dir, "static");
  const built = Bun.file(join(staticDir, "index.html")).size > 0;
  describe.skipIf(!built)("[requires `bun run build` in apps/admin]", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "smoke-data-"));
    const cfg = { ...loadConfig("/nonexistent/settings.json"), jwt: { secret: "s", ttlSeconds: 60 }, contextPath: "/cxtool" };
    const app = new Hono().route(
      "/cxtool",
      createApp(cfg, { dataDir, staticDir }),
    );

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  test("/cxtool/ returns the admin HTML referencing /cxtool/assets/", async () => {
    const res = await app.request("/cxtool/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/cxtool/assets/");
    expect(html).toMatch(/\/cxtool\/assets\/index-[\w-]+\.js/);
  });

  test("hashed asset serves with correct MIME", async () => {
    const hashed = readdirSync(join(staticDir, "assets")).find((f) => /^index-[\w-]+\.js$/.test(f));
    if (!hashed) throw new Error("no hashed js asset in static/assets");
    const res = await app.request(`/cxtool/assets/${hashed}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript");
    expect(await res.text()).toBe(readFileSync(join(staticDir, "assets", hashed), "utf8"));
  });

  test("deep link /cxtool/login serves the SPA", async () => {
    const res = await app.request("/cxtool/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
  });
});

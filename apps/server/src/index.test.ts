import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { createApp } from "./server";

describe("index contextPath wiring", () => {
  test("contextPath nests routes so /wxt/health resolves and bare /health 404s", async () => {
    const cfg = { ...loadConfig("/nonexistent/settings.json"), contextPath: "/wxt" };
    const app = createApp(cfg);
    // mirrors the wrapping done in index.ts
    const serving = new Hono().route(cfg.contextPath, app);

    const nested = await serving.request("/wxt/health");
    expect(nested.status).toBe(200);
    expect(await nested.json()).toEqual({ ok: true });

    const bare = await serving.request("/health");
    expect(bare.status).toBe(404);
  });
});

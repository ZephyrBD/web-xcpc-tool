import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { CONTEXT_PATH, loadConfig } from "./config";
import { createApp } from "./server";

describe("index mount wiring", () => {
  test("routes are mounted at the fixed /wxt path, so bare /health 404s", async () => {
    const app = createApp(loadConfig("/nonexistent/settings.json"));
    // mirrors the wrapping done in index.ts
    const serving = new Hono().route(CONTEXT_PATH, app);

    const nested = await serving.request("/wxt/health");
    expect(nested.status).toBe(200);
    expect(await nested.json()).toEqual({ ok: true });

    const bare = await serving.request("/health");
    expect(bare.status).toBe(404);
  });
});

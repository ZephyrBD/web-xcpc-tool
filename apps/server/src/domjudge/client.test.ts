import { describe, expect, test } from "bun:test";
import { DjClient, DjApiError } from "./client";
import type { Config } from "../config";

const djCfg: Config["domjudge"] = {
  baseUrl: "http://mock.local/domjudge",
  adminUser: "admin",
  adminPassword: "hunter2",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DjClient", () => {
  test("getTeams joins URL, sends Basic Auth, parses JSON array", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization") ?? "";
      return jsonResponse([{ id: "1", name: "Team One" }]);
    }) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    const teams = await client.getTeams("c1");
    expect(teams).toEqual([{ id: "1", name: "Team One" }]);
    expect(capturedUrl).toBe("http://mock.local/domjudge/api/v4/contests/c1/teams");
    expect(capturedAuth).toBe(`Basic ${Buffer.from("admin:hunter2").toString("base64")}`);
  });

  test("404 throws DjApiError with URL and status in message", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "nf" }, 404)) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    try {
      await client.getTeams("nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DjApiError);
      const e = err as DjApiError;
      expect(e.status).toBe(404);
      expect(e.url).toBe("http://mock.local/domjudge/api/v4/contests/nope/teams");
      expect(e.message).toContain(e.url);
      expect(e.message).toContain("404");
    }
  });

  test("connection failure throws DjApiError with status 0", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    try {
      await client.getContests();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DjApiError);
      const e = err as DjApiError;
      expect(e.status).toBe(0);
      expect(e.message).toContain("http://mock.local/domjudge/api/v4/contests");
    }
  });

  test("fetch that never resolves rejects with DjApiError after timeoutMs", async () => {
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
      })) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl, 50);
    let settled = false;
    let err: unknown = null;
    client.getContests().then(
      () => (settled = true),
      (e) => {
        err = e;
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(true);
    expect(err).toBeInstanceOf(DjApiError);
    expect((err as DjApiError).status).toBe(0);
  });
});

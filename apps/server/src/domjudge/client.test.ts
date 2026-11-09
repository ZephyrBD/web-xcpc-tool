import { describe, expect, test } from "bun:test";
import { DjClient, DjApiError } from "./client";
import type { Config } from "../config";

const djCfg: Config["domjudge"] = {
  baseUrl: "http://mock.local/domjudge",
  adminUser: "admin",
  adminPassword: "hunter2", timeoutSeconds: 10,
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

  test("findTeamUser prefers the team_id match and falls back to team<id> usernames", async () => {
    const DJ_USERS = [
      { id: "9", username: "juryuser", roles: ["jury"] },
      { id: "7", username: "team1095218", team_id: "1095218", roles: ["team"] },
      { id: "8", username: "team777", roles: ["team"] },
    ];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/v4/users")) return jsonResponse(DJ_USERS);
      return jsonResponse({ error: "nf" }, 404);
    }) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    // team_id match wins even when a team<id> username also exists
    expect(await client.findTeamUser("1095218")).toMatchObject({ id: "7", username: "team1095218" });
    // fallback: username `team<key>` when no team_id matches
    expect(await client.findTeamUser("777")).toMatchObject({ id: "8", username: "team777" });
    expect(await client.findTeamUser("999")).toBeNull();
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

  test("getJudgings normalizes CLICS submission_id to submission (demo-verified shape)", async () => {
    // Exact shape from https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/judgements
    const demoJudging = {
      start_time: "2026-11-07T10:00:01+00:00",
      end_time: "2026-11-07T10:00:04+00:00",
      submission_id: "997",
      current: true,
      max_run_time: 2.994,
      id: "1814",
      valid: true,
      score: "0.000000000",
      judgement_type_id: "TLE",
      simplified_judgement_type_id: "RE",
    };
    const fetchImpl = (async () => jsonResponse([demoJudging])) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    const judgings = await client.getJudgings("c1");
    expect(judgings).toHaveLength(1);
    expect(judgings[0].submission).toBe("997");
    expect(judgings[0].submission_id).toBe("997");
    expect(judgings[0].judgement_type_id).toBe("TLE");
    expect(judgings[0].id).toBe("1814");
  });

  test("getJudgings keeps internal-API 'submission' field unchanged", async () => {
    const legacy = { id: "j1", submission: "s1", judgement_type_id: "AC" };
    const fetchImpl = (async () => jsonResponse([legacy])) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    const judgings = await client.getJudgings("c1");
    expect(judgings).toEqual([legacy]);
  });

  test("getSubmissions normalizes CLICS problem_id/team_id to problem/team (demo-verified shape)", async () => {
    // Exact shape from https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/submissions
    const demoSubmission = {
      language_id: "cpp",
      time: "2026-11-07T10:00:00+00:00",
      contest_time: "-01:23:45",
      team_id: "domjudge",
      account_id: "tobi",
      problem_id: "arcadecrane",
      files: [{ href: "https://example.com/source", mime: "text/plain" }],
      id: "997",
      entry_point: null,
      import_error: null,
    };
    const fetchImpl = (async () => jsonResponse([demoSubmission])) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    const subs = await client.getSubmissions("c1");
    expect(subs).toHaveLength(1);
    expect(subs[0].problem).toBe("arcadecrane");
    expect(subs[0].team).toBe("domjudge");
    expect(subs[0].language).toBe("cpp");
    expect(subs[0].problem_id).toBe("arcadecrane");
    expect(subs[0].team_id).toBe("domjudge");
    expect(subs[0].id).toBe("997");
  });

  test("getSubmissions keeps internal-API problem/team/language fields unchanged", async () => {
    const legacy = {
      id: "s1",
      problem: "p1",
      language: "cpp",
      team: "t1",
      time: "2026-11-07T10:00:00+00:00",
    };
    const fetchImpl = (async () => jsonResponse([legacy])) as unknown as typeof fetch;
    const client = new DjClient(djCfg, fetchImpl);
    expect(await client.getSubmissions("c1")).toEqual([legacy]);
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

  describe("live config (runtime config store getter)", () => {
    /** Records the abort signal's eventual timeout and the headers of each call. */
    function recordingFetch() {
      const calls: Array<{ url: string; auth: string | null }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return jsonResponse([]);
      }) as unknown as typeof fetch;
      return { calls, fetchImpl };
    }

    test("domjudge.timeoutSeconds is applied per request when built from a getter", async () => {
      // Spy on AbortSignal.timeout to capture the exact budget handed to fetch.
      const original = AbortSignal.timeout;
      const budgets: number[] = [];
      AbortSignal.timeout = ((ms: number) => {
        budgets.push(ms);
        return original.call(AbortSignal, ms);
      }) as typeof AbortSignal.timeout;
      try {
        let live: Config["domjudge"] = { ...djCfg, timeoutSeconds: 10 };
        const client = new DjClient(() => live, recordingFetch().fetchImpl);
        await client.getContests();
        expect(budgets).toEqual([10_000]);
        live = { ...live, timeoutSeconds: 3 };
        await client.getContests();
        expect(budgets).toEqual([10_000, 3_000]);
      } finally {
        AbortSignal.timeout = original;
      }
    });

    test("an explicit constructor timeout still wins over the live config", async () => {
      const original = AbortSignal.timeout;
      const budgets: number[] = [];
      AbortSignal.timeout = ((ms: number) => {
        budgets.push(ms);
        return original.call(AbortSignal, ms);
      }) as typeof AbortSignal.timeout;
      try {
        const client = new DjClient(() => ({ ...djCfg, timeoutSeconds: 10 }), recordingFetch().fetchImpl, 250);
        await client.getContests();
        expect(budgets).toEqual([250]);
      } finally {
        AbortSignal.timeout = original;
      }
    });

    test("URL and credentials follow the getter; a failing getter leaves the client intact", async () => {
      const { calls, fetchImpl } = recordingFetch();
      let live: Config["domjudge"] | null = { ...djCfg };
      const client = new DjClient(() => {
        if (!live) throw new Error("config unavailable");
        return live;
      }, fetchImpl);

      await client.getContests();
      live = { baseUrl: "https://dj2.example.com", adminUser: "u2", adminPassword: "p2", timeoutSeconds: 10 };
      await client.getContests();
      expect(calls[1].url).toBe("https://dj2.example.com/api/v4/contests");
      expect(calls[1].auth).toBe(`Basic ${Buffer.from("u2:p2").toString("base64")}`);

      // A throwing getter rejects the call but never corrupts the stored state.
      live = null;
      await expect(client.getContests()).rejects.toThrow("config unavailable");
      live = { ...djCfg };
      await client.getContests();
      expect(calls[2].url).toBe("http://mock.local/domjudge/api/v4/contests");
    });
  });
});

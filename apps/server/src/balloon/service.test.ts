import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DjClient, type DjJudging, type DjJudgementType, type DjSubmission } from "../domjudge/client";
import { SseBus } from "../sse/bus";
import { JsonStore, setDataDir } from "../store/store";
import { BalloonService, type BalloonTask } from "./service";

const CONTEST = "c1";
const BASE = "https://dj.example.com/api/v4/";

let tmpDir: string;

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "balloon-test-"));
  setDataDir(tmpDir);
});

// Mirrors the REAL DOMjudge external contest API shape (verified live against
// https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/judgement-types):
// ids are verdict codes like "AC"/"WA", no sorting_key, correctness via `solved`.
const judgementTypes: DjJudgementType[] = [
  { id: "CE", name: "compiler error", penalty: false, solved: false },
  { id: "AC", name: "accepted", penalty: false, solved: true },
  { id: "WA", name: "wrong answer", penalty: true, solved: false },
];

// Mirrors the REAL DOMjudge external contest API shape (verified live against
// https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/submissions and
// /judgements): CLICS field names `problem_id`/`team_id`/`language_id` and
// `submission_id` — the client normalizes them to `problem`/`team`/`language`
// and `submission`.
const submissions = [
  {
    language_id: "cpp",
    time: "2026-11-07T10:00:00+00:00",
    contest_time: "+00:05:00",
    team_id: "t1",
    account_id: "team-one",
    problem_id: "p1",
    files: [{ href: "https://dj.example.com/source", mime: "text/plain" }],
    id: "s1",
    entry_point: null,
    import_error: null,
  },
  {
    language_id: "cpp",
    time: "2026-11-07T10:05:00+00:00",
    contest_time: "+00:10:00",
    team_id: "t2",
    account_id: "team-two",
    problem_id: "p1",
    files: [{ href: "https://dj.example.com/source", mime: "text/plain" }],
    id: "s2",
    entry_point: null,
    import_error: null,
  },
] as DjSubmission[];

const judgings = [
  {
    start_time: "2026-11-07T10:00:01+00:00",
    end_time: "2026-11-07T10:00:04+00:00",
    submission_id: "s1",
    current: true,
    max_run_time: 2.994,
    id: "j1",
    valid: true,
    score: "0.000000000",
    judgement_type_id: "AC",
    simplified_judgement_type_id: "AC",
  },
  {
    start_time: "2026-11-07T10:05:01+00:00",
    end_time: "2026-11-07T10:05:03+00:00",
    submission_id: "s2",
    current: true,
    max_run_time: 1.5,
    id: "j2",
    valid: true,
    score: "0.000000000",
    judgement_type_id: "WA",
    simplified_judgement_type_id: "WA",
  },
] as DjJudging[];

function makeFetch(overrides: {
  judgements?: DjJudging[];
  failJudgementsTimes?: number;
  failProblemsTimes?: number;
} = {}) {
  let failCount = overrides.failJudgementsTimes ?? 0;
  let failProblems = overrides.failProblemsTimes ?? 0;
  return ((url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
    if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
    if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
    if (u.startsWith(BASE + `contests/${CONTEST}/problems`)) {
      if (failProblems > 0) {
        failProblems--;
        return Promise.reject(new Error("problems endpoint down"));
      }
      return body([{ id: "p1", label: "A", name: "Alpha" }]);
    }
    if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) {
      if (failCount > 0) {
        failCount--;
        return Promise.reject(new Error("network down"));
      }
      return body(overrides.judgements ?? judgings);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
}

function makeService(
  fetchImpl: typeof fetch,
  schedule?: (fn: () => void, ms: number) => void,
  opts: { problems?: Array<{ id: string; label: string; name: string }> } = {},
) {
  const cfg = {
    baseUrl: "https://dj.example.com",
    adminUser: "admin",
    adminPassword: "pw", timeoutSeconds: 10,
  };
  const client = new DjClient(cfg, fetchImpl);
  const store = new JsonStore<BalloonTask[]>("balloon-tasks.json", []);
  const bus = new SseBus();
  const svc = new BalloonService({
    client,
    store,
    bus,
    contestId: CONTEST,
    pollIntervalSeconds: 10,
    teams: [{ id: "t1", name: "Team One" }],
    problems: opts.problems ?? [{ id: "p1", label: "A", name: "Alpha" }],
    schedule,
  });
  return { svc, store, bus };
}

describe("BalloonService", () => {
  test("pollOnce creates one task for the correct judging and publishes SSE", async () => {
    const { svc, bus } = makeService(makeFetch());
    const events: Array<{ event: string; data: unknown }> = [];
    bus.subscribe("admin", (e) => events.push(e));

    const created = await svc.pollOnce();
    expect(created).toBe(1);
    const tasks = svc.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "s1",
      contestId: CONTEST,
      problemLabel: "A",
      teamName: "Team One",
      location: null,
      status: "pending",
    });
    expect(typeof tasks[0].createdAt).toBe("string");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("balloon-task");
    expect(events[0].data).toMatchObject({ id: "s1" });
  });

  test("pollOnce uses the solved flag when no sorting_key is present", async () => {
    // Explicit demo-shape guard: AC (solved: true) creates a balloon, WA does not.
    const { svc } = makeService(makeFetch());
    const created = await svc.pollOnce();
    expect(created).toBe(1);
    const tasks = svc.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("s1");
  });

  test("pollOnce still matches the internal-API 'correct' shape", async () => {
    const internalTypes: DjJudgementType[] = [
      { id: "AC", sorting_key: "correct" },
      { id: "WA", sorting_key: "" },
    ];
    const fetchImpl = ((url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(internalTypes);
      if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
      if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) return body(judgings);
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    const created = await svc.pollOnce();
    expect(created).toBe(1);
    expect(svc.list()[0].id).toBe("s1");
  });

  test("re-polling the same submission does not duplicate tasks", async () => {
    const { svc } = makeService(makeFetch());
    await svc.pollOnce();
    const again = await svc.pollOnce();
    expect(again).toBe(0);
    expect(svc.list()).toHaveLength(1);
  });

  test("consecutive failures double the poll interval, success recovers", async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const schedule = (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
    };
    const { svc } = makeService(makeFetch({ failJudgementsTimes: 2 }), schedule);
    svc.start();

    // initial poll scheduled immediately
    expect(scheduled[0].ms).toBe(0);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    scheduled[0].fn(); // poll 1 fails -> next delay should be 2x
    await flush();
    scheduled[1].fn(); // poll 2 fails -> next delay should be 4x (>= 2x config)
    await flush();
    scheduled[2].fn(); // poll 3 succeeds -> next delay back to base
    await flush();
    svc.stop();

    expect(scheduled[1].ms).toBe(20_000);
    expect(scheduled[2].ms).toBe(40_000);
    expect(scheduled[2].ms).toBeGreaterThanOrEqual(20_000);
    expect(scheduled[3].ms).toBe(10_000);
  });

  test("ack transitions pending task to delivered; unknown id returns null", async () => {
    const { svc } = makeService(makeFetch());
    await svc.pollOnce();
    const acked = await svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(svc.list("delivered")).toHaveLength(1);
    expect(svc.list("pending")).toHaveLength(0);
    expect(await svc.ack("nope")).toBeNull();
  });

  test("ack with delivered status POSTs done to the matching domjudge balloon", async () => {
    const posts: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
      if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
      if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) return body(judgings);
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`) && (init?.method ?? "GET") === "POST") {
        posts.push(u);
        return body({ ok: true });
      }
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`)) {
        return body([{ balloonid: "7", teamid: "t1", problem: "p1", done: false }]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();
    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);

    const acked = await svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(posts).toEqual([BASE + `contests/${CONTEST}/balloons/7/done`]);
  });

  test("ack with two balloons for the same team POSTs only the matching problem", async () => {
    const posts: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
      if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
      if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) return body(judgings);
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`) && (init?.method ?? "GET") === "POST") {
        posts.push(u);
        return body({ ok: true });
      }
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`)) {
        // Same team, two problems: only problem A (id p1) may be marked done.
        return body([
          { balloonid: "11", teamid: "t1", problem: "p2", contestproblem: { label: "B" }, done: false },
          { balloonid: "7", teamid: "t1", problem: "p1", contestproblem: { label: "A" }, done: false },
        ]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();
    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);

    const acked = await svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(posts).toEqual([BASE + `contests/${CONTEST}/balloons/7/done`]);
  });

  test("ack skips already-done balloons (no re-POST)", async () => {
    const posts: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
      if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
      if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) return body(judgings);
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`) && (init?.method ?? "GET") === "POST") {
        posts.push(u);
        return body({ ok: true });
      }
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`)) {
        return body([{ balloonid: "7", teamid: "t1", problem: "p1", done: true }]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();
    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);

    const acked = await svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(posts).toHaveLength(0);
    expect(svc.list("delivered")).toHaveLength(1);
  });

  test("ack without a matching balloon only updates local status", async () => {
    const posts: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
      if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
      if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) return body(judgings);
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`) && (init?.method ?? "GET") === "POST") {
        posts.push(u);
        return body({ ok: true });
      }
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`)) {
        return body([{ balloonid: "9", teamid: "t-other", problem: "p1", done: false }]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();
    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);

    const acked = await svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(posts).toHaveLength(0);
    expect(svc.list("delivered")).toHaveLength(1);
  });

  test("balloon done POST failure is logged and the local ack still lands", async () => {
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
      if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
      if (u.startsWith(BASE + `contests/${CONTEST}/judgements`)) return body(judgings);
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`) && (init?.method ?? "GET") === "POST") {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      if (u.startsWith(BASE + `contests/${CONTEST}/balloons`)) {
        return body([{ balloonid: "7", teamid: "t1", problem: "p1", done: false }]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();
    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);

    const acked = await svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(svc.list("delivered")).toHaveLength(1);
  });

  // Demo-debugged regression: a restarted server polls before any team sync
  // ran, and every balloon task got the raw problem id as its label.
  test("pollOnce fetches problems itself when refresh never supplied them", async () => {
    const { svc } = makeService(makeFetch(), undefined, { problems: [] });
    const created = await svc.pollOnce();
    expect(created).toBe(1);
    expect(svc.list()[0].problemLabel).toBe("A");
  });

  test("pollOnce falls back to raw ids when its own problems fetch fails", async () => {
    const { svc } = makeService(makeFetch({ failProblemsTimes: 1 }), undefined, { problems: [] });
    const created = await svc.pollOnce();
    expect(created).toBe(1);
    expect(svc.list()[0].problemLabel).toBe("p1");
  });

  test("refresh re-labels pending tasks that were created with raw ids", async () => {
    const { svc } = makeService(makeFetch({ failProblemsTimes: 1 }), undefined, { problems: [] });
    await svc.pollOnce();
    expect(svc.list()[0].problemLabel).toBe("p1");

    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);
    expect(svc.list()[0].problemLabel).toBe("A");
  });

  test("refresh leaves delivered tasks and already-labeled tasks untouched", async () => {
    const { svc } = makeService(makeFetch({ failProblemsTimes: 1 }), undefined, { problems: [] });
    await svc.pollOnce();
    await svc.ack("s1");
    svc.refresh([{ id: "t1", name: "Team One" }], [{ id: "p1", label: "A", name: "Alpha" }]);
    expect(svc.list()[0].problemLabel).toBe("p1");
  });

  // Live-debugged gap: tasks created by a poll before team sync keep the raw
  // team id as teamName and null location; refresh must re-label those too.
  test("refresh re-labels teamName/location on pending tasks holding raw team ids", async () => {
    const { svc, store } = makeService(makeFetch());
    store.update((cur) => [
      ...cur,
      { id: "s9", contestId: CONTEST, problemLabel: "A", teamName: "111", location: null, status: "pending", createdAt: new Date().toISOString() },
    ]);

    svc.refresh(
      [{ id: "111", name: "VILNIUS TECH 1", location: { description: "I1" } }],
      [{ id: "p1", label: "A", name: "Alpha" }],
    );
    expect(svc.list().find((t) => t.id === "s9")).toMatchObject({
      teamName: "VILNIUS TECH 1",
      location: "I1",
    });
  });

  test("refresh leaves tasks whose teamName is already a real name untouched", async () => {
    const { svc, store } = makeService(makeFetch());
    store.update((cur) => [
      ...cur,
      { id: "s9", contestId: CONTEST, problemLabel: "A", teamName: "Already A Name", location: null, status: "pending", createdAt: new Date().toISOString() },
    ]);

    svc.refresh(
      [{ id: "111", name: "VILNIUS TECH 1", location: { description: "I1" } }],
      [{ id: "p1", label: "A", name: "Alpha" }],
    );
    const task = svc.list().find((t) => t.id === "s9")!;
    expect(task.teamName).toBe("Already A Name");
    expect(task.location).toBeNull();
  });

  test("refresh re-labels only pending tasks; delivered tasks keep raw ids", async () => {
    const { svc, store } = makeService(makeFetch());
    store.update((cur) => [
      ...cur,
      { id: "s9", contestId: CONTEST, problemLabel: "A", teamName: "111", location: null, status: "delivered", createdAt: new Date().toISOString() },
    ]);

    svc.refresh(
      [{ id: "111", name: "VILNIUS TECH 1", location: { description: "I1" } }],
      [{ id: "p1", label: "A", name: "Alpha" }],
    );
    const task = svc.list().find((t) => t.id === "s9")!;
    expect(task.teamName).toBe("111");
    expect(task.location).toBeNull();
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DjClient, type DjBalloon } from "../domjudge/client";
import { SseBus } from "../sse/bus";
import { JsonStore, setDataDir } from "../store/store";
import { BalloonService, type BalloonTask } from "./service";

const CONTEST = "c1";
const BASE = "https://dj.example.com/api/v4/";
const BALLOONS_URL = `${BASE}contests/${CONTEST}/balloons`;

let tmpDir: string;

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "balloon-test-"));
  setDataDir(tmpDir);
});

/**
 * Real DOMjudge balloon entries (GET /contests/{cid}/balloons): the problem
 * label lives on `contestproblem.label`, times are either absolute (`time`) or
 * clock-relative (`contesttime`), and `done` is DOMjudge's delivery flag.
 */
const balloonsWithOneDone: DjBalloon[] = [
  {
    balloonid: "7",
    teamid: "t1",
    problem: "p1",
    contestproblem: { id: "p1", label: "A", name: "Alpha" },
    time: "2026-11-07T10:00:05+00:00",
    contesttime: "+00:05:00",
    done: false,
  },
  {
    balloonid: "9",
    teamid: "t2",
    problem: "p2",
    contestproblem: { id: "p2", label: "B", name: "Beta" },
    contesttime: "+00:12:30",
    done: true,
  },
];

type FetchCall = { method: string; url: string };

/**
 * Controllable DOMjudge fake: `balloons` is read at request time, so a test can
 * change what the next poll sees (done flips, removals). Every request is
 * recorded so the "balloons API only" rule can be asserted directly.
 */
function makeFetch(initial: DjBalloon[] = []) {
  let balloons = initial;
  const calls: FetchCall[] = [];
  let balloonsStatus: number | null = null;
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u });
    const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
    if (u.startsWith(BALLOONS_URL) && method === "POST") return body({ ok: true });
    if (u.startsWith(BALLOONS_URL) && method === "GET") {
      if (balloonsStatus !== null) return Promise.resolve(new Response("nope", { status: balloonsStatus }));
      return body(balloons);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    setBalLoons: (next: DjBalloon[]) => {
      balloons = next;
    },
    failBalloonsWith: (status: number | null) => {
      balloonsStatus = status;
    },
    gets: () => calls.filter((c) => c.method === "GET").map((c) => c.url),
    posts: () => calls.filter((c) => c.method === "POST").map((c) => c.url),
  };
}

const TEAMS = [
  { id: "t1", name: "Team One", location: { description: "A-101" } },
  { id: "t2", name: "Team Two", location: { description: "B-202" } },
];

function makeClient(fetchImpl: typeof fetch) {
  return new DjClient(
    { baseUrl: "https://dj.example.com", adminUser: "admin", adminPassword: "pw", timeoutSeconds: 10 },
    fetchImpl,
  );
}

/** In-memory stand-in for the JSON store file (real disk writes add nothing here). */
function memoryStore(): JsonStore<BalloonTask[]> {
  const tasks: BalloonTask[] = [];
  return {
    load: () => tasks.slice(),
    save: (next: BalloonTask[]) => {
      tasks.splice(0, tasks.length, ...next);
    },
    update: (fn: (cur: BalloonTask[]) => BalloonTask[]) => {
      const next = fn(tasks.slice());
      tasks.splice(0, tasks.length, ...next);
      return tasks.slice();
    },
  } as unknown as JsonStore<BalloonTask[]>;
}

function makeService(
  fetchImpl: typeof fetch,
  schedule?: (fn: () => void, ms: number) => void,
  opts: { teams?: typeof TEAMS; contestId?: string } = {},
) {
  const client = makeClient(fetchImpl);
  const store = memoryStore();
  const bus = new SseBus();
  const svc = new BalloonService({
    client,
    store,
    bus,
    contestId: opts.contestId ?? CONTEST,
    pollIntervalSeconds: 10,
    teams: opts.teams ?? TEAMS,
    schedule,
  });
  return { svc, store, bus };
}

describe("BalloonService reads DOMjudge balloons", () => {
  test("two balloons (one done) become two tasks with the right status", async () => {
    const fake = makeFetch(balloonsWithOneDone);
    const { svc, bus } = makeService(fake.fetchImpl);
    const events: Array<{ event: string; data: unknown }> = [];
    bus.subscribe("admin", (e) => events.push(e));

    const changed = await svc.pollOnce();
    expect(changed).toBe(2);

    const tasks = svc.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === "7")).toMatchObject({
      id: "7",
      balloonId: 7,
      contestId: CONTEST,
      problemLabel: "A",
      teamName: "Team One",
      location: "A-101",
      status: "pending",
      createdAt: "2026-11-07T10:00:05.000Z",
    });
    expect(tasks.find((t) => t.id === "9")).toMatchObject({
      id: "9",
      problemLabel: "B",
      teamName: "Team Two",
      location: "B-202",
      status: "delivered",
    });
    expect(svc.list("pending").map((t) => t.id)).toEqual(["7"]);

    // Both new rows are announced so the UI can auto-deliver.
    expect(events.map((e) => e.event)).toEqual(["balloon-task", "balloon-task"]);
  });

  test("the ballonid is the task id and only the balloons endpoint is called", async () => {
    const fake = makeFetch(balloonsWithOneDone);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list().map((t) => t.id).sort()).toEqual(["7", "9"]);
    expect(fake.gets()).toEqual([BALLOONS_URL]);
  });

  test("judgements/submissions/judgement-types are never requested", async () => {
    const judgingCalls: string[] = [];
    const balloonClient = {
      getBalloons: async () => balloonsWithOneDone,
      getJudgings: async () => {
        judgingCalls.push("getJudgings");
        return [];
      },
      getSubmissions: async () => {
        judgingCalls.push("getSubmissions");
        return [];
      },
      getJudgementTypes: async () => {
        judgingCalls.push("getJudgementTypes");
        return [];
      },
      getProblems: async () => {
        judgingCalls.push("getProblems");
        return [];
      },
      markBalloonDone: async () => ({ ok: true }),
    };
    const svc = new BalloonService({
      client: balloonClient as never,
      store: memoryStore(),
      bus: new SseBus(),
      contestId: CONTEST,
      pollIntervalSeconds: 10,
      teams: TEAMS,
    });
    expect(await svc.pollOnce()).toBe(2);
    expect(judgingCalls).toEqual([]);
  });

  test("label falls back to the raw problem id when contestproblem is absent", async () => {
    const fake = makeFetch([
      { balloonid: "11", teamid: "t1", problemid: "p9", done: false },
      { balloonid: "12", teamid: "t1", done: false },
    ]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list().find((t) => t.id === "11")?.problemLabel).toBe("p9");
    expect(svc.list().find((t) => t.id === "12")?.problemLabel).toBe("");
  });

  test("an unknown team keeps the raw team id as name and a null location", async () => {
    const fake = makeFetch([{ balloonid: "5", teamid: "ghost", contestproblem: { label: "C" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list()[0]).toMatchObject({ teamName: "ghost", location: null, problemLabel: "C" });
  });

  test("re-polling unchanged balloons writes nothing and emits nothing", async () => {
    const fake = makeFetch(balloonsWithOneDone);
    const { svc, bus } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    const events: unknown[] = [];
    bus.subscribe("admin", (e) => events.push(e));
    expect(await svc.pollOnce()).toBe(0);
    expect(events).toHaveLength(0);
    expect(svc.list()).toHaveLength(2);
  });

  test("refresh() applies a late team sync to existing rows still holding raw team ids", async () => {
    // A task created before the team table was known keeps the raw team id.
    const { svc, store } = makeService(makeFetch().fetchImpl);
    store.save([
      { id: "3", contestId: CONTEST, problemLabel: "D", teamName: "t9", location: null, status: "pending", createdAt: "x" },
    ]);

    svc.refresh([{ id: "t9", name: "Real Name", location: { description: "C-303" } }]);
    expect(svc.list()[0]).toMatchObject({ teamName: "Real Name", location: "C-303" });
  });

  test("a team rename arrives with the next poll", async () => {
    const fake = makeFetch(balloonsWithOneDone);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list().find((t) => t.id === "7")?.teamName).toBe("Team One");

    // pollOnce resolves names from the current team table, so a rename lands
    // on the next poll (refresh() only relabels raw-id rows).
    svc.refresh([{ id: "t1", name: "Renamed One", location: { description: "A-101" } }, TEAMS[1]]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list().find((t) => t.id === "7")?.teamName).toBe("Renamed One");
  });
});

describe("BalloonService reconciles status from DOMjudge done", () => {
  test("a later poll flipping done→true marks the task delivered", async () => {
    const fake = makeFetch([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("pending");

    fake.setBalLoons([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list()[0].status).toBe("delivered");
  });

  test("a DOMjudge-side revert (done true→false) flips a delivered task back to pending", async () => {
    const fake = makeFetch([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    const { svc, store } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("delivered");

    // The operator reopened/undid the balloon in DOMjudge: DOMjudge wins.
    fake.setBalLoons([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list()[0].status).toBe("pending");

    // A row acked locally (delivered) also reverts with no ack in flight.
    store.update((cur) => cur.map((t) => ({ ...t, status: "delivered" })));
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("pending");
  });

  test("ack POSTs /balloons/{id}/done and does not optimistically mark it delivered", async () => {
    const fake = makeFetch([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();

    const acked = await svc.ack("7");
    expect(acked).not.toBeNull();
    expect(fake.posts()).toEqual([`${BALLOONS_URL}/7/done`]);
    // No local write from ack(): the row is only delivered once DOMjudge says so.
    expect(svc.list()[0].status).toBe("pending");
  });

  test("ack followed by a still-false poll does not mark the task delivered", async () => {
    const fake = makeFetch([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    await svc.ack("7");

    // DOMjudge never flipped `done` (rejected silently / different contest
    // state): the ack must not leave a phantom delivered row behind.
    expect(await svc.pollOnce()).toBe(0);
    expect(svc.list()[0].status).toBe("pending");

    // …and once DOMjudge does report done, the same ack lands.
    fake.setBalLoons([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("delivered");
  });

  test("ack for an unknown id returns null and POSTs nothing", async () => {
    const fake = makeFetch([]);
    const { svc } = makeService(fake.fetchImpl);
    expect(await svc.ack("nope")).toBeNull();
    expect(fake.posts()).toEqual([]);
  });

  test("a poll whose snapshot predates the ack POST does not revert a delivered row", async () => {
    // The UI reload can overlap the next scheduled poll. The `done: false`
    // snapshot such a poll fetched was produced before the POST landed, so it
    // must not undo the delivery; the *next* poll (after the POST) decides.
    const fake = makeFetch([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc, store } = makeService(fake.fetchImpl);
    await svc.pollOnce();

    let releasePost: (() => void) | null = null;
    const postGate = new Promise<void>((r) => {
      releasePost = r;
    });
    const gated = ((url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? postGate.then(() => new Response(JSON.stringify({ ok: true })))
        : fake.fetchImpl(url, init)) as unknown as typeof fetch;
    const gatedSvc = new BalloonService({
      client: makeClient(gated),
      store,
      bus: new SseBus(),
      contestId: CONTEST,
      pollIntervalSeconds: 10,
      teams: TEAMS,
    });

    const ackPromise = gatedSvc.ack("7");
    // The row is what DOMjudge reports after the POST; simulate it arriving
    // while the POST is still in flight by marking it delivered through a poll
    // that saw `done: true`.
    fake.setBalLoons([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    await gatedSvc.pollOnce(); // snapshot reads done:true → delivered
    expect(gatedSvc.list()[0].status).toBe("delivered");

    (releasePost as unknown as () => void)();
    await ackPromise;

    // DOMjudge still says done:true afterwards: the delivery stands.
    await gatedSvc.pollOnce();
    expect(gatedSvc.list()[0].status).toBe("delivered");
  });

  test("a POST failure is logged and the next done:false poll still lands the delivery", async () => {
    const posts: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
      if (u.startsWith(BALLOONS_URL) && init?.method === "POST") {
        posts.push(u);
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      if (u.startsWith(BALLOONS_URL)) {
        return body([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();

    const acked = await svc.ack("7");
    expect(acked).not.toBeNull();
    expect(posts).toEqual([`${BALLOONS_URL}/7/done`]);
    expect(svc.list()[0].status).toBe("pending");

    // DOMjudge can never flip done after a failed POST, so the next poll that
    // still sees done:false treats the delivery as local-only.
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("delivered");
  });
});

describe("BalloonService stale balloons (gone from the API)", () => {
  test("a task whose balloonid disappears is kept, marked delivered, and hidden from pending", async () => {
    const fake = makeFetch([
      { balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false },
      { balloonid: "8", teamid: "t2", contestproblem: { label: "B" }, done: false },
    ]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list("pending")).toHaveLength(2);

    // Balloon 8 removed in DOMjudge (cancelled/reset). 7 stays pending.
    fake.setBalLoons([{ balloonid: "7", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    expect(await svc.pollOnce()).toBe(1);

    const tasks = svc.list();
    expect(tasks.map((t) => t.id).sort()).toEqual(["7", "8"]);
    expect(tasks.find((t) => t.id === "8")?.status).toBe("delivered");
    expect(svc.list("pending").map((t) => t.id)).toEqual(["7"]);
  });

  test("a delivered task whose balloon disappears is left untouched", async () => {
    const fake = makeFetch([{ balloonid: "8", teamid: "t2", contestproblem: { label: "B" }, done: true }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    fake.setBalLoons([]);
    expect(await svc.pollOnce()).toBe(0);
    expect(svc.list()[0]).toMatchObject({ id: "8", status: "delivered" });
  });

  test("tasks from another contest are never reconciled away", async () => {
    const fake = makeFetch([]);
    const { svc, store } = makeService(fake.fetchImpl);
    store.update((cur) => [
      ...cur,
      {
        id: "old",
        contestId: "previous-contest",
        problemLabel: "Z",
        teamName: "Ghost",
        location: null,
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    ]);
    await svc.pollOnce();
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0].status).toBe("pending");
  });
});

describe("BalloonService empty-list warning", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const emptyWarnings = () =>
    warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("气球列表为空：DOMjudge 可能未启用气球功能")).length;

  test("warns once on the 3rd consecutive empty poll, not before", async () => {
    const fake = makeFetch([]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(0);
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(1);
    // Once per streak: further empty polls stay quiet.
    await svc.pollOnce();
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(1);
  });

  test("a non-empty poll resets the streak so a later streak warns again", async () => {
    const fake = makeFetch([]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    await svc.pollOnce();
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(1);

    fake.setBalLoons([{ balloonid: "1", teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    await svc.pollOnce();
    fake.setBalLoons([]);
    await svc.pollOnce();
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(1);
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(2);
  });

  test("an empty contestId never schedules a poll and never warns", () => {
    const fake = makeFetch([]);
    const scheduled: Array<() => void> = [];
    const { svc } = makeService(fake.fetchImpl, (fn) => {
      scheduled.push(fn);
    }, { contestId: "" });
    svc.start();
    expect(scheduled).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(warn.mock.calls).toHaveLength(0);
  });
});

describe("BalloonService start guard", () => {
  test("start() with an empty contestId never schedules a poll", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const schedule = (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
    };
    const fetchImpl = (() => {
      throw new Error("balloon must not poll without a contest id");
    }) as unknown as typeof fetch;
    const svc = new BalloonService({
      client: makeClient(fetchImpl),
      store: memoryStore(),
      bus: new SseBus(),
      contestId: "",
      pollIntervalSeconds: 10,
      schedule,
    });
    svc.start();
    expect(scheduled).toHaveLength(0);
  });

  test("start() with a contestId still schedules the first poll immediately", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const { svc } = makeService(makeFetch().fetchImpl, (fn, ms) => {
      scheduled.push({ fn, ms });
    });
    svc.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(0);
    svc.stop();
  });

  test("consecutive poll failures double the interval, success recovers", async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const fake = makeFetch([]);
    fake.failBalloonsWith(500);
    const { svc } = makeService(fake.fetchImpl, (fn, ms) => {
      scheduled.push({ fn, ms });
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      svc.start();
      const flush = () => new Promise((r) => setTimeout(r, 0));
      scheduled[0].fn(); // poll 1 fails -> 2x
      await flush();
      scheduled[1].fn(); // poll 2 fails -> 4x
      await flush();
      fake.failBalloonsWith(null); // recover
      scheduled[2].fn(); // poll 3 succeeds -> base interval
      await flush();
      svc.stop();

      expect(scheduled[1].ms).toBe(20_000);
      expect(scheduled[2].ms).toBe(40_000);
      expect(scheduled[3].ms).toBe(10_000);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("BalloonService reconfigure (settings hot reload)", () => {
  const noPollFetch = (() => {
    throw new Error("balloon must not poll without a contest id");
  }) as unknown as typeof fetch;

  /** Isolated store per test: never the shared data dir the other suites write to. */
  function reconfService(contestId: string, fetchImpl: typeof fetch = noPollFetch) {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const dir = mkdtempSync(join(tmpdir(), "balloon-reconf-"));
    const svc = new BalloonService({
      client: makeClient(fetchImpl),
      store: new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []),
      bus: new SseBus(),
      contestId,
      pollIntervalSeconds: 30,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
    });
    return {
      svc,
      scheduled,
      cleanup: () => {
        svc.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("reconfigure onto a new contest restarts the loop against the new contest id", async () => {
    const fetched: string[] = [];
    const fetchImpl = ((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/contests/C2/")) fetched.push("C2");
      return Promise.resolve(new Response(JSON.stringify([])));
    }) as unknown as typeof fetch;
    const { svc, scheduled, cleanup } = reconfService("", fetchImpl);
    svc.start();
    expect(scheduled).toHaveLength(0); // no contest yet → inert

    svc.reconfigure({ contestId: "C2", pollIntervalSeconds: 5 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(0); // polls immediately

    scheduled[0].fn(); // the scheduled pollLoop tick, against C2
    for (let i = 0; i < 50 && scheduled.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(fetched.length).toBeGreaterThan(0);
    expect(scheduled[1].ms).toBe(5000); // new interval on the next tick
    cleanup();
  });

  test("reconfigure to an empty contest id stops the loop", () => {
    const { svc, scheduled, cleanup } = reconfService("C1");
    svc.start();
    expect(scheduled).toHaveLength(1);

    svc.reconfigure({ contestId: "", pollIntervalSeconds: 30 });
    svc.reconfigure({ contestId: "", pollIntervalSeconds: 30 }); // idempotent
    expect(scheduled).toHaveLength(1);
    cleanup();
  });

  test("reconfigure that only changes the interval keeps running with the new cadence", async () => {
    const { svc, scheduled, cleanup } = reconfService("c1", makeFetch().fetchImpl);
    svc.start();
    svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 7 });
    expect(scheduled).toHaveLength(2);
    scheduled[1].fn(); // the scheduled pollLoop tick (a successful poll)
    for (let i = 0; i < 50 && scheduled.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(scheduled[scheduled.length - 1].ms).toBe(7000);
    cleanup();
  });

  test("reconfigure to the same values does not restart the loop", () => {
    const { svc, scheduled, cleanup } = reconfService("C1");
    svc.start();
    svc.reconfigure({ contestId: "C1", pollIntervalSeconds: 30 });
    expect(scheduled).toHaveLength(1);
    cleanup();
  });

  test("reconfigure during an in-flight poll leaves exactly one polling chain", async () => {
    // Gate every request so the poll started by `start()` is still pending when
    // reconfigure() runs: that is the re-entrancy window a settings PUT opens.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFetch = (async () => {
      await gate;
      return new Response(JSON.stringify([]));
    }) as unknown as typeof fetch;
    const { svc, scheduled, cleanup } = reconfService("c1", gatedFetch);

    svc.start();
    expect(scheduled).toHaveLength(1);
    scheduled[0].fn(); // pollLoop starts, then awaits the gate
    // Let the in-flight poll reach its first await before reconfiguring.
    await Promise.resolve();

    svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 7 });
    // stop() + start(): the old chain is marked not running and one new poll is
    // scheduled. The stale in-flight poll must not add a second schedule.
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].ms).toBe(0);

    (release as unknown as () => void)();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    // Still exactly one chain: the finished stale poll saw `running === false`
    // after its (simulated) await and returned without scheduling.
    expect(scheduled).toHaveLength(2);

    // Running the surviving chain schedules exactly one next tick at the new cadence.
    scheduled[1].fn();
    for (let i = 0; i < 50 && scheduled.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(scheduled).toHaveLength(3);
    expect(scheduled[2].ms).toBe(7000);
    cleanup();
  });
});

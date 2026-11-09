import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DjClient, type DjBalloon } from "../domjudge/client";
import { SseBus } from "../sse/bus";
import { JsonStore, setDataDir } from "../store/store";
import { BalloonService, type BalloonTask, type BalloonLogger } from "./service";

/**
 * Records what the service reports, in the same `(name, msg, ...args)` shape
 * as the real logger, so assertions read like `recorder.warn.calls`.
 */
function makeRecorder() {
  const calls = { debug: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  const logger = {
    debug: (name: string, msg: string, ...args: unknown[]) => calls.debug.push([msg, ...args]),
    info: (name: string, msg: string, ...args: unknown[]) => calls.info.push([msg, ...args]),
    warn: (name: string, msg: string, ...args: unknown[]) => calls.warn.push([msg, ...args]),
    error: (name: string, msg: string, ...args: unknown[]) => calls.error.push([msg, ...args]),
  } satisfies BalloonLogger;
  return { logger, calls };
}

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
 * Real GET /contests/{cid}/balloons entries (DOMjudge `DataTransferObject\Balloon`):
 * the problem letter lives on `contestproblem.label`, `problem` is the contest
 * shortname, `time` is the submission time, `location` is the team's seat, and
 * `done` is DOMjudge's delivery flag.
 */
const balloonsWithOneDone: DjBalloon[] = [
  {
    balloonid: 7,
    time: "2026-11-07T10:00:05+00:00",
    problem: "p1",
    contestproblem: { id: "p1", label: "A", name: "Alpha" },
    team: "icpc1: Team One",
    teamid: "t1",
    location: "A-101",
    done: false,
  },
  {
    balloonid: 9,
    time: "2026-11-07T10:12:30+00:00",
    problem: "p2",
    contestproblem: { id: "p2", label: "B", name: "Beta" },
    team: "icpc2: Team Two",
    teamid: "t2",
    location: "B-202",
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
  opts: { teams?: typeof TEAMS; contestId?: string; logger?: BalloonLogger } = {},
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
    logger: opts.logger ?? makeRecorder().logger,
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

  test("only the balloons endpoint is called: one /balloons, no judgements/submissions/problems", async () => {
    const fake = makeFetch(balloonsWithOneDone);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    const gets = fake.gets();
    expect(gets.filter((u) => /judgements|judgement-types|submissions|problems/.test(u))).toEqual([]);
    expect(gets.filter((u) => u.includes("/balloons"))).toHaveLength(1);
    expect(gets).toEqual([BALLOONS_URL]);
  });

  test("label and seat come from the balloon itself; team table is only a fallback", async () => {
    const fake = makeFetch([
      // contestproblem.label is the display letter; `problem` is the fallback.
      { balloonid: 11, teamid: "t1", problem: "p9", location: "D-404", done: false },
      // No location on the balloon → the local team table's seat.
      { balloonid: 12, teamid: "t1", done: false },
      // Neither → empty label, null seat.
      { balloonid: 13, teamid: "ghost", done: false },
    ]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    const byId = (id: string) => svc.list().find((t) => t.id === id);

    expect(byId("11")).toMatchObject({ problemLabel: "p9", location: "D-404", teamName: "Team One" });
    expect(byId("12")).toMatchObject({ problemLabel: "", location: "A-101", teamName: "Team One" });
    // Unknown team: raw team id as name, no seat to fall back to.
    expect(byId("13")).toMatchObject({ teamName: "ghost", location: null, problemLabel: "" });
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
    const fake = makeFetch([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("pending");

    fake.setBalLoons([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list()[0].status).toBe("delivered");
  });

  test("a DOMjudge-side revert (done true→false) flips a delivered task back to pending", async () => {
    const fake = makeFetch([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    const { svc, store } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("delivered");

    // The operator reopened/undid the balloon in DOMjudge: DOMjudge wins.
    fake.setBalLoons([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list()[0].status).toBe("pending");

    // A row acked locally (delivered) also reverts with no ack in flight.
    store.update((cur) => cur.map((t) => ({ ...t, status: "delivered" })));
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("pending");
  });

  test("ack POSTs /balloons/{id}/done and does not optimistically mark it delivered", async () => {
    const fake = makeFetch([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();

    const acked = await svc.ack("7");
    expect(acked).toMatchObject({ task: { id: "7", status: "pending" } });
    expect(fake.posts()).toEqual([`${BALLOONS_URL}/7/done`]);
    // No local write from ack(): the row is only delivered once DOMjudge says so.
    expect(svc.list()[0].status).toBe("pending");
  });

  test("ack followed by a still-false poll does not mark the task delivered", async () => {
    const fake = makeFetch([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    await svc.ack("7");

    // DOMjudge never flipped `done` (rejected silently / different contest
    // state): the ack must not leave a phantom delivered row behind.
    expect(await svc.pollOnce()).toBe(0);
    expect(svc.list()[0].status).toBe("pending");

    // …and once DOMjudge does report done, the same ack lands.
    fake.setBalLoons([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: true }]);
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("delivered");
  });

  test("ack for an unknown id is rejected and POSTs nothing", async () => {
    const fake = makeFetch([]);
    const { svc } = makeService(fake.fetchImpl);
    expect(await svc.ack("nope")).toEqual({ error: "balloon not found" });
    expect(fake.posts()).toEqual([]);
    expect(svc.list()).toHaveLength(0);
  });

  test("ack for an id the last poll did not return is rejected and writes nothing", async () => {
    const fake = makeFetch([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    const { svc, store } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    const before = store.load();

    // "77" is not a balloon id DOMjudge listed: no phantom row, no POST.
    expect(await svc.ack("77")).toEqual({ error: "balloon not found" });
    expect(fake.posts()).toEqual([]);
    expect(store.load()).toEqual(before);
  });

  test("a poll whose snapshot predates the ack POST does not revert a delivered row", async () => {
    // The UI reload can overlap the next scheduled poll. The `done: false`
    // snapshot such a poll fetched was produced before the POST landed, so it
    // must not undo the delivery; the *next* poll (after the POST) decides.
    const fake = makeFetch([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
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
    fake.setBalLoons([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: true }]);
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
        return body([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const { svc } = makeService(fetchImpl);
    await svc.pollOnce();

    const acked = await svc.ack("7");
    expect(acked).toMatchObject({ task: { id: "7" } });
    expect(posts).toEqual([`${BALLOONS_URL}/7/done`]);
    expect(svc.list()[0].status).toBe("pending");

    // DOMjudge can never flip done after a failed POST, so the next poll that
    // still sees done:false treats the delivery as local-only.
    await svc.pollOnce();
    expect(svc.list()[0].status).toBe("delivered");
  });
});

describe("BalloonService stale balloons (gone from the API)", () => {
  test("a pending balloon hidden by a freeze stays pending, is flagged stale, and leaves the pending list", async () => {
    const fake = makeFetch([
      { balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false },
      { balloonid: 8, teamid: "t2", contestproblem: { label: "B" }, done: false },
    ]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    expect(svc.list("pending")).toHaveLength(2);
    expect(svc.list()[0].stale).toBe(false);

    // Scoreboard freeze: DOMjudge stops listing balloon 8. Nobody delivered
    // it, so it must NOT be reported delivered.
    fake.setBalLoons([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
    expect(await svc.pollOnce()).toBe(1);

    const tasks = svc.list();
    expect(tasks.map((t) => t.id).sort()).toEqual(["7", "8"]);
    expect(tasks.find((t) => t.id === "8")).toMatchObject({ status: "pending", stale: true });
    expect(tasks.find((t) => t.id === "8")?.lastSeenAt).toBeUndefined();
    // Flagging it stale again changes nothing, so a freeze does not rewrite the store every poll.
    expect(await svc.pollOnce()).toBe(0);
    // Live pending queue excludes it; the stale view shows it.
    expect(svc.list("pending").map((t) => t.id)).toEqual(["7"]);
    expect(svc.list("stale").map((t) => t.id)).toEqual(["8"]);
    expect(svc.list("delivered")).toEqual([]);
  });

  test("a balloon that reappears is un-staled and reconciled normally", async () => {
    const fake = makeFetch([{ balloonid: 8, teamid: "t2", contestproblem: { label: "B" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();

    fake.setBalLoons([]);
    await svc.pollOnce();
    expect(svc.list()[0]).toMatchObject({ status: "pending", stale: true });

    // Unfreeze: back in the list, status still pending, now live again.
    fake.setBalLoons([{ balloonid: 8, teamid: "t2", contestproblem: { label: "B" }, done: false }]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list()[0].stale).toBe(false);
    expect(svc.list()[0].status).toBe("pending");
    expect(svc.list("pending").map((t) => t.id)).toEqual(["8"]);
    expect(svc.list("stale")).toEqual([]);
  });

  test("a delivered balloon whose balloon disappears keeps delivered and becomes stale", async () => {
    const fake = makeFetch([{ balloonid: 8, teamid: "t2", contestproblem: { label: "B" }, done: true }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    fake.setBalLoons([]);
    expect(await svc.pollOnce()).toBe(1);
    expect(svc.list()[0]).toMatchObject({ id: "8", status: "delivered", stale: true });
  });

  test("acking a stale balloon is rejected without a POST", async () => {
    const fake = makeFetch([{ balloonid: 8, teamid: "t2", contestproblem: { label: "B" }, done: false }]);
    const { svc } = makeService(fake.fetchImpl);
    await svc.pollOnce();
    fake.setBalLoons([]);
    await svc.pollOnce();

    expect(await svc.ack("8")).toEqual({ error: "balloon not found" });
    expect(fake.posts()).toEqual([]);
    expect(svc.list()[0]).toMatchObject({ status: "pending", stale: true });
  });

  test("a leftover row of the live contest is marked stale, never delivered", async () => {
    const fake = makeFetch([]);
    const { svc, store } = makeService(fake.fetchImpl);
    // Same contest id as the service: only a *foreign* contest is migrated away
    // at construction, so a row with the live contest id is a real leftover.
    store.update((cur) => [
      ...cur,
      {
        id: "old",
        contestId: CONTEST,
        problemLabel: "Z",
        teamName: "Ghost",
        location: null,
        status: "pending",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    await svc.pollOnce();
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]).toMatchObject({ status: "pending", stale: true });
  });
});

describe("BalloonService legacy row migration", () => {
  let recorder: ReturnType<typeof makeRecorder>;

  beforeEach(() => {
    recorder = makeRecorder();
  });

  /** Store pre-loaded with rows, as an upgrade from a pre-refactor data dir. */
  function serviceWithRows(rows: BalloonTask[], contestId = CONTEST) {
    const dir = mkdtempSync(join(tmpdir(), "balloon-legacy-"));
    const file = join(dir, "balloon-tasks.json");
    writeFileSync(file, JSON.stringify(rows), "utf8");
    const store = new JsonStore<BalloonTask[]>(file, []);
    const svc = new BalloonService({
      client: makeClient(makeFetch().fetchImpl),
      store,
      bus: new SseBus(),
      contestId,
      pollIntervalSeconds: 10,
      teams: TEAMS,
      logger: recorder.logger,
    });
    return { svc, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  const legacyRows: BalloonTask[] = [
    // Pre-refactor: id is a submission id, contestId is whatever it was then,
    // and the row predates the `balloonId` field.
    { id: "1001", contestId: "old-contest", problemLabel: "A", teamName: "Team One", location: null, status: "pending", createdAt: "x" },
    { id: "1002", contestId: "old-contest", problemLabel: "B", teamName: "Team Two", location: null, status: "delivered", createdAt: "x" },
  ];

  test("rows whose contestId differs from the live contest are discarded at construction, once, with an INFO line", () => {
    const { svc, store, cleanup } = serviceWithRows(legacyRows);
    try {
      expect(store.load()).toEqual([]);
      const lines = recorder.calls.info.filter((c: unknown[]) => String(c[0]).includes("已丢弃"));
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain("2 条");
      expect(String(lines[0][0])).toContain(CONTEST);
      expect(svc.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("rows already belonging to the live contest are kept untouched", () => {
    const keep: BalloonTask = {
      id: "7",
      contestId: CONTEST,
      problemLabel: "A",
      teamName: "Team One",
      location: "A-101",
      status: "pending",
      createdAt: "x",
      balloonId: 7,
    };
    const { svc, store, cleanup } = serviceWithRows([keep]);
    try {
      expect(store.load()).toEqual([keep]);
      expect(recorder.calls.info).toHaveLength(0);
      expect(svc.list()).toEqual([keep]);
    } finally {
      cleanup();
    }
  });

  test("pre-refactor rows sharing the CURRENT contest id are discarded too, with one line", () => {
    // The upgrade trap: the old schema kept the same contest id, so a
    // contestId-only filter kept these forever. Their id is a submission id,
    // they carry no `balloonId` field, and they duplicate the live row 7.
    const legacySameContest: BalloonTask[] = [
      { id: "1001", contestId: CONTEST, problemLabel: "A", teamName: "t1", location: null, status: "pending", createdAt: "x" },
      { id: "1002", contestId: CONTEST, problemLabel: "B", teamName: "t2", location: null, status: "delivered", createdAt: "x" },
    ];
    const live: BalloonTask = {
      id: "7",
      contestId: CONTEST,
      problemLabel: "A",
      teamName: "Team One",
      location: "A-101",
      status: "pending",
      createdAt: "x",
      balloonId: 7,
    };
    const { svc, store, cleanup } = serviceWithRows([...legacySameContest, live]);
    try {
      expect(store.load()).toEqual([live]);
      const lines = recorder.calls.info.filter((c: unknown[]) => String(c[0]).includes("已丢弃"));
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain("2");
      expect(svc.list().map((t) => t.id)).toEqual(["7"]);
    } finally {
      cleanup();
    }
  });

  test("a current row with a null balloonId (non-numeric DOMjudge id) is not legacy", () => {
    const keep: BalloonTask = {
      id: "bl-9",
      contestId: CONTEST,
      problemLabel: "C",
      teamName: "Team One",
      location: null,
      status: "pending",
      createdAt: "x",
      balloonId: null,
    };
    const { store, cleanup } = serviceWithRows([keep]);
    try {
      expect(store.load()).toEqual([keep]);
      expect(recorder.calls.info).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("no contest configured yet means no migration and no INFO line", () => {
    const { store, cleanup } = serviceWithRows(legacyRows, "");
    try {
      expect(store.load()).toHaveLength(2);
      expect(recorder.calls.info).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("BalloonService empty-list warning", () => {
  let recorder: ReturnType<typeof makeRecorder>;

  beforeEach(() => {
    recorder = makeRecorder();
  });

  const emptyWarnings = () =>
    recorder.calls.warn.filter((c: unknown[]) => String(c[0]).includes("气球列表为空：DOMjudge 可能未启用气球功能")).length;

  test("warns once on the 3rd consecutive empty poll, not before", async () => {
    const fake = makeFetch([]);
    const { svc } = makeService(fake.fetchImpl, undefined, { logger: recorder.logger });
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
    const { svc } = makeService(fake.fetchImpl, undefined, { logger: recorder.logger });
    await svc.pollOnce();
    await svc.pollOnce();
    await svc.pollOnce();
    expect(emptyWarnings()).toBe(1);

    fake.setBalLoons([{ balloonid: 1, teamid: "t1", contestproblem: { label: "A" }, done: false }]);
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
    const { svc } = makeService(
      fake.fetchImpl,
      (fn) => {
        scheduled.push(fn);
      },
      { contestId: "", logger: recorder.logger },
    );
    svc.start();
    expect(scheduled).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(recorder.calls.warn).toHaveLength(0);
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

  /**
   * Real-scheduler service: no injectable `schedule`, so setTimeout (and the
   * 0ms restart tick) actually fires. That is what the review's repro used and
   * what a hand-driven queue cannot model: the restart tick wakes up *while*
   * the previous poll is still awaited.
   */
  function realSchedulerService(fetchImpl: typeof fetch, contestId = "c1", pollSeconds = 60) {
    const dir = mkdtempSync(join(tmpdir(), "balloon-realsched-"));
    const svc = new BalloonService({
      client: makeClient(fetchImpl),
      store: new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []),
      bus: new SseBus(),
      contestId,
      pollIntervalSeconds: pollSeconds,
      teams: TEAMS,
    });
    return {
      svc,
      cleanup: () => {
        svc.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** Lets queued timers and microtasks run until `done()` or the budget is spent. */
  async function until(done: () => boolean, budgetMs = 1000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  }

  test("reconfigure during an in-flight poll is followed by a second poll (real scheduler)", async () => {
    // First GET hangs until the test releases it: that is the in-flight poll a
    // settings PUT can land on. Later GETs answer immediately.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) await gate;
      return new Response(JSON.stringify([]));
    }) as unknown as typeof fetch;
    const { svc, cleanup } = realSchedulerService(fetchImpl);

    svc.start(); // 0ms tick → poll #1 starts and blocks on the gate
    await until(() => urls.length === 1);

    // Settings save while poll #1 is in flight: stop()+start() arms a 0ms
    // restart tick. What this test proves, and nothing more: after the poll is
    // released the service polls again WITHOUT any external nudge, i.e. the
    // restart chain is alive. It does NOT prove the timing — an in-process
    // `new Response()` needs no macrotask, so this poll may settle before the
    // restart tick can fire and the pass may come from the ordinary
    // interval-reschedule path. The exact interleaving (tick still pending when
    // the poll finishes) is pinned deterministically by "a restart tick that
    // outlives the in-flight poll…" below, which releases through a microtask.
    svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 7 });
    (release as unknown as () => void)();

    // Poll #1 resumes; it was superseded, so it no longer chains a tick itself.
    // The chain must continue through the restart path or the interval path.
    await until(() => urls.length >= 2);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    cleanup();
  });

  /**
   * The REAL setTimeout, wrapped so tests can count live handles. The engine
   * still decides when timers fire (so the 0ms restart tick races the cached
   * DOMjudge response exactly like production); the registry only observes.
   * Returns handles through the same `typeof setTimeout` shape the service
   * uses, which is what makes cancelSchedule work.
   */
  function countingTimeout() {
    const live = new Set<ReturnType<typeof setTimeout>>();
    let scheduled = 0;
    const schedule = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      scheduled++;
      const handle = setTimeout(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    };
    return {
      schedule,
      cancelSchedule: (handle: ReturnType<typeof setTimeout>) => {
        live.delete(handle);
        clearTimeout(handle);
      },
      liveCount: () => live.size,
      /** How many ticks were ever armed: catches a hand-over that re-armed twice. */
      scheduled: () => scheduled,
      clear: () => {
        for (const h of live) clearTimeout(h);
        live.clear();
      },
    };
  }

  test("reconfigure during an in-flight poll leaves exactly one scheduled chain", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) await gate;
      return new Response(JSON.stringify([]));
    }) as unknown as typeof fetch;
    const timers = countingTimeout();
    const dir = mkdtempSync(join(tmpdir(), "balloon-chain-"));
    const svc = new BalloonService({
      client: makeClient(fetchImpl),
      store: new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []),
      bus: new SseBus(),
      contestId: "c1",
      pollIntervalSeconds: 60,
      teams: TEAMS,
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
    });
    try {
      svc.start(); // one 0ms tick → poll #1 starts and blocks on the gate
      await until(() => urls.length === 1);
      // That tick fired and was consumed: no timer is outstanding mid-poll.
      expect(timers.liveCount()).toBe(0);

      // Three settings saves while poll #1 is in flight. Each is a stop()+start();
      // stop() cancels the previous restart tick, so only the last survives.
      svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 30 });
      svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 20 });
      svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 10 });
      expect(timers.liveCount()).toBe(1);

      (release as unknown as () => void)();
      // Poll #1 finishes superseded: the restart tick it could not have used is
      // re-armed and poll #2 starts. EXACTLY one timer may be outstanding at
      // every point after that — a duplicate hand-over would arm two.
      await until(() => urls.length >= 2);
      expect(timers.liveCount()).toBe(1);
      // Exact accounting for the whole run — nothing was armed twice:
      // 1 initial tick, 3 restart ticks (one per save, each cancelled by the
      // next), 1 hand-over tick, 1 regular tick armed by poll #2. A duplicate
      // hand-over would show up here, and a lost one as urls.length === 1.
      expect(timers.scheduled()).toBe(6);

      // Poll #2 completes and schedules its regular tick: still exactly one.
      await new Promise((r) => setTimeout(r, 30));
      expect(timers.liveCount()).toBe(1);
      // No late duplicate hand-over poll: only #1 and #2 have been fetched.
      expect(urls.length).toBe(2);
    } finally {
      svc.stop();
      timers.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a restart tick that fires while the poll is still awaited cannot start a second chain", async () => {
    // The jitter case: reconfigure()'s 0ms tick wins the race and runs BEFORE
    // the in-flight poll resolves. It must bail on the guard, and a further save
    // in that window must still leave exactly one outstanding timer (this is
    // what caught three un-cancelled restart ticks leaking per triple save).
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) await gate;
      return new Response(JSON.stringify([]));
    }) as unknown as typeof fetch;
    const timers = countingTimeout();
    const dir = mkdtempSync(join(tmpdir(), "balloon-jitter-"));
    const svc = new BalloonService({
      client: makeClient(fetchImpl),
      store: new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []),
      bus: new SseBus(),
      contestId: "c1",
      pollIntervalSeconds: 60,
      teams: TEAMS,
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
    });
    try {
      svc.start();
      await until(() => urls.length === 1);
      svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 30 });
      // Let the 0ms restart tick fire while poll #1 still hangs.
      await new Promise((r) => setTimeout(r, 20));
      expect(timers.liveCount()).toBe(0); // it ran and was dropped by the guard
      // A second save re-arms a hand-over tick; the old approach lost it.
      svc.reconfigure({ contestId: "c1", pollIntervalSeconds: 20 });
      expect(timers.liveCount()).toBe(1);

      (release as unknown as () => void)();
      await until(() => urls.length >= 2);
      await new Promise((r) => setTimeout(r, 30));
      expect(timers.liveCount()).toBe(1);
    } finally {
      svc.stop();
      timers.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Real setTimeout, but a 0ms tick armed while a poll is in flight is HELD
   * until the test releases it — the interleaving the review reproduced (the
   * restart tick wakes up against the `polling` guard) without depending on how
   * fast this machine's timers happen to be. Any non-0ms tick armed while a
   * poll is in flight (the scheduled regular interval) is DROPPED: if that one
   * survives, the chain is alive via a tick the restart never touches, which is
   * not the scenario under test.
   */
  function holdingTimeout(inFlight: () => boolean) {
    const held: Array<() => void> = [];
    const schedule = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      if (inFlight()) {
        if (ms === 0) held.push(fn);
        return setTimeout(() => {}, 0);
      }
      return setTimeout(fn, ms);
    };
    return {
      schedule,
      release: () => held.splice(0).forEach((fn) => fn()),
      heldCount: () => held.length,
    };
  }

  test("a restart tick that outlives the in-flight poll still leaves one live chain", async () => {
    // The in-flight poll is released through a MICROTASK (a bare promise
    // continuation), so it is guaranteed to settle before any timer can run:
    // the restart tick start() armed is still pending at that moment, exactly
    // the interleaving the review reproduced and the one a real DOMjudge with a
    // warm connection produces.
    let inFlight = false;
    const timers = holdingTimeout(() => inFlight);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) {
        inFlight = true;
        await gate;
        inFlight = false;
      }
      // No further await: the response is produced in the same microtask turn
      // the gate is released in.
      return new Response(JSON.stringify([]));
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "balloon-held-"));
    const svcReal = new BalloonService({
      client: makeClient(fetchImpl),
      store: new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []),
      bus: new SseBus(),
      contestId: "c1",
      pollIntervalSeconds: 60,
      teams: TEAMS,
      schedule: timers.schedule,
      cancelSchedule: (h) => clearTimeout(h),
    });
    try {
      svcReal.start();
      await until(() => urls.length === 1);
      svcReal.reconfigure({ contestId: "c1", pollIntervalSeconds: 7 });
      // The restart tick is held: it has NOT run when the poll resolves.
      expect(timers.heldCount()).toBe(1);

      (release as unknown as () => void)();
      await null; // drain microtasks: poll #1 has now finished
      // Pre-fix: the superseded poll returns without scheduling, and the held
      // tick then runs against `polling === false`… but it was armed for the
      // OLD chain, so this is where "hand over" vs "drop" decides the outcome.
      timers.release();
      await until(() => urls.length >= 2, 500);
      expect(urls.length).toBeGreaterThanOrEqual(2);
      // Exactly one chain: the held tick and a hand-over tick must not BOTH poll
      // in quick succession at this 7s cadence.
      const n = urls.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(urls.length).toBe(n);
    } finally {
      svcReal.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("purge (stop) during an in-flight poll leaves the store empty", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) await gate;
      return new Response(
        JSON.stringify([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]),
      );
    }) as unknown as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "balloon-purge-"));
    const store = new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []);
    const bus = new SseBus();
    const events: unknown[] = [];
    bus.subscribe("admin", (e) => events.push(e));
    const svc = new BalloonService({
      client: makeClient(fetchImpl),
      store,
      bus,
      contestId: "c1",
      pollIntervalSeconds: 60,
      teams: TEAMS,
    });

    // A poll is in flight (GET hanging)…
    const inFlight = svc.pollOnce();
    await until(() => urls.length === 1);
    // …the operator clicks 清空数据: the store is emptied, then the poller is
    // stopped (server.ts does exactly this order).
    store.save([]);
    svc.stop();
    // DOMjudge answers the old poll. Its snapshot predates the purge, so with
    // no generation guard it writes the old row straight back.
    (release as unknown as () => void)();
    expect(await inFlight).toBe(0);
    expect(store.load()).toEqual([]);
    expect(events).toHaveLength(0);
    expect(svc.list()).toEqual([]);

    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a superseded poll logs one DEBUG line so latest.log explains the gap", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = makeRecorder();
    const fetchImpl = (async () => {
      await gate;
      return new Response(JSON.stringify([{ balloonid: 7, teamid: "t1", done: false }]));
    }) as unknown as typeof fetch;
    const { svc, store } = makeService(fetchImpl, undefined, { logger: recorder.logger });

    const inFlight = svc.pollOnce();
    await new Promise((r) => setTimeout(r, 5));
    store.save([]);
    svc.stop();
    (release as unknown as () => void)();
    expect(await inFlight).toBe(0);
    expect(store.load()).toEqual([]);

    const debugLines = recorder.calls.debug.filter((c: unknown[]) => String(c[0]).includes("轮询结果已作废"));
    expect(debugLines).toHaveLength(1);
    expect(recorder.calls.error).toHaveLength(0);
  });

  test("the store write re-checks the epoch, so a purge between guard and save wins", async () => {
    // The narrowest window C2's await-guard does not cover: the poll is past its
    // generation check and about to persist; the purge (stop() + empty the
    // file) lands with the snapshot already computed; JsonStore.save has no
    // version check, so whatever the service hands it is renamed into place.
    //
    // The purge cannot be injected INTO save() (save only receives the final
    // value), so the fixture puts it at the one place it can precede the
    // service's write while the poll is parked: the store's load() of the
    // existing rows, which happens *after* the await-guard and *before* the
    // write decision. That is a real ordering too — a purge can run between the
    // guard and the reconcile pass. The service must re-read the epoch it
    // captured before deciding to write.
    const dir = mkdtempSync(join(tmpdir(), "balloon-saverace-"));
    const inner = new JsonStore<BalloonTask[]>(join(dir, "balloon-tasks.json"), []);
    let svc: BalloonService;
    // Armed only after construction: the constructor's discardForeignRows()
    // load is not the window under test.
    let purgePending = false;
    const store = {
      load: () => {
        if (purgePending) {
          purgePending = false;
          // Purge order from server.ts: stop the poller, then empty the file.
          svc.stop();
          inner.save([]);
        }
        return inner.load();
      },
      save: (value: BalloonTask[]) => inner.save(value),
      update: (fn: (cur: BalloonTask[]) => BalloonTask[]) => {
        const next = fn(inner.load());
        inner.save(next);
        return next;
      },
    } as unknown as JsonStore<BalloonTask[]>;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ balloonid: 7, teamid: "t1", contestproblem: { label: "A" }, done: false }]),
      )) as unknown as typeof fetch;
    svc = new BalloonService({
      client: makeClient(fetchImpl),
      store,
      bus: new SseBus(),
      contestId: "c1",
      pollIntervalSeconds: 60,
      teams: TEAMS,
    });
    purgePending = true;

    expect(await svc.pollOnce()).toBe(0);
    // Only the pre-purge load saw rows; the purge emptied the file and the
    // stale reconcile must not refill it.
    expect(inner.load()).toEqual([]);
    expect(svc.list()).toEqual([]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});


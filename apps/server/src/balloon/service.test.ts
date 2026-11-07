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

const judgementTypes: DjJudgementType[] = [
  { id: "AC", sorting_key: "correct" },
  { id: "WA", sorting_key: "" },
];

const submissions: DjSubmission[] = [
  { id: "s1", problem: "p1", language: "cpp", team: "t1", time: "2026-11-07T10:00:00+00:00" },
  { id: "s2", problem: "p1", language: "cpp", team: "t2", time: "2026-11-07T10:05:00+00:00" },
];

const judgings: DjJudging[] = [
  { id: "j1", submission: "s1", judgement_type_id: "AC" },
  { id: "j2", submission: "s2", judgement_type_id: "WA" },
];

function makeFetch(overrides: {
  judgements?: DjJudging[];
  failJudgementsTimes?: number;
} = {}) {
  let failCount = overrides.failJudgementsTimes ?? 0;
  return ((url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    const body = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
    if (u.startsWith(BASE + `contests/${CONTEST}/judgement-types`)) return body(judgementTypes);
    if (u.startsWith(BASE + `contests/${CONTEST}/submissions`)) return body(submissions);
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
) {
  const cfg = {
    baseUrl: "https://dj.example.com",
    adminUser: "admin",
    adminPassword: "pw",
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
    problems: [{ id: "p1", label: "A", name: "Alpha" }],
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
    const acked = svc.ack("s1");
    expect(acked?.status).toBe("delivered");
    expect(svc.list("delivered")).toHaveLength(1);
    expect(svc.list("pending")).toHaveLength(0);
    expect(svc.ack("nope")).toBeNull();
  });
});

import type { DjClient, DjProblem, DjTeam } from "../domjudge/client";
import type { SseBus } from "../sse/bus";
import type { JsonStore } from "../store/store";

export type BalloonTask = {
  id: string;
  contestId: string;
  problemLabel: string;
  teamName: string;
  location: string | null;
  status: "pending" | "delivered";
  createdAt: string;
};

export type BalloonServiceDeps = {
  client: DjClient;
  store: JsonStore<BalloonTask[]>;
  bus: SseBus;
  contestId: string;
  pollIntervalSeconds: number;
  teams?: DjTeam[];
  problems?: Array<Pick<DjProblem, "id" | "label" | "name">>;
  /** Injectable scheduler for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
};

const MAX_BACKOFF_MULTIPLIER = 10;

/**
 * Correct-verdict matching rule: a judging counts as solved when its
 * judgement_type_id matches a judgement type where `solved` is true, or
 * whose `sorting_key` is "correct", or whose id is literally "correct".
 * The `solved` flag is the authoritative field on a real DOMjudge's
 * external contest API (verified live against
 * https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/judgement-types,
 * which returns e.g. {"id":"AC","name":"accepted","penalty":false,"solved":true}
 * with no sorting_key); the sorting_key and id checks are kept for
 * compatibility with the internal API shape. The set of types comes from
 * DjClient.getJudgementTypes for the same contest.
 */
export class BalloonService {
  private readonly client: DjClient;
  private readonly store: JsonStore<BalloonTask[]>;
  private readonly bus: SseBus;
  private readonly contestId: string;
  private readonly pollIntervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private teams: DjTeam[];
  private problems: Array<Pick<DjProblem, "id" | "label" | "name">>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  /** Set while a pollLoop run is in flight, so start/stop stay re-entrant. */
  private polling = false;

  constructor(deps: BalloonServiceDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.bus = deps.bus;
    this.contestId = deps.contestId;
    this.pollIntervalMs = deps.pollIntervalSeconds * 1000;
    this.schedule = deps.schedule ?? ((fn, ms) => {
      this.timer = setTimeout(fn, ms);
    });
    this.teams = deps.teams ?? [];
    this.problems = deps.problems ?? [];
  }

  /** Task 7 calls this after team sync to refresh label/name lookups. */
  refresh(teams: DjTeam[], problems: Array<Pick<DjProblem, "id" | "label" | "name">>): void {
    this.teams = teams;
    this.problems = problems;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  list(status?: BalloonTask["status"]): BalloonTask[] {
    const tasks = this.store.load();
    return status ? tasks.filter((t) => t.status === status) : tasks;
  }

  ack(id: string): BalloonTask | null {
    let found: BalloonTask | null = null;
    this.store.update((cur) =>
      cur.map((t) => {
        if (t.id !== id) return t;
        found = { ...t, status: "delivered" };
        return found;
      }),
    );
    return found;
  }

  /** Fetch judgements once and enqueue balloons for new correct submissions. Returns the number created. */
  async pollOnce(): Promise<number> {
    const [judgings, judgementTypes, submissions] = await Promise.all([
      this.client.getJudgings(this.contestId),
      this.client.getJudgementTypes(this.contestId),
      this.client.getSubmissions(this.contestId),
    ]);

    const correctTypeIds = new Set(
      judgementTypes
        .filter(
          (t) =>
            t.solved === true || t.sorting_key === "correct" || t.id === "correct",
        )
        .map((t) => t.id),
    );
    if (correctTypeIds.size === 0) return 0;

    const submissionsById = new Map(submissions.map((s) => [s.id, s]));
    const existingIds = new Set(this.store.load().map((t) => t.id));
    const created: BalloonTask[] = [];

    for (const j of judgings) {
      if (!correctTypeIds.has(j.judgement_type_id)) continue;
      const sub = submissionsById.get(j.submission);
      if (!sub || existingIds.has(sub.id)) continue;
      // One balloon per submission id: the task id is the submission id, so
      // re-judgings of the same submission can never create a second balloon.
      const task: BalloonTask = {
        id: sub.id,
        contestId: this.contestId,
        problemLabel:
          this.problems.find((p) => p.id === sub.problem)?.label ?? sub.problem,
        teamName: this.teams.find((t) => t.id === sub.team)?.name ?? sub.team,
        location: this.teams.find((t) => t.id === sub.team)?.location?.description ?? null,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      existingIds.add(task.id);
      created.push(task);
    }

    if (created.length === 0) return 0;
    this.store.update((cur) => [...cur, ...created]);
    for (const task of created) {
      this.bus.publish("admin", "balloon-task", task);
    }
    return created.length;
  }

  private scheduleNext(ms: number): void {
    if (!this.running) return;
    this.schedule(() => void this.pollLoop(), ms);
  }

  private async pollLoop(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
      this.consecutiveFailures = 0;
      this.scheduleNext(this.pollIntervalMs);
    } catch (err) {
      this.consecutiveFailures++;
      console.error(
        `balloon poll failed for contest ${this.contestId}:`,
        err instanceof Error ? err.message : err,
      );
      const multiplier = Math.min(2 ** this.consecutiveFailures, MAX_BACKOFF_MULTIPLIER);
      this.scheduleNext(this.pollIntervalMs * multiplier);
    } finally {
      this.polling = false;
    }
  }
}

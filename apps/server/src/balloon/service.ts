import type { DjBalloon, DjClient, DjProblem, DjTeam } from "../domjudge/client";
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
  /** DOMjudge balloon id (balloons API) matched at poll time; null when unmatched or pre-plumbing data. */
  balloonId?: number | null;
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

  /**
   * Task 7 calls this after team sync to refresh label/name lookups. Pending
   * tasks created before problems/teams were known (e.g. the first poll after
   * a server restart, verified live against the demo) hold raw problem ids as
   * labels and raw team ids as teamName with null location; once those arrive
   * they are re-labeled. Delivered tasks are left untouched.
   */
  refresh(teams: DjTeam[], problems: Array<Pick<DjProblem, "id" | "label" | "name">>): void {
    this.teams = teams;
    this.problems = problems;
    if (problems.length === 0 && teams.length === 0) return;
    const labelById = new Map(problems.map((p) => [p.id, p.label]));
    const teamById = new Map(teams.map((t) => [t.id, t]));
    this.store.update((cur) =>
      cur.map((t) => {
        if (t.status !== "pending") return t;
        const label = labelById.get(t.problemLabel);
        const team = teamById.get(t.teamName);
        if (!label && !team) return t;
        return {
          ...t,
          problemLabel: label && label !== t.problemLabel ? label : t.problemLabel,
          teamName: team ? team.name : t.teamName,
          location: team ? (team.location?.description ?? null) : t.location,
        };
      }),
    );
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

  async ack(id: string, status: BalloonTask["status"] = "delivered"): Promise<BalloonTask | null> {
    let found: BalloonTask | null = null;
    this.store.update((cur) =>
      cur.map((t) => {
        if (t.id !== id) return t;
        found = { ...t, status };
        return found;
      }),
    );
    if (found && status === "delivered") {
      // Delivery state lives in DOMjudge's own balloon API, not just locally;
      // sync is best-effort and never fails the local ack.
      try {
        await this.syncBalloonDone(found);
      } catch (err) {
        console.error(
          `balloon ack: could not mark balloon done in domjudge for task ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return found;
  }

  /**
   * Resolve the balloon for the task's team + problem and POST done. When the
   * task carries a balloonId matched at poll time it is used directly; the
   * ad-hoc match below is the fallback for tasks created before that
   * plumbing (or whose balloon wasn't visible at poll time).
   * Matching rule (review fix): a team can hold several pending balloons at
   * once, so matching on teamid alone marks the wrong balloon; we additionally
   * require a not-yet-done entry and the same problem label (falling back to
   * the raw problem id when the API omits contestproblem.label). Skipped
   * (logged, no sync) when the team or the balloon can't be matched.
   */
  private matchBalloon(teamId: string, problemLabel: string, balloons: DjBalloon[]): DjBalloon | undefined {
    return balloons.find((b) => {
      if (b.teamid !== teamId || b.done) return false;
      // Prefer the API's own label; else derive it from the problem id via the
      // refreshed problems list; else compare raw ids (tasks created before a
      // sync hold the raw problem id as their label).
      const label =
        b.contestproblem?.label ??
        this.problems.find((p) => p.id === (b.problem ?? b.problemid))?.label ??
        b.problem ??
        b.problemid;
      return label === problemLabel;
    });
  }

  private static toBalloonId(balloonid: string): number | null {
    const n = Number(balloonid);
    return Number.isFinite(n) ? n : null;
  }

  /** Balloon sync is auxiliary to the local ack; an API failure must not break polling. */
  private async fetchBalloonsSafe(): Promise<DjBalloon[]> {
    try {
      return await this.client.getBalloons(this.contestId);
    } catch (err) {
      console.error(
        `balloon poll: could not fetch balloons for contest ${this.contestId}, proceeding without balloon ids:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  private async syncBalloonDone(task: BalloonTask): Promise<void> {
    if (task.balloonId != null) {
      await this.client.markBalloonDone(this.contestId, String(task.balloonId));
      return;
    }
    const team =
      this.teams.find((t) => t.name === task.teamName || t.display_name === task.teamName) ??
      this.teams.find((t) => t.id === task.teamName);
    if (!team) {
      console.error(`balloon ack: no team matches "${task.teamName}", skipping domjudge balloon sync`);
      return;
    }
    const balloons = await this.client.getBalloons(this.contestId);
    const balloon = this.matchBalloon(team.id, task.problemLabel, balloons);
    if (!balloon) {
      console.error(
        `balloon ack: no pending balloon for team ${team.id} problem ${task.problemLabel} in contest ${this.contestId}, skipping domjudge balloon sync`,
      );
      return;
    }
    await this.client.markBalloonDone(this.contestId, balloon.balloonid);
  }

  /**
   * Problems are normally supplied via refresh() after a team sync, but a
   * freshly restarted server polls before any sync ran (demo-verified: 1095
   * tasks got raw-id labels that way). Fetch them lazily so the first poll
   * can already map labels.
   */
  private async ensureProblems(): Promise<Array<Pick<DjProblem, "id" | "label" | "name">>> {
    if (this.problems.length > 0) return this.problems;
    try {
      this.problems = await this.client.getProblems(this.contestId);
    } catch (err) {
      console.error(
        `balloon service could not fetch problems for contest ${this.contestId}, falling back to raw ids:`,
        err instanceof Error ? err.message : err,
      );
    }
    return this.problems;
  }

  /** Fetch judgements once and enqueue balloons for new correct submissions. Returns the number created. */
  async pollOnce(): Promise<number> {
    const [judgings, judgementTypes, submissions, problems, balloons] = await Promise.all([
      this.client.getJudgings(this.contestId),
      this.client.getJudgementTypes(this.contestId),
      this.client.getSubmissions(this.contestId),
      this.ensureProblems(),
      this.fetchBalloonsSafe(),
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
      const problemLabel =
        problems.find((p) => p.id === sub.problem)?.label ?? sub.problem;
      const matched = this.matchBalloon(sub.team, problemLabel, balloons);
      // One balloon per submission id: the task id is the submission id, so
      // re-judgings of the same submission can never create a second balloon.
      const task: BalloonTask = {
        id: sub.id,
        contestId: this.contestId,
        problemLabel,
        teamName: this.teams.find((t) => t.id === sub.team)?.name ?? sub.team,
        location: this.teams.find((t) => t.id === sub.team)?.location?.description ?? null,
        status: "pending",
        createdAt: new Date().toISOString(),
        balloonId: matched ? BalloonService.toBalloonId(matched.balloonid) : null,
      };
      existingIds.add(task.id);
      created.push(task);
    }

    // Backfill: tasks stored before the balloonid plumbing (or polled while
    // the balloons API was down) get their balloonId matched on later polls.
    // Pending only — a delivered task must not gain an id that a later ack
    // would mark done again.
    if (balloons.length > 0 && existingIds.size > 0) {
      this.store.update((cur) =>
        cur.map((t) => {
          if (t.status !== "pending" || t.balloonId != null) return t;
          const team =
            this.teams.find((x) => x.name === t.teamName || x.display_name === t.teamName) ??
            this.teams.find((x) => x.id === t.teamName);
          if (!team) return t;
          const b = this.matchBalloon(team.id, t.problemLabel, balloons);
          return b ? { ...t, balloonId: BalloonService.toBalloonId(b.balloonid) } : t;
        }),
      );
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

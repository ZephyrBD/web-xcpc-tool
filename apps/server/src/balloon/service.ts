import type { DjBalloon, DjClient, DjTeam } from "../domjudge/client";
import type { SseBus } from "../sse/bus";
import type { JsonStore } from "../store/store";

/**
 * A balloon to deliver. Kept in the field shape the admin UI already renders
 * (`JobsPage`/`DashboardPage` read id/teamName/location/status/createdAt), but
 * since Task 4 the source of truth is DOMjudge's own balloon API:
 * `id` IS the DOMjudge `balloonid` (no more synthesis from submissions), and
 * `status` mirrors that entry's `done` flag on every poll.
 */
export type BalloonTask = {
  id: string;
  contestId: string;
  problemLabel: string;
  teamName: string;
  location: string | null;
  status: "pending" | "delivered";
  createdAt: string;
  /**
   * Legacy alias of `id` for pre-Task-4 tasks (whose id was the submission id
   * and whose balloon id had to be matched separately). Always written equal to
   * `id`; kept nullable so old rows and the admin column keep rendering.
   */
  balloonId?: number | null;
};

export type BalloonServiceDeps = {
  client: DjClient;
  store: JsonStore<BalloonTask[]>;
  bus: SseBus;
  contestId: string;
  pollIntervalSeconds: number;
  teams?: DjTeam[];
  /** Injectable scheduler for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
};

const MAX_BACKOFF_MULTIPLIER = 10;
/** Consecutive empty balloon lists before the operator gets told once. */
const EMPTY_WARN_STREAK = 3;

/**
 * Evidence of an ack whose POST has not been reflected by a poll yet. Without
 * it a just-acked entry would pop straight back to pending on the poll that
 * fetched the list while the POST was still in flight. It only ever *delays*
 * a revert: the first poll that started after `postCompletedAt` decides, so a
 * DOMjudge-side revert of `done` always lands. `postFailed` is the one case
 * DOMjudge can never confirm (nothing flipped `done`), so that delivery is
 * landed locally by the next such poll.
 */
type AckRecord = { postCompletedAt: number; postFailed: boolean };

/**
 * Balloon delivery queue, read straight from GET /contests/{id}/balloons.
 *
 * The poll is a single API call plus the local team table: DOMjudge already
 * decides which submissions earned a balloon, so judgements/submissions are
 * never fetched here. DOMjudge is authoritative for delivery state: every
 * poll rewrites `status` from the entry's `done` flag, in both directions.
 */
export class BalloonService {
  private readonly client: DjClient;
  private readonly store: JsonStore<BalloonTask[]>;
  private readonly bus: SseBus;
  private contestId: string;
  private pollIntervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private teams: DjTeam[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  /** Set while a pollLoop run is in flight, so start/stop stay re-entrant. */
  private polling = false;
  /** Bumped by stop(); an in-flight poll from an older generation never reschedules. */
  private generation = 0;
  /** Consecutive polls whose balloon list came back empty (reset by a non-empty one). */
  private emptyStreak = 0;
  /** True once the current empty streak was logged, so it logs once per streak. */
  private emptyWarned = false;
  /** Acks awaiting a poll that actually observed DOMjudge saying "not done". */
  private ackPending = new Map<string, AckRecord>();

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
  }

  /**
   * Called by the team-sync endpoint (and Task 7's team sync) with the latest
   * team table. It only refreshes the lookup table pollOnce uses; the next poll
   * re-labels every row from the balloon API anyway, so rows are re-labelled
   * here too so the UI does not show raw team ids until then.
   */
  refresh(teams: DjTeam[]): void {
    this.teams = teams;
    if (teams.length === 0) return;
    const rows = this.store.load();
    const next = rows.map((t) => {
      // Pre-Task-4 rows held the raw team id as teamName (their id was the
      // submission id); current rows hold the resolved name.
      const team = teams.find((x) => x.name === t.teamName) ?? teams.find((x) => x.id === t.teamName);
      if (!team || t.contestId !== this.contestId) return t;
      return {
        ...t,
        teamName: team.name,
        location: team.location?.description ?? t.location,
      };
    });
    if (next.some((t, i) => t !== rows[i])) this.store.save(next);
  }

  start(): void {
    if (this.running) return;
    // No contest configured means no balloon API to poll; leave running=false
    // so nothing is scheduled (and /admin/api/balloon endpoints stay inert).
    if (!this.contestId) {
      this.running = false;
      return;
    }
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    // Invalidate any in-flight poll so it cannot schedule a duplicate chain.
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Apply a settings edit (runtime config store → index.ts onChange handler).
   * A real change stops the loop and starts it again against the new values (an
   * empty contestId leaves it stopped, exactly like start()); no-op changes are
   * ignored so an unrelated PUT does not reset the backoff cadence.
   */
  reconfigure(next: { contestId: string; pollIntervalSeconds: number }): void {
    const contestChanged = next.contestId !== this.contestId;
    const intervalChanged = next.pollIntervalSeconds * 1000 !== this.pollIntervalMs;
    if (!contestChanged && !intervalChanged) return;
    this.contestId = next.contestId;
    this.pollIntervalMs = next.pollIntervalSeconds * 1000;
    // A different contest must not inherit the previous contest's backoff or
    // its empty-list / ack reconciliation state.
    if (contestChanged) {
      this.consecutiveFailures = 0;
      this.emptyStreak = 0;
      this.emptyWarned = false;
      this.ackPending.clear();
    }
    this.stop();
    this.start();
  }

  list(status?: BalloonTask["status"]): BalloonTask[] {
    const tasks = this.store.load();
    return status ? tasks.filter((t) => t.status === status) : tasks;
  }

  /**
   * Deliver a balloon: POST /balloons/{id}/done, then let the poller reflect
   * what DOMjudge says. This deliberately does NOT optimistically mark the task
   * delivered — local state is only ever written by pollOnce's reconciliation,
   * so an ack that DOMjudge rejects cannot leave a phantom "delivered" row
   * behind. A single exception: when the POST fails nothing can ever flip
   * `done`, so the attempt is remembered and the next poll that still sees
   * `done: false` for this balloon writes "delivered" itself — mirroring the
   * old "local ack still lands on API failure" behaviour.
   *
   * `status === "pending"` is not a deliverable transition in the DOMjudge
   * model (use the DOMjudge UI to reopen a balloon); it only records the
   * request and returns the task unchanged.
   */
  async ack(id: string, status: BalloonTask["status"] = "delivered"): Promise<BalloonTask | null> {
    const task = this.store.load().find((t) => t.id === id);
    if (!task) return null;
    if (status !== "delivered") return task;

    const requestedAt = Date.now();
    // Registered before the POST so a poll that started earlier cannot win a
    // race with a stale `done: false` snapshot.
    this.ackPending.set(id, { postCompletedAt: requestedAt, postFailed: false });
    try {
      await this.client.markBalloonDone(this.contestId, id);
      // Only polls that started after the POST finished may override the ack.
      this.ackPending.set(id, { postCompletedAt: Date.now(), postFailed: false });
    } catch (err) {
      // Keep the entry (flagged) for the same window as a successful ack: the
      // next poll may still see a predated `done: false`, and after that the
      // failed delivery is landed locally by synchronize().
      this.ackPending.set(id, { postCompletedAt: Date.now(), postFailed: true });
      console.error(
        `balloon ack: could not mark balloon done in domjudge for task ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return task;
  }

  /** Label for a balloon: the contest problem label, else the raw problem id. */
  private static problemLabelOf(b: DjBalloon): string {
    return b.contestproblem?.label ?? b.problem ?? b.problemid ?? "";
  }

  /** Earliest timestamp the balloon API offers, so rows keep a stable createdAt. */
  private static submittedAtOf(b: DjBalloon, fallback: string): string {
    const raw = b.time ?? b.contesttime ?? b.submitted;
    if (!raw) return fallback;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
  }

  /**
   * One poll = one GET /balloons. Returns how many task rows changed (created,
   * re-labelled or status-flipped). A missing balloon list (API error) throws,
   * so the caller applies its backoff instead of pretending the queue emptied.
   */
  async pollOnce(): Promise<number> {
    const startedAt = Date.now();
    const balloons = await this.client.getBalloons(this.contestId);

    if (balloons.length === 0) {
      // A misconfigured/balloon-less DOMjudge looks exactly like "nothing to
      // deliver", so tell the operator once per streak instead of never.
      this.emptyStreak++;
      if (this.emptyStreak >= EMPTY_WARN_STREAK && !this.emptyWarned) {
        this.emptyWarned = true;
        console.warn(
          `气球列表为空：DOMjudge 可能未启用气球功能（比赛 ${this.contestId}，已连续 ${this.emptyStreak} 次轮询为空）`,
        );
      }
    } else {
      this.emptyStreak = 0;
      this.emptyWarned = false;
    }

    const teamById = new Map(this.teams.map((t) => [t.id, t]));
    const existing = this.store.load();
    const existingById = new Map(existing.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const created: BalloonTask[] = [];
    const changed: BalloonTask[] = [];
    const next: BalloonTask[] = [];

    for (const b of balloons) {
      const id = String(b.balloonid);
      if (seen.has(id)) continue;
      seen.add(id);
      const team = teamById.get(b.teamid);
      const problemLabel = BalloonService.problemLabelOf(b);
      const prev = existingById.get(id);
      let task: BalloonTask;

      if (prev) {
        const base: BalloonTask = {
          ...prev,
          problemLabel: problemLabel || prev.problemLabel,
          teamName: team ? team.name : prev.teamName,
          location: team ? (team.location?.description ?? null) : prev.location,
        };
        task = { ...base, status: this.reconciledStatus(base, b, startedAt) };
        const touched =
          task.status !== prev.status ||
          task.problemLabel !== prev.problemLabel ||
          task.teamName !== prev.teamName ||
          task.location !== prev.location;
        if (touched) changed.push(task);
      } else {
        // A balloon DOMjudge already reports as done needs no delivery; it is
        // kept as "delivered" (not delivered by us) so it never appears in the
        // pending queue after a restart, and ack() still reaches DOMjudge.
        // A failed ack POST is landed here too: DOMjudge can never flip `done`
        // for it, so the operator's delivery must not stay pending forever.
        const ack = this.ackPending.get(id);
        const status: BalloonTask["status"] =
          b.done === true || (ack?.postFailed && startedAt > ack.postCompletedAt) ? "delivered" : "pending";
        task = {
          id,
          contestId: this.contestId,
          problemLabel,
          teamName: team ? team.name : b.teamid,
          location: team?.location?.description ?? null,
          status,
          createdAt: BalloonService.submittedAtOf(b, new Date(startedAt).toISOString()),
          balloonId: Number.isFinite(Number(id)) ? Number(id) : null,
        };
        created.push(task);
      }
      next.push(task);
    }

    // Balloons DOMjudge no longer returns (removed/cancelled in DOMjudge).
    // Kept, not dropped: they are the delivery history the Operations UI shows,
    // and a DOMjudge hiccup must not erase it. Kept out of the pending queue
    // and marked "delivered" so no ack can be sent to a balloon id that 404s.
    for (const t of existing) {
      if (t.contestId !== this.contestId || seen.has(t.id)) continue; // kept with its own copy above
      this.ackPending.delete(t.id);
      const stale = t.status === "pending" ? { ...t, status: "delivered" as const } : t;
      if (stale !== t) changed.push(stale);
      next.push(stale);
    }

    if (created.length > 0 || changed.length > 0) {
      this.store.save(next);
      for (const task of created) {
        this.bus.publish("admin", "balloon-task", task);
      }
    }
    return created.length + changed.length;
  }

  /**
   * DOMjudge wins: `done: true` → delivered, `done: false` → pending. The only
   * exception is a poll whose `done: false` predates an ack POST (see
   * ackPending): that snapshot carries no information about the ack, so the row
   * keeps its current status. Any later poll sees the post-ack truth —
   * `done: true` confirms the delivery, `done: false` reverts the row to pending
   * and forgets the ack, so a DOMjudge-side revert always lands.
   *
   * A *failed* POST is the one delivery DOMjudge can never confirm: once a
   * post-ack poll still says `done: false`, the local delivery is final.
   */
  private reconciledStatus(prev: BalloonTask, b: DjBalloon, pollStartedAt: number): BalloonTask["status"] {
    if (b.done === true) {
      this.ackPending.delete(prev.id);
      return "delivered";
    }
    const ack = this.ackPending.get(prev.id);
    // A poll that started before the POST completed saw a predated snapshot.
    if (ack && pollStartedAt < ack.postCompletedAt) return prev.status;
    this.ackPending.delete(prev.id);
    return ack?.postFailed ? "delivered" : "pending";
  }

  private scheduleNext(ms: number): void {
    if (!this.running) return;
    this.schedule(() => void this.pollLoop(), ms);
  }

  private async pollLoop(): Promise<void> {
    if (!this.running || this.polling) return;
    // Generation stamp: reconfigure()/stop() bump it, so a poll that was already
    // in flight when the settings changed finishes its work but must not chain
    // another tick — otherwise the restarted loop and the stale one both poll.
    const generation = this.generation;
    this.polling = true;
    try {
      await this.pollOnce();
      if (generation !== this.generation) return;
      this.consecutiveFailures = 0;
      this.scheduleNext(this.pollIntervalMs);
    } catch (err) {
      if (generation !== this.generation) return;
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

import type { DjBalloon, DjClient, DjTeam } from "../domjudge/client";
import type { SseBus } from "../sse/bus";
import type { JsonStore } from "../store/store";
import { log } from "../log/logger";

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
  /**
   * True when the last poll did not return this balloon. DOMjudge hides
   * balloons after a scoreboard freeze and drops them when a rejudging takes
   * the submission away, so absence is NOT delivery: `status` is left exactly
   * as the last poll that saw the balloon decided it. A stale pending row is
   * kept out of the pending queue (nobody can hand out a balloon DOMjudge no
   * longer lists) but still shows its real status. A balloon that reappears is
   * un-staled by its next poll.
   */
  stale?: boolean;
  /** ISO time of the last poll that returned this balloon (absent while stale). */
  lastSeenAt?: string;
};

export type BalloonServiceDeps = {
  client: DjClient;
  store: JsonStore<BalloonTask[]>;
  bus: SseBus;
  contestId: string;
  pollIntervalSeconds: number;
  teams?: DjTeam[];
  /** Injectable scheduler for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> | void;
  /** Pairs with an injected `schedule`; defaults to clearTimeout. */
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Optional event sink (defaults to the process logger). Tests constructing
   * the service directly can inject a recorder instead of spying on console.
   */
  logger?: BalloonLogger;
};

/** The logger methods this service reports through. */
export type BalloonLogger = Pick<typeof log, "info" | "warn" | "error">;

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
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> | void;
  private readonly cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly logger: BalloonLogger;
  private teams: DjTeam[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  /** Set while a pollLoop run is in flight, so start/stop stay re-entrant. */
  private polling = false;
  /**
   * Bumped by stop(); an in-flight poll from an older generation never
   * schedules, and pollOnce discards its result (it belongs to a contest — or
   * a data epoch — that no longer exists).
   */
  private generation = 0;
  /**
   * Set by reconfigure() when the restart tick it just armed cannot run yet
   * because a poll is still in flight. The finishing poll releases `polling`,
   * cancels that unusable tick and re-arms one — otherwise the service would
   * sit at `running=true, timer=null` with no poll ever starting again (see
   * pollLoop's finally).
   */
  private restartRequested = false;
  /**
   * The restart tick start() scheduled for the hand-over. It is still pending
   * when the in-flight poll finishes, so it is cancelled and re-armed only
   * after the stale poll has released `polling` — otherwise it would fire
   * against the guard and be lost, leaving a dead poller.
   */
  private restartTick: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive polls whose balloon list came back empty (reset by a non-empty one). */
  private emptyStreak = 0;
  /** True once the current empty streak was logged, so it logs once per streak. */
  private emptyWarned = false;
  /** Acks awaiting a poll that actually observed DOMjudge saying "not done". */
  private ackPending = new Map<string, AckRecord>();
  /** Ids returned by the last successful poll: the only acks ack() accepts. */
  private liveIds = new Set<string>();

  constructor(deps: BalloonServiceDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.bus = deps.bus;
    this.contestId = deps.contestId;
    this.pollIntervalMs = deps.pollIntervalSeconds * 1000;
    this.schedule = deps.schedule ?? ((fn, ms) => {
      this.timer = setTimeout(fn, ms);
    });
    this.cancelSchedule = deps.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.teams = deps.teams ?? [];
    this.logger = deps.logger ?? log;
    this.discardForeignRows();
  }

  /**
   * Pre-Task-4 rows were synthesized from AC judgements: their `id` is a
   * submission id, never a `balloonid`, so no balloon API entry can ever match
   * them and they would sit in the store forever (looking like undelivered
   * balloons, duplicated next to the real row once balloonid === submission id
   * aliasing happens to line up). Two discriminators, both applied at
   * construction because the store is only ever read after it:
   *
   * - `contestId` differs from the live contest → foreign contest, discard.
   * - `contestId` matches but the row has no `balloonId` field at all. Every
   *   row written by this refactor carries `balloonId` (a number for a numeric
   *   balloonid, `null` when DOMjudge used a non-numeric one); pre-Task-4 rows
   *   never had the field. Checking for the *field* rather than the value keeps
   *   `balloonId: null` rows (real, current) while dropping the old schema.
   *
   * One INFO line reports the total so an operator upgrading a pre-refactor
   * data dir learns the history was dropped (clear
   * <dataDir>/balloon-tasks.json beforehand to get the same outcome silently).
   */
  private discardForeignRows(): void {
    if (!this.contestId) return;
    const rows = this.store.load();
    const isLegacyShape = (t: BalloonTask) => !("balloonId" in t);
    const kept = rows.filter((t) => t.contestId === this.contestId && !isLegacyShape(t));
    const discarded = rows.length - kept.length;
    if (discarded === 0) return;
    this.store.save(kept);
    this.logger.info(
      "balloon",
      `已丢弃 ${discarded} 条旧版气球任务（不属于比赛 ${this.contestId}，或为重构前的提交 ID 旧格式；` +
        `DOMjudge 的气球 ID 无法与之匹配）`,
    );
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
    // Reference identity, not value equality: the map above returns the SAME
    // object (`return t`) for rows it leaves alone and a fresh object for rows
    // it relabels, so this is an "any row rebuilt?" check that keeps an
    // unchanged team sync from rewriting the store on every call.
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
    // Invalidate any in-flight poll so it cannot schedule a duplicate chain and
    // cannot write its (pre-stop) snapshot back — a purge is followed by
    // stop(), and the poll that was in flight must not resurrect the rows.
    this.generation++;
    this.restartRequested = false;
    // The restart tick may differ from `timer` (it was armed while a poll was in
    // flight, over a still-pending regular tick): cancel both, otherwise a
    // second reconfigure in the same tick leaves the first restart tick alive.
    if (this.restartTick !== null) {
      this.cancelSchedule(this.restartTick);
      this.restartTick = null;
    }
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
   *
   * Invariant: once this returns there is exactly ONE active poll chain. That
   * needs `restartRequested` — a plain stop()+start() would schedule a 0ms tick
   * that pollLoop rejects (`polling` is still true) while the in-flight poll,
   * seeing its generation superseded, also returns without scheduling: a dead
   * poller. See the finally block in pollLoop.
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
      // Rows are contest-keyed: the previous contest's queue must not follow
      // the poller (the purge already empties them; this covers a settings edit).
      this.liveIds = new Set<string>();
    }
    this.stop();
    this.start();
    // The restarted chain cannot start while the old poll is still awaited
    // (pollLoop bails on `polling`), so hand it over: the finishing poll
    // cancels the tick it could not use and re-arms it once the guard is down.
    if (this.restartTick) this.restartRequested = true;
  }

  /**
   * Dispatch on a live balloon to the stored row. `stale` (the "此气球已从 DOMjudge
   * 消失" list) wins over a stored status, so a balloon hidden by a freeze does
   * not re-enter the delivery queue just because nobody has delivered it yet.
   */
  list(status?: BalloonTask["status"] | "stale"): BalloonTask[] {
    const tasks = this.store.load();
    if (status === "stale") return tasks.filter((t) => t.stale === true);
    if (status) return tasks.filter((t) => t.status === status && t.stale !== true);
    return tasks;
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
   *
   * Only ids that the last poll actually returned are accepted: an ack for
   * anything else (a typo, a removed balloon, a legacy row) returns null so the
   * route can 404 — nothing is written and nothing is POSTed. DOMjudge itself
   * rejects unknown balloon ids on `/done`, so inventing a pending ack for one
   * would leave a banner row nobody can ever clear.
   */
  async ack(
    id: string,
    status: BalloonTask["status"] = "delivered",
  ): Promise<{ task: BalloonTask } | { error: "balloon not found" }> {
    const task = this.store.load().find((t) => t.id === id);
    // A stale row's balloon is (as far as this poller knows) gone from
    // DOMjudge, and an id the last poll never returned is not a balloon at all:
    // refuse both rather than POST into a 404 or invent a row.
    if (!task || task.stale || !this.liveIds.has(id)) return { error: "balloon not found" };
    if (status !== "delivered") return { task };

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
      this.logger.error(
        "balloon",
        `ack: could not mark balloon done in domjudge for task ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return { task };
  }

  /**
   * Display label: `contestproblem.label` is where real DOMjudge responses put
   * it (ContestProblem serializes its shortname as `label`); `problem` is the
   * shortname DOMjudge puts on every balloon, kept as the fallback.
   */
  private static problemLabelOf(b: DjBalloon): string {
    return b.contestproblem?.label ?? b.problem ?? "";
  }

  /** Balloon time, ISO-normalized; the poll time when DOMjudge omits/breaks it. */
  private static balloonTimeOf(b: DjBalloon, fallback: string): string {
    const ms = b.time ? Date.parse(b.time) : Number.NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
  }

  /**
   * One poll = one GET /balloons. Returns how many task rows changed (created,
   * re-labelled, status-flipped or newly marked stale). A missing balloon list
   * (API error) throws, so the caller applies its backoff instead of pretending
   * the queue emptied.
   *
   * The poll is generation-guarded across its await: stop() (settings change,
   * purge) bumps the generation, and a snapshot fetched before that must not be
   * written back — otherwise a poll in flight during a purge resurrects the
   * just-cleared rows of the old contest.
   */
  async pollOnce(): Promise<number> {
    const generation = this.generation;
    const result = await this.pollAndReconcile(generation);
    return generation === this.generation ? result : 0;
  }

  private async pollAndReconcile(generation: number): Promise<number> {
    const startedAt = Date.now();
    const seenAt = new Date(startedAt).toISOString();
    const contestId = this.contestId;
    const balloons = await this.client.getBalloons(contestId);
    // Superseded while awaiting DOMjudge: this list may belong to a contest or
    // a data epoch that has since been replaced/purged. Drop it, write nothing,
    // publish nothing.
    if (generation !== this.generation) return 0;

    if (balloons.length === 0) {
      // A misconfigured/balloon-less DOMjudge looks exactly like "nothing to
      // deliver", so tell the operator once per streak instead of never.
      this.emptyStreak++;
      if (this.emptyStreak >= EMPTY_WARN_STREAK && !this.emptyWarned) {
        this.emptyWarned = true;
        this.logger.warn(
          "balloon",
          `气球列表为空：DOMjudge 可能未启用气球功能（比赛 ${contestId}，已连续 ${this.emptyStreak} 次轮询为空）`,
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
    const liveIds = new Set<string>();
    const created: BalloonTask[] = [];
    const changed: BalloonTask[] = [];
    const next: BalloonTask[] = [];

    for (const b of balloons) {
      const id = String(b.balloonid);
      if (seen.has(id)) continue;
      seen.add(id);
      liveIds.add(id);
      const team = teamById.get(b.teamid);
      const problemLabel = BalloonService.problemLabelOf(b);
      // DOMjudge's `location` is the team's seat; the local team table is only
      // a fallback for responses that omit it.
      const location = b.location ?? team?.location?.description ?? null;
      const prev = existingById.get(id);
      let task: BalloonTask;

      if (prev) {
        const wasStale = prev.stale === true;
        const base: BalloonTask = {
          ...prev,
          problemLabel: problemLabel || prev.problemLabel,
          teamName: team ? team.name : prev.teamName,
          location,
          stale: false,
          lastSeenAt: seenAt,
        };
        task = { ...base, status: this.reconciledStatus(base, b, startedAt) };
        // A row that was never stale has no lastSeenAt to write: it only exists
        // to say "was gone since". Avoids rewriting every row on every poll.
        if (!wasStale && prev.lastSeenAt === undefined) delete task.lastSeenAt;
        const touched =
          task.status !== prev.status ||
          task.problemLabel !== prev.problemLabel ||
          task.teamName !== prev.teamName ||
          task.location !== prev.location ||
          wasStale ||
          task.lastSeenAt !== prev.lastSeenAt;
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
          contestId,
          problemLabel,
          teamName: team ? team.name : b.teamid,
          location,
          status,
          createdAt: BalloonService.balloonTimeOf(b, seenAt),
          balloonId: Number.isFinite(Number(id)) ? Number(id) : null,
          stale: false,
        };
        created.push(task);
      }
      next.push(task);
    }

    // Balloons this poll no longer returned. Absence is not delivery: DOMjudge
    // hides post-freeze balloons from GET /balloons (they come back when the
    // scoreboard unfreezes) and drops balloons whose submission a rejudging
    // took away. So keep the row, keep the status the last sighting decided,
    // and only flag it stale — inventing "delivered" would tell the team's
    // runner a balloon was handed out when nobody has it.
    for (const t of existing) {
      if (t.contestId !== contestId || seen.has(t.id)) continue;
      const alreadyStale = t.stale === true;
      const stale: BalloonTask = { ...t, stale: true };
      delete stale.lastSeenAt;
      if (!alreadyStale) {
        // A pending ack for a balloon that vanished can no longer land.
        this.ackPending.delete(t.id);
        changed.push(stale);
      }
      next.push(stale);
    }

    this.liveIds = liveIds;

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
    const handle = this.schedule(() => void this.pollLoop(), ms) ?? null;
    // An in-flight poll owns the loop right now (only start()-after-stop(),
    // i.e. reconfigure(), can get here like this): remember its tick so a
    // later stop() cancels it and the finishing poll can re-arm it instead of
    // letting it fire against the `polling` guard and vanish.
    this.restartTick = this.polling ? handle : null;
  }

  private async pollLoop(): Promise<void> {
    // A tick that fires while a poll is still awaited is a crashed/abandoned
    // predecessor (or a hand-over tick that escaped cancellation). The poll in
    // flight re-arms the chain in its own finally, so returning here — rather
    // than polling twice — never strands the loop.
    if (!this.running || this.polling) return;
    this.restartTick = null;
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
      this.logger.error(
        "balloon",
        `poll failed for contest ${this.contestId}:`,
        err instanceof Error ? err.message : err,
      );
      const multiplier = Math.min(2 ** this.consecutiveFailures, MAX_BACKOFF_MULTIPLIER);
      this.scheduleNext(this.pollIntervalMs * multiplier);
    } finally {
      this.polling = false;
      if (this.restartRequested) {
        // reconfigure() landed while this poll was in flight. Its restart tick
        // is still pending and would have been dropped by the guard, so this
        // poll owns the hand-over: drop that tick and arm one fresh 0ms tick
        // now that `polling` is false. One timer, one chain, no dead poller.
        this.restartRequested = false;
        if (this.restartTick !== null) {
          this.cancelSchedule(this.restartTick);
          this.restartTick = null;
        }
        if (this.timer !== null) {
          this.cancelSchedule(this.timer);
          this.timer = null;
        }
        this.scheduleNext(0);
        // This hand-over tick IS the chain now: it must not be mistaken for a
        // stale restart tick (which would make the next poll hand over again).
        this.restartTick = null;
      }
    }
  }
}

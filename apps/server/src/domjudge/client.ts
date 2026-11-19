import type { Config } from "../config";

/** Hard ceiling for a single DOMjudge API request. */
export const REQUEST_TIMEOUT_MS = 10_000;

export type DjTeam = {
  id: string;
  icpc_id?: string;
  name: string;
  display_name?: string;
  organization_id?: string;
  members?: string[];
  location?: { description?: string };
};

/**
 * Effective account key for a team: icpc_id when present, otherwise the
 * DOMjudge team id. Note: this key is NOT the DOMjudge login username —
 * real deployments name team accounts `team<id>`; use findTeamUser to
 * resolve the actual username for X-DOMjudge-Login.
 */
export function teamAccountKey(t: Pick<DjTeam, "id" | "icpc_id">): string {
  return (t.icpc_id ?? "").trim() || t.id;
}

export type DjContest = {
  id: string;
  name: string;
};

export class DjApiError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, cause?: unknown) {
    super(`DOMjudge API error: ${url} (status ${status})`, { cause });
    this.name = "DjApiError";
    this.url = url;
    this.status = status;
  }
}

export type DjProblem = {
  id: string;
  label: string;
  name: string;
};

export type DjUser = {
  id: string;
  username: string;
  name?: string;
  email?: string | null;
  /** Auto-login IP whitelist, serialized as `ip` by DOMjudge. */
  ip?: string | null;
  enabled?: boolean;
  /** CLICS User roles, e.g. ["team"] or ["admin"]. */
  roles?: string[];
  /** CLICS User team_id, present on team accounts (matches the team key). */
  team_id?: string;
};

/**
 * An entry of GET /contests/{cid}/balloons (DOMjudge balloon API), mirroring
 * `App\DataTransferObject\Balloon` in domjudge/domjudge. There is no
 * `problemid`/`contesttime`/`submitted` on this endpoint — `problem` is the
 * contest shortname and `time` is the submission time.
 */
export type DjBalloon = {
  balloonid: string | number;
  time?: string;
  /** Contest shortname of the problem (DOMjudge's `probshortname`). */
  problem?: string;
  /** The contest problem; its `label` is the problem letter shown in the UI. */
  contestproblem?: { label?: string; id?: string; name?: string };
  team?: string;
  teamid: string;
  /** Team seat as configured on the team ("A-101"); null when unset. */
  location?: string | null;
  affiliation?: string | null;
  affiliationid?: string | null;
  category?: string | null;
  categoryid?: string | null;
  /** Per-team balloon totals; unused by the task mirror, kept for completeness. */
  total?: Record<string, unknown>;
  done?: boolean;
};

export class DjClient {
  private readonly cfg: () => Config["domjudge"];
  /** False when constructed from a plain config: URL/auth/timeout stay frozen. */
  private readonly live: boolean;
  private readonly fetchImpl: typeof fetch;
  /** Constructor-derived values, used only when `live` is false. */
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  /** Constructor override (tests pin a short timeout); live config never touches it. */
  private readonly explicitTimeoutMs: number | undefined;

  /**
   * `cfg` may be a live getter (the runtime config store) so DOMjudge URL and
   * credentials edits apply without a restart; a plain object is frozen.
   * `timeoutMs` is the URL/auth-independent timeout (overrides any getter).
   */
  constructor(cfg: Config["domjudge"] | (() => Config["domjudge"]), fetchImpl?: typeof fetch, timeoutMs?: number) {
    const initial = typeof cfg === "function" ? cfg() : cfg;
    this.cfg = typeof cfg === "function" ? cfg : () => initial;
    this.live = typeof cfg === "function";
    this.baseUrl = initial.baseUrl.replace(/\/+$/, "") + "/api/v4/";
    this.authHeader =
      "Basic " + Buffer.from(`${initial.adminUser}:${initial.adminPassword}`).toString("base64");
    this.fetchImpl = fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.explicitTimeoutMs = timeoutMs;
  }

  /**
   * Re-derive URL/credentials/timeout from the live config (or once, for a
   * plain-config client). Called per request — cheap: one concat + base64 — so
   * a settings PUT is visible on the very next API call. An explicit
   * constructor `timeoutMs` always wins over the config value.
   *
   * Pure: returns fresh values and never writes back to the fields derived
   * from the constructor config, so a getter that throws (or returns junk)
   * cannot leave the client holding a half-updated URL.
   */
  private sync(): { baseUrl: string; authHeader: string; timeoutMs: number } {
    const explicit = this.explicitTimeoutMs;
    if (!this.live) {
      return {
        baseUrl: this.baseUrl,
        authHeader: this.authHeader,
        timeoutMs: explicit ?? this.timeoutMs,
      };
    }
    const cfg = this.cfg();
    return {
      baseUrl: cfg.baseUrl.replace(/\/+$/, "") + "/api/v4/",
      authHeader: "Basic " + Buffer.from(`${cfg.adminUser}:${cfg.adminPassword}`).toString("base64"),
      // domjudge.timeoutSeconds is a live setting too: dropping it here is the
      // regression the first version shipped (config timeout ignored whenever
      // the client was built from a getter).
      timeoutMs: explicit ?? cfg.timeoutSeconds * 1000,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const { baseUrl, authHeader, timeoutMs } = this.sync();
    const url = baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DjApiError(url, 0, err);
    }
    if (!res.ok) {
      throw new DjApiError(url, res.status);
    }
    return (await res.json()) as T;
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    const { baseUrl, authHeader, timeoutMs } = this.sync();
    const url = baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DjApiError(url, 0, err);
    }
    if (!res.ok) {
      throw new DjApiError(url, res.status);
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private async post(path: string, body?: unknown): Promise<unknown> {
    const { baseUrl, authHeader, timeoutMs } = this.sync();
    const url = baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DjApiError(url, 0, err);
    }
    if (!res.ok) {
      throw new DjApiError(url, res.status);
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  getContests(): Promise<DjContest[]> {
    return this.get<DjContest[]>("contests");
  }

  /**
   * Resolve the DOMjudge user account behind a team key. Real deployments
   * name team accounts `team<teamId>` (username ≠ team id), so match on the
   * CLICS `team_id` first and fall back to the `team<key>` username shape.
   * Null when no user matches.
   */
  async findTeamUser(teamKey: string): Promise<DjUser | null> {
    const users = await this.get<DjUser[]>("users");
    const byTeamId = users.find((u) => u.team_id === teamKey);
    if (byTeamId) return byTeamId;
    return users.find((u) => u.username === `team${teamKey}`) ?? null;
  }

  /**
   * Reset a DOMjudge user's password via the admin API.
   *
   * Released DOMjudge (8.3+) only exposes `PUT /users/{id}` — PATCH exists on
   * the main branch alone and answers 405 on every stable version. PUT
   * *replaces* the user, so the whole current record must be echoed back or
   * fields like name/email/roles would be cleared; only `password` changes.
   */
  putUserPassword(user: DjUser, password: string): Promise<unknown> {
    const body: Record<string, unknown> = {
      id: user.id,
      username: user.username,
      name: user.name ?? user.username,
      roles: user.roles ?? [],
      password,
    };
    if (user.email !== undefined) body.email = user.email;
    if (user.ip !== undefined) body.ip = user.ip;
    if (user.enabled !== undefined) body.enabled = user.enabled;
    if (user.team_id !== undefined) body.team_id = user.team_id;
    return this.put(`users/${encodeURIComponent(user.id)}`, body);
  }

  getTeams(contestId: string): Promise<DjTeam[]> {
    return this.get<DjTeam[]>(`contests/${contestId}/teams`);
  }

  getProblems(contestId: string): Promise<DjProblem[]> {
    return this.get<DjProblem[]>(`contests/${contestId}/problems`);
  }

  getBalloons(contestId: string): Promise<DjBalloon[]> {
    return this.get<DjBalloon[]>(`contests/${contestId}/balloons`);
  }

  /** Mark a balloon as delivered (POST /contests/{cid}/balloons/{id}/done). */
  markBalloonDone(contestId: string, balloonId: string): Promise<unknown> {
    return this.post(`contests/${contestId}/balloons/${encodeURIComponent(balloonId)}/done`);
  }
}

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

/**
 * A submission from the contest API. Two shapes occur in the wild:
 * - CLICS/external API (verified live against
 *   https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/submissions):
 *   `{"language_id":"cpp","time":"...","contest_time":"...","team_id":"domjudge",
 *   "account_id":"tobi","problem_id":"arcadecrane","files":[...],"id":"997",
 *   "entry_point":null,"import_error":null}`
 * - DOMjudge internal API: `problem`/`team`/`language` directly.
 * getSubmissions normalizes both to the canonical `problem`/`team`/`language`
 * while preserving the original `*_id` fields.
 */
export type DjSubmission = {
  id: string;
  /** Canonical problem id (from `problem_id` on the external API). */
  problem: string;
  /** Canonical language id (from `language_id` on the external API). */
  language: string;
  /** Canonical team id (from `team_id` on the external API). */
  team: string;
  time: string;
  // Raw external-API fields, preserved for callers that read them directly.
  problem_id?: string;
  team_id?: string;
  language_id?: string;
  contest_time?: string;
  account_id?: string;
  files?: Array<{ href: string; mime: string }>;
  entry_point?: string | null;
  import_error?: string | null;
};

/**
 * A judging from the contest API. Two shapes occur in the wild:
 * - CLICS/external API (verified live against
 *   https://www.domjudge.org/demoweb/api/v4/contests/nwerc2025/judgements):
 *   `{"start_time":...,"end_time":...,"submission_id":"997","current":true,
 *   "max_run_time":2.994,"id":"1814","valid":true,"score":"0.000000000",
 *   "judgement_type_id":"TLE","simplified_judgement_type_id":"RE"}`
 * - DOMjudge internal API: `submission` directly.
 * getJudgings populates the canonical `submission` from `submission_id`.
 */
export type DjJudging = {
  id: string;
  /** Canonical submission id (from `submission_id` on the external API). */
  submission: string;
  judgement_type_id: string;
  verified?: boolean;
  start_time?: string;
  // Raw external-API fields, preserved for callers that read them directly.
  submission_id?: string;
  end_time?: string;
  current?: boolean;
  max_run_time?: number;
  valid?: boolean;
  score?: string;
  simplified_judgement_type_id?: string;
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

export type DjJudgementType = {
  id: string;
  name?: string;
  penalty?: boolean;
  /** True when this verdict counts as solved/correct (real DOMjudge external API). */
  solved?: boolean;
  sorting_key?: string;
};

export type DjProblem = {
  id: string;
  label: string;
  name: string;
};

export type DjUser = {
  id: string;
  username: string;
  name?: string;
  /** CLICS User roles, e.g. ["team"] or ["admin"]. */
  roles?: string[];
  /** CLICS User team_id, present on team accounts (matches the team key). */
  team_id?: string;
};

/** An entry of GET /contests/{cid}/balloons (DOMjudge balloon API). */
export type DjBalloon = {
  balloonid: string;
  teamid: string;
  problem?: string;
  problemid?: string;
  /** Problem object carrying the display label on real DOMjudge responses. */
  contestproblem?: { label?: string; id?: string; name?: string };
  contesttime?: string;
  time?: string;
  submitted?: string;
  done?: boolean;
};

export class DjClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: Config["domjudge"], fetchImpl?: typeof fetch, timeoutMs?: number) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "") + "/api/v4/";
    this.authHeader =
      "Basic " + Buffer.from(`${cfg.adminUser}:${cfg.adminPassword}`).toString("base64");
    this.fetchImpl = fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async get<T>(path: string): Promise<T> {
    const url = this.baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: this.authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DjApiError(url, 0, err);
    }
    if (!res.ok) {
      throw new DjApiError(url, res.status);
    }
    return (await res.json()) as T;
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    const url = this.baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "PATCH",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
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
    const url = this.baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
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

  /** Reset a DOMjudge user's password via the admin API (PATCH /users/{id}). */
  patchUserPassword(userId: string, password: string): Promise<unknown> {
    return this.patch(`users/${encodeURIComponent(userId)}`, { password });
  }

  getTeams(contestId: string): Promise<DjTeam[]> {
    return this.get<DjTeam[]>(`contests/${contestId}/teams`);
  }

  getSubmissions(contestId: string): Promise<DjSubmission[]> {
    return this.get<DjSubmission[]>(`contests/${contestId}/submissions`).then((subs) =>
      // Normalize CLICS/external field names (problem_id/team_id/language_id)
      // to the canonical internal ones; internal shapes pass through unchanged.
      subs.map((item) => ({
        ...item,
        problem: item.problem ?? item.problem_id!,
        team: item.team ?? item.team_id!,
        language: item.language ?? item.language_id!,
      })),
    );
  }

  getJudgementTypes(contestId: string): Promise<DjJudgementType[]> {
    return this.get<DjJudgementType[]>(`contests/${contestId}/judgement-types`);
  }

  getProblems(contestId: string): Promise<DjProblem[]> {
    return this.get<DjProblem[]>(`contests/${contestId}/problems`);
  }

  getJudgings(contestId: string, since?: string): Promise<DjJudging[]> {
    const path = `contests/${contestId}/judgements`;
    return this.get<DjJudging[]>(since ? `${path}?since=${encodeURIComponent(since)}` : path).then(
      (judgings) =>
        // Normalize CLICS/external `submission_id` to the canonical
        // `submission`; internal shapes pass through unchanged.
        judgings.map((item) => ({ ...item, submission: item.submission ?? item.submission_id! })),
    );
  }

  getBalloons(contestId: string): Promise<DjBalloon[]> {
    return this.get<DjBalloon[]>(`contests/${contestId}/balloons`);
  }

  /** Mark a balloon as delivered (POST /contests/{cid}/balloons/{id}/done). */
  markBalloonDone(contestId: string, balloonId: string): Promise<unknown> {
    return this.post(`contests/${contestId}/balloons/${encodeURIComponent(balloonId)}/done`);
  }
}

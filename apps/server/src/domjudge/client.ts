import type { Config } from "../config";

export type DjTeam = {
  id: string;
  icpc_id?: string;
  name: string;
  display_name?: string;
  organization_id?: string;
  members?: string[];
  location?: { description?: string };
};

export type DjContest = {
  id: string;
  name: string;
};

export type DjSubmission = {
  id: string;
  problem: string;
  language: string;
  team: string;
  time: string;
};

export type DjJudging = {
  id: string;
  submission: string;
  judgement_type_id: string;
  verified?: boolean;
  start_time?: string;
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
  sorting_key?: string;
};

export type DjProblem = {
  id: string;
  label: string;
  name: string;
};

export class DjClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Config["domjudge"], fetchImpl?: typeof fetch) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "") + "/api/v4/";
    this.authHeader =
      "Basic " + Buffer.from(`${cfg.adminUser}:${cfg.adminPassword}`).toString("base64");
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const url = this.baseUrl + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: this.authHeader, Accept: "application/json" },
      });
    } catch (err) {
      throw new DjApiError(url, 0, err);
    }
    if (!res.ok) {
      throw new DjApiError(url, res.status);
    }
    return (await res.json()) as T;
  }

  getContests(): Promise<DjContest[]> {
    return this.get<DjContest[]>("contests");
  }

  getTeams(contestId: string): Promise<DjTeam[]> {
    return this.get<DjTeam[]>(`contests/${contestId}/teams`);
  }

  getSubmissions(contestId: string): Promise<DjSubmission[]> {
    return this.get<DjSubmission[]>(`contests/${contestId}/submissions`);
  }

  getJudgementTypes(contestId: string): Promise<DjJudgementType[]> {
    return this.get<DjJudgementType[]>(`contests/${contestId}/judgement-types`);
  }

  getProblems(contestId: string): Promise<DjProblem[]> {
    return this.get<DjProblem[]>(`contests/${contestId}/problems`);
  }

  getJudgings(contestId: string, since?: string): Promise<DjJudging[]> {
    const path = `contests/${contestId}/judgements`;
    return this.get<DjJudging[]>(since ? `${path}?since=${encodeURIComponent(since)}` : path);
  }
}

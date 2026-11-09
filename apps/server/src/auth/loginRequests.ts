import { randomUUID } from "node:crypto";
import { JsonStore } from "../store/store";

export type LoginRequestStatus = "pending" | "approved" | "rejected" | "claimed";

export type LoginRequest = {
  id: string;
  icpcId: string;
  teamCode: string;
  teamName: string;
  ip: string | null;
  requestedAt: string;
  status: LoginRequestStatus;
  decidedAt: string | null;
};

export type LoginRequestDecision = "approved" | "rejected";

export type NewLoginRequest = {
  icpcId: string;
  teamCode: string;
  teamName: string;
  ip: string | null;
};

/**
 * Approval requests for team logins outside the allowed window. Approval is
 * valid ONCE: an approved request is consumed (status → "claimed") when the
 * team claims its token, so the same request can never log in twice.
 */
export class LoginRequestStore {
  /** Underlying store; exposed for maintenance flows (admin purge). */
  readonly store: JsonStore<LoginRequest[]>;

  constructor(filePath: string) {
    this.store = new JsonStore<LoginRequest[]>(filePath, []);
  }

  create(req: NewLoginRequest): LoginRequest {
    const request: LoginRequest = {
      id: randomUUID(),
      ...req,
      requestedAt: new Date().toISOString(),
      status: "pending",
      decidedAt: null,
    };
    this.store.update((cur) => [request, ...cur]);
    return request;
  }

  get(id: string): LoginRequest | null {
    return this.store.load().find((r) => r.id === id) ?? null;
  }

  listPending(): LoginRequest[] {
    return this.store.load().filter((r) => r.status === "pending");
  }

  listAll(): LoginRequest[] {
    return this.store.load();
  }

  /** Only pending requests can be decided; anything else is left untouched. */
  decide(id: string, decision: LoginRequestDecision): LoginRequest | null {
    // A mutable let (not a definite-assignment const) keeps TS's control-flow
    // analysis able to narrow the callback's assignment when we return it.
    let updated: LoginRequest | null = null;
    this.store.update((cur) =>
      cur.map((r) => {
        if (r.id !== id || r.status !== "pending") return r;
        const next: LoginRequest = { ...r, status: decision, decidedAt: new Date().toISOString() };
        updated = next;
        return next;
      }),
    );
    return updated;
  }

  /** Only approved requests can be consumed; the request then becomes "claimed". */
  consume(id: string): LoginRequest | null {
    let consumed: LoginRequest | null = null;
    this.store.update((cur) =>
      cur.map((r) => {
        if (r.id !== id || r.status !== "approved") return r;
        const next: LoginRequest = { ...r, status: "claimed" };
        consumed = next;
        return next;
      }),
    );
    return consumed;
  }
}

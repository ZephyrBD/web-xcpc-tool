import { JsonStore } from "../store/store";

export type LoginHistoryEntry = {
  icpcId: string;
  teamCode: string;
  at: string;
  ip: string | null;
};

const DEFAULT_CAP = 2000;

/**
 * Append-only login history for successful team-code verifications.
 * Newest entries come first in the file; the cap keeps the JSON from
 * growing without bound (last N entries survive, older ones are dropped).
 */
export class LoginHistoryStore {
  /** Underlying store; exposed for maintenance flows (admin purge). */
  readonly store: JsonStore<LoginHistoryEntry[]>;
  private readonly cap: number;

  constructor(filePath: string, cap: number = DEFAULT_CAP) {
    this.store = new JsonStore<LoginHistoryEntry[]>(filePath, []);
    this.cap = cap;
  }

  append(entry: LoginHistoryEntry): void {
    this.store.update((cur) => [entry, ...cur].slice(0, this.cap));
  }

  /** Newest first, at most `limit` entries. */
  list(limit = 100): LoginHistoryEntry[] {
    return this.store.load().slice(0, Math.max(0, limit));
  }
}

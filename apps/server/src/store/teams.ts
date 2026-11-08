import { randomInt } from "node:crypto";
import type { SecretBox } from "./secretbox";
import { JsonStore } from "./store";

type TeamEntry = { password: string; teamCode?: string };

/** Unambiguous charset for human-typed team codes: no 0/O/1/l/I. */
const CODE_CHARSET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 12;

export class TeamStore {
  private readonly store: JsonStore<Record<string, TeamEntry | string>>;
  private readonly box: SecretBox;

  constructor(filePath: string, secretBox: SecretBox) {
    this.store = new JsonStore<Record<string, TeamEntry | string>>(filePath, {});
    this.box = secretBox;
  }

  /** Legacy files stored the encrypted password as a bare string value. */
  private entries(): Record<string, TeamEntry> {
    const cur = this.store.load();
    const out: Record<string, TeamEntry> = {};
    for (const [icpcId, value] of Object.entries(cur)) {
      out[icpcId] = typeof value === "string" ? { password: value } : value;
    }
    return out;
  }

  setPassword(icpcId: string, password: string): void {
    this.store.update((cur) => {
      const entry = cur[icpcId];
      const teamCode = typeof entry === "string" ? undefined : entry?.teamCode;
      return { ...cur, [icpcId]: { password: this.box.encrypt(password), teamCode } };
    });
  }

  getPassword(icpcId: string): string | null {
    const payload = this.entries()[icpcId];
    if (payload === undefined) return null;
    return this.box.decrypt(payload.password);
  }

  /**
   * Assigns a login code to a team. When `code` is omitted a random
   * unambiguous 12-char code is generated; it is unique across the store.
   * Re-calling replaces the previous code.
   */
  setTeamCode(icpcId: string, code?: string): string {
    const assigned = code ?? this.generateCode();
    this.store.update((cur) => {
      const entry = cur[icpcId];
      const password = typeof entry === "string" ? entry : entry?.password ?? "";
      return { ...cur, [icpcId]: { password, teamCode: assigned } };
    });
    return assigned;
  }

  private generateCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARSET[randomInt(CODE_CHARSET.length)];
      if (!this.findByTeamCode(code)) return code;
    }
  }

  findByTeamCode(code: string): { icpcId: string; teamCode: string } | null {
    const wanted = code.trim().toLowerCase();
    if (!wanted) return null;
    for (const [icpcId, entry] of Object.entries(this.entries())) {
      if (entry.teamCode && entry.teamCode.toLowerCase() === wanted) {
        return { icpcId, teamCode: entry.teamCode };
      }
    }
    return null;
  }

  list(): Array<{ icpcId: string }> {
    return Object.keys(this.entries()).map((icpcId) => ({ icpcId }));
  }

  /** Assigned code for a team, or null. */
  getTeamCode(icpcId: string): string | null {
    return this.entries()[icpcId]?.teamCode ?? null;
  }

  /** True when the team has a stored (encrypted) password. */
  hasPassword(icpcId: string): boolean {
    const password = this.entries()[icpcId]?.password;
    return typeof password === "string" && password !== "";
  }
}

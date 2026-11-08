import type { Config } from "../config";
import { signTeamToken } from "../auth/token";
import type { TeamStore } from "../store/teams";

export type VerifyFailReason = "bad-code" | "outside-window";

export type VerifyResult =
  | { ok: true; token: string }
  | { ok: false; reason: VerifyFailReason };

/** Both bounds empty = always allowed; only one bound set restricts from that side. */
export function inLoginWindow(now: Date, window: Config["teamLogin"]): boolean {
  if (window.start && now.getTime() < Date.parse(window.start)) return false;
  if (window.end && now.getTime() > Date.parse(window.end)) return false;
  return true;
}

/**
 * Pure verification: check the login window first (so a wrong code and a
 * right code behave identically while the window is closed), then look up
 * the typed team code, and sign a team token whose payload carries the
 * team's icpcId.
 */
export async function verifyTeamCode(
  code: string,
  teamStore: TeamStore,
  cfg: Config,
  now: Date = new Date(),
): Promise<VerifyResult> {
  if (!inLoginWindow(now, cfg.teamLogin)) return { ok: false, reason: "outside-window" };
  const entry = teamStore.findByTeamCode(code);
  if (!entry) return { ok: false, reason: "bad-code" };
  const token = await signTeamToken(cfg.jwt.secret, cfg.jwt.ttlSeconds, entry.icpcId);
  return { ok: true, token };
}

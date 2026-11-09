import type { Config } from "../config";
import { signTeamToken } from "../auth/token";
import type { LoginRequest, LoginRequestStore } from "../auth/loginRequests";
import type { TeamStore } from "../store/teams";

export type VerifyFailReason = "bad-code" | "outside-window";

export type VerifyResult =
  | { ok: true; token: string }
  | { ok: false; reason: VerifyFailReason }
  | { ok: false; reason: "waiting"; request: LoginRequest };

/** Both bounds empty = always allowed; only one bound set restricts from that side. */
export function inLoginWindow(now: Date, window: Config["teamLogin"]): boolean {
  if (window.start && now.getTime() < Date.parse(window.start)) return false;
  if (window.end && now.getTime() > Date.parse(window.end)) return false;
  return true;
}

export type VerifyContext = {
  /** Caller IP recorded on newly created approval requests. */
  ip?: string | null;
  /** Resolves a display name for the team holding `icpcId` (falls back to the id). */
  teamNameOf?: (icpcId: string) => string;
  /** Notified only when a NEW approval request is created (reused pending ones are not). */
  onRequestCreated?: (request: LoginRequest) => void;
};

/**
 * Pure verification: check the login window first (so a wrong code and a
 * right code behave identically while the window is closed), then look up
 * the typed team code, and sign a team token whose payload carries the
 * team's effective account key (icpc id, or DOMjudge team id when the
 * icpc id is missing).
 *
 * While the window is closed, a matching code with a `requestStore` available
 * creates (or reuses the team's existing pending) approval request and returns
 * the "waiting" result instead; a non-matching code still reports
 * "outside-window" so the miss page copy stays identical.
 */
export async function verifyTeamCode(
  code: string,
  teamStore: TeamStore,
  cfg: Config,
  now: Date = new Date(),
  requestStore?: LoginRequestStore,
  context?: VerifyContext,
): Promise<VerifyResult> {
  if (!inLoginWindow(now, cfg.teamLogin)) {
    const entry = teamStore.findByTeamCode(code);
    if (!requestStore || !entry) return { ok: false, reason: "outside-window" };
    const existing = requestStore
      .listPending()
      .find((r) => r.icpcId === entry.icpcId && r.teamCode === entry.teamCode);
    const request =
      existing ??
      requestStore.create({
        icpcId: entry.icpcId,
        teamCode: entry.teamCode,
        teamName: context?.teamNameOf?.(entry.icpcId) ?? entry.icpcId,
        ip: context?.ip ?? null,
      });
    // Only a brand-new request is announced; reused pending ones were already
    // announced when they were created (avoid duplicate admin toasts).
    if (!existing) context?.onRequestCreated?.(request);
    return { ok: false, reason: "waiting", request };
  }
  const entry = teamStore.findByTeamCode(code);
  if (!entry) return { ok: false, reason: "bad-code" };
  const token = await signTeamToken(cfg.jwt.secret, cfg.jwt.ttlSeconds, entry.icpcId);
  return { ok: true, token };
}

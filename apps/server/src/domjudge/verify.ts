import type { Config } from "../config";
import type { AuthTask } from "../queue/authQueue";
import { signTeamToken } from "../auth/token";
import { identifyClient, type ClientFingerprint } from "../oms/identify";

export type VerifyFailReason =
  | "illegal client" // client matched no OMS strategy
  | "not approved" // recognized, but no task for examNum+clientId
  | "pending" // task exists, waiting for proctor approval
  | "rejected"; // task was rejected by the proctor

export type VerifyResult =
  | { ok: true; token: string }
  | { ok: false; reason: VerifyFailReason };

/**
 * Pure verification: identify → find approved/auto-done task for
 * examNum+clientId → sign team token. Failing that, report the closest
 * status (pending / rejected) so the route can render a helpful page.
 */
export async function verifyClient(
  fp: ClientFingerprint,
  examNum: string,
  tasks: AuthTask[],
  cfg: Config,
  bind?: (task: AuthTask, examNum: string) => AuthTask | null,
): Promise<VerifyResult> {
  const identified = identifyClient(fp, cfg.oms);
  if (!identified) return { ok: false, reason: "illegal client" };

  const clientIdHeader = Object.entries(fp.headers).find(
    ([k]) => k.toLowerCase() === "x-oms-client-id",
  )?.[1];
  const clientId = clientIdHeader ?? null;

  const mine = tasks.filter((t) => t.examNum === examNum && t.clientId === clientId);
  if (mine.length === 0) {
    // The examinee typed the examNum; bind it onto this client's "unknown"
    // placeholder task, then re-evaluate with the bound state.
    const unknown = tasks.find((t) => t.examNum === "unknown" && t.clientId === clientId);
    if (unknown && bind) {
      bind(unknown, examNum);
      return verifyClient(
        fp,
        examNum,
        tasks.map((t) => (t.id === unknown.id ? { ...t, examNum } : t)),
        cfg,
      );
    }
  }
  if (mine.some((t) => t.status === "approved" || t.status === "auto-done")) {
    const token = await signTeamToken(cfg.jwt.secret, cfg.jwt.ttlSeconds, examNum);
    return { ok: true, token };
  }
  if (mine.some((t) => t.status === "pending")) return { ok: false, reason: "pending" };
  if (mine.some((t) => t.status === "rejected")) return { ok: false, reason: "rejected" };
  return { ok: false, reason: "not approved" };
}

import type { Config } from "../config";
import type { AuthTask } from "../queue/authQueue";
import { signTeamToken } from "../auth/token";
import { identifyClient, type ClientFingerprint } from "../oms/identify";

export type VerifyResult = { ok: true; token: string } | { ok: false; reason: string };

/** Pure verification: identify → find approved/auto-done task for examNum+clientId → sign team token. */
export async function verifyClient(
  fp: ClientFingerprint,
  examNum: string,
  tasks: AuthTask[],
  cfg: Config,
): Promise<VerifyResult> {
  const identified = identifyClient(fp, cfg.oms);
  if (!identified) return { ok: false, reason: "illegal client" };

  const clientIdHeader = Object.entries(fp.headers).find(
    ([k]) => k.toLowerCase() === "x-oms-client-id",
  )?.[1];
  const clientId = clientIdHeader ?? null;

  const task = tasks.find(
    (t) =>
      (t.status === "approved" || t.status === "auto-done") &&
      t.examNum === examNum &&
      t.clientId === clientId,
  );
  if (!task) return { ok: false, reason: "not approved" };

  const token = await signTeamToken(cfg.jwt.secret, cfg.jwt.ttlSeconds, examNum);
  return { ok: true, token };
}

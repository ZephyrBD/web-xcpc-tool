import { sign, verify } from "hono/jwt";

export async function signTeamToken(secret: string, ttlSeconds: number, examNum: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ examNum, exp: now + ttlSeconds }, secret, "HS256");
}

export async function verifyTeamToken(secret: string, token: string): Promise<{ examNum: string } | null> {
  try {
    const payload = await verify(token, secret, "HS256");
    if (typeof payload.examNum !== "string") return null;
    return { examNum: payload.examNum };
  } catch {
    return null;
  }
}

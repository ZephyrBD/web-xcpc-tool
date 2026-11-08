import { sign, verify } from "hono/jwt";

export async function signTeamToken(secret: string, ttlSeconds: number, sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub, exp: now + ttlSeconds }, secret, "HS256");
}

export async function verifyTeamToken(secret: string, token: string): Promise<{ sub: string } | null> {
  try {
    const payload = await verify(token, secret, "HS256");
    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export type AdminTokenPayload = { role: "admin"; sub: string };

export async function signAdminToken(secret: string, ttlSeconds: number, sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ role: "admin", sub, exp: now + ttlSeconds }, secret, "HS256");
}

export async function verifyAdminToken(secret: string, token: string): Promise<AdminTokenPayload | null> {
  try {
    const payload = (await verify(token, secret, "HS256")) as Record<string, unknown>;
    if (payload.role !== "admin" || typeof payload.sub !== "string") return null;
    return { role: "admin", sub: payload.sub };
  } catch {
    return null;
  }
}

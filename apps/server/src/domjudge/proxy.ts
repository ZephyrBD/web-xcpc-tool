import type { Context } from "hono";
import { proxy } from "hono/proxy";
import type { Config } from "../config";
import { verifyTeamToken } from "../auth/token";

const HOP_BY_HOP = new Set([
  "host",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Returns the path after "/dj" to forward upstream, or null if the request is not under /dj. */
export function proxyFilter(c: Context): string | null {
  const path = new URL(c.req.url).pathname;
  if (path !== "/dj" && !path.startsWith("/dj/")) return null;
  const rest = path.slice("/dj".length);
  return rest === "" ? "/" : rest;
}

/** Joins the DOMjudge baseUrl with a remaining path (leading slash optional). */
export function resolveTarget(cfg: Config, path: string): string {
  return `${cfg.domjudge.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Extracts a cookie value from a raw Cookie header. */
export function getCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export async function handleDjProxy(c: Context, cfg: Config): Promise<Response> {
  const token = getCookie(c.req.header("cookie"), "cxtool-token");
  if (!token || !(await verifyTeamToken(cfg.jwt.secret, token))) {
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }
  const rest = proxyFilter(c);
  if (rest === null) {
    return c.json({ ok: false, reason: "not found" }, 404);
  }
  const target = resolveTarget(cfg, rest) + new URL(c.req.url).search;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k] = v;
  }
  for (const h of HOP_BY_HOP) headers[h] = undefined;
  try {
    return await proxy(target, { raw: c.req.raw, headers });
  } catch {
    return c.json({ ok: false, reason: "upstream error" }, 502);
  }
}

import type { Context } from "hono";
import { proxy } from "hono/proxy";
import type { Config } from "../config";
import { verifyTeamToken } from "../auth/token";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Path relative to this app. Under production mounting
 * (`new Hono().route(cfg.contextPath, app)`) `c.req.url` still carries the
 * prefix, so subtract it once here; when served directly it is a no-op.
 */
export function appPath(c: Context, cfg: Config): string {
  const raw = new URL(c.req.url).pathname;
  const prefix = cfg.contextPath.replace(/\/+$/, "");
  if (prefix && (raw === prefix || raw.startsWith(`${prefix}/`))) {
    return raw.slice(prefix.length) || "/";
  }
  return raw;
}

/** Returns the path after "/dj" to forward upstream, or null if the request is not under /dj. */
export function proxyFilter(c: Context, cfg: Config): string | null {
  const path = appPath(c, cfg);
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

/** Cookie header forwarded upstream: everything except cxtool-token (DOMjudge sessions must survive). */
export function forwardCookie(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.toLowerCase().startsWith("cxtool-token="));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

export async function handleDjProxy(c: Context, cfg: Config): Promise<Response> {
  const token = getCookie(c.req.header("cookie"), "cxtool-token");
  if (!token || !(await verifyTeamToken(cfg.jwt.secret, token))) {
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }
  const rest = proxyFilter(c, cfg);
  if (rest === null) {
    return c.json({ ok: false, reason: "not found" }, 404);
  }
  const target = resolveTarget(cfg, rest) + new URL(c.req.url).search;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k] = v;
  }
  for (const h of HOP_BY_HOP) headers[h] = undefined;
  headers["cookie"] = forwardCookie(c.req.header("cookie"));
  try {
    return await proxy(target, { raw: c.req.raw, headers });
  } catch (err) {
    console.error(`dj proxy upstream error: ${target}`, err instanceof Error ? err.message : err);
    return c.json({ ok: false, reason: "upstream error" }, 502);
  }
}

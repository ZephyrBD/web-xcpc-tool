import type { Context } from "hono";
import { proxy } from "hono/proxy";
import type { Config } from "../config";
import { verifyTeamToken } from "../auth/token";
import type { TeamStore } from "../store/teams";

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

/** Shared upstream forwarding: headers, login injection, proxy call. */
async function forwardToDj(
  req: Request,
  cfg: Config,
  teamStore: TeamStore | undefined,
  payload: { sub: string },
  rest: string,
): Promise<Response> {
  const target = resolveTarget(cfg, rest) + new URL(req.url).search;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of req.headers.entries()) {
    headers[k] = v;
  }
  for (const h of HOP_BY_HOP) headers[h] = undefined;
  headers["cookie"] = forwardCookie(req.headers.get("cookie"));
  // DOMjudge processes X-Headers only at /login: inject the team credential
  // there so the team is logged in without typing a DOMjudge password.
  if (rest === "/login" || rest.startsWith("/login/")) {
    const password = teamStore?.getPassword(payload.sub) ?? null;
    // The team key is not the DOMjudge login name; only the username resolved
    // at provision time may be injected. Without it there is nothing to log in.
    const djUsername = teamStore?.getDjUsername(payload.sub) ?? null;
    if (password !== null && djUsername !== null) {
      // Header values must not carry whitespace or control characters.
      const login = djUsername.replace(/[\s\x00-\x1f\x7f]/g, "");
      if (login) {
        headers["x-domjudge-login"] = login;
        headers["x-domjudge-pass"] = Buffer.from(password, "utf8").toString("base64");
      }
    }
  }
  try {
    return await proxy(target, { raw: req, headers });
  } catch (err) {
    console.error(`dj proxy upstream error: ${target}`, err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ ok: false, reason: "upstream error" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

export async function handleDjProxy(c: Context, cfg: Config, teamStore?: TeamStore): Promise<Response> {
  const token = getCookie(c.req.header("cookie"), "cxtool-token");
  const payload = token ? await verifyTeamToken(cfg.jwt.secret, token) : null;
  if (!payload) {
    // Teams are humans: send them to the verify page, where they type their
    // team code (shown on screen) to start authentication.
    return c.redirect(`${cfg.contextPath.replace(/\/+$/, "")}/dj/verify`, 302);
  }
  const rest = proxyFilter(c, cfg);
  if (rest === null) {
    return c.json({ ok: false, reason: "not found" }, 404);
  }
  return forwardToDj(c.req.raw, cfg, teamStore, payload, rest);
}

/**
 * Reverse-proxy any path outside the admin contextPath directly to DOMjudge,
 * with the same team-token semantics as /dj/*: a valid team cookie is
 * forwarded upstream, anything else is sent to the team verify page.
 */
export async function handleRootDjProxy(req: Request, cfg: Config, teamStore?: TeamStore): Promise<Response> {
  const token = getCookie(req.headers.get("cookie"), "cxtool-token");
  const payload = token ? await verifyTeamToken(cfg.jwt.secret, token) : null;
  if (!payload) {
    // Carry the original URL so verify can send the team back where they started.
    const url = new URL(req.url);
    const next = encodeURIComponent(`${url.pathname}${url.search}`);
    const location = `${cfg.contextPath.replace(/\/+$/, "")}/dj/verify?next=${next}`;
    return Response.redirect(new URL(location, req.url).toString(), 302);
  }
  return forwardToDj(req, cfg, teamStore, payload, new URL(req.url).pathname);
}

type HonoLike = { fetch: (req: Request) => Promise<Response> | Response };

/**
 * Dispatcher for Bun.serve: paths inside the admin contextPath go to the
 * Hono app; everything else falls through to the DOMjudge root proxy.
 */
export function makeRootDispatch(
  serving: HonoLike,
  cfg: Config,
  teamStore?: TeamStore,
): (req: Request) => Promise<Response> {
  const prefix = cfg.contextPath.replace(/\/+$/, "");
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
      return serving.fetch(req);
    }
    return handleRootDjProxy(req, cfg, teamStore);
  };
}

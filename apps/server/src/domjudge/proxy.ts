import type { Context } from "hono";
import { proxy } from "hono/proxy";
import { CONTEXT_PATH, type Config } from "../config";
import { verifyTeamToken } from "../auth/token";
import { upstreamErrorPage } from "../pages/teamPages";
import type { TeamStore } from "../store/teams";
import { log } from "../log/logger";

/** A config snapshot, or a getter for the live one (runtime config store). */
export type ConfigSource = Config | (() => Config);

const snapshot = (src: ConfigSource): Config => (typeof src === "function" ? src() : src);

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
 * (`new Hono().route(CONTEXT_PATH, app)`) `c.req.url` still carries the
 * prefix, so subtract it once here; when served directly it is a no-op.
 */
export function appPath(c: Context): string {
  const raw = new URL(c.req.url).pathname;
  if (raw === CONTEXT_PATH || raw.startsWith(`${CONTEXT_PATH}/`)) {
    return raw.slice(CONTEXT_PATH.length) || "/";
  }
  return raw;
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

/**
 * Rewrites upstream Set-Cookie headers for our reverse proxy: teams reach us
 * over plain HTTP on the LAN, so a `Secure` cookie from the HTTPS demo would
 * be dropped by the browser and the login session never stored. `Path` is
 * normalized to "/" because upstream base-url prefixes like /demoweb would
 * otherwise scope the session cookie away from our proxied root paths.
 * On HTTPS deployments dropping Secure is a mild attribute downgrade,
 * acceptable for this LAN tool. Everything else (HttpOnly, SameSite,
 * name=value) is preserved.
 */
function rewriteSetCookie(cookie: string): string {
  const parts = cookie.split(";").map((p) => p.trim());
  const kept: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "secure") continue;
    if (lower.startsWith("path=")) {
      kept.push("Path=/");
      continue;
    }
    if (part !== "") kept.push(part);
  }
  return kept.join("; ");
}

async function rewriteResponseCookies(res: Response): Promise<Response> {
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return res;
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    headers.append("set-cookie", rewriteSetCookie(cookie));
  }
  // 304 and other empty-body statuses must not carry a body.
  const body = res.status === 204 || res.status === 304 || res.status === 205 ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
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
  // The proxy re-encodes the streamed body: a stale content-length from the
  // original request produces a duplicate header and upstream 400s on POSTs.
  headers["content-length"] = undefined;
  headers["cookie"] = forwardCookie(req.headers.get("cookie"));
  // DOMjudge processes X-Headers at its /login URL whatever base-url prefix
  // precedes it: match the final path segment so /demoweb/login also gets
  // the team credential injected for passwordless login.
  if (/(^|\/)login(\/|$)/.test(rest)) {
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
    // redirect:"manual" keeps 302s (and their Set-Cookie) verbatim: DOMjudge's
    // xheaders login replies 302 with the session cookie, which fetch would
    // otherwise swallow while following the redirect and drop the login.
    const res = await proxy(target, { raw: req, headers, redirect: "manual" });
    return await rewriteResponseCookies(res);
  } catch (err) {
    log.error("proxy", `upstream error: ${target}`, err instanceof Error ? err.message : err);
    // Browsers navigating here are humans: show a friendly retry page instead
    // of raw JSON. API clients still get machine-readable JSON.
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/html")) {
      return upstreamErrorPage();
    }
    return new Response(JSON.stringify({ ok: false, reason: "upstream error" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * Reverse-proxy any path outside the admin contextPath directly to DOMjudge.
 * A valid team cookie is forwarded upstream; anything else is sent to the team
 * verify page (with the original URL as `next`).
 */
export async function handleRootDjProxy(req: Request, src: ConfigSource, teamStore?: TeamStore): Promise<Response> {
  const cfg = snapshot(src);
  const token = getCookie(req.headers.get("cookie"), "cxtool-token");
  const payload = token ? await verifyTeamToken(cfg.jwt.secret, token) : null;
  if (!payload) {
    // Carry the original URL so verify can send the team back where they started.
    const url = new URL(req.url);
    const next = encodeURIComponent(`${url.pathname}${url.search}`);
    const location = `${CONTEXT_PATH}/public/verify?next=${next}`;
    return Response.redirect(new URL(location, req.url).toString(), 302);
  }
  return forwardToDj(req, cfg, teamStore, payload, new URL(req.url).pathname);
}

type HonoLike = { fetch: (req: Request) => Promise<Response> | Response };

/**
 * Dispatcher for Bun.serve: paths inside the fixed /wxt mount go to the Hono
 * app; everything else falls through to the DOMjudge root proxy.
 */
export function makeRootDispatch(
  serving: HonoLike,
  src: ConfigSource,
  teamStore?: TeamStore,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (path === CONTEXT_PATH || path.startsWith(`${CONTEXT_PATH}/`)) {
      return serving.fetch(req);
    }
    return handleRootDjProxy(req, src, teamStore);
  };
}

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

/**
 * Path prefix of the DOMjudge baseUrl, normalized (no trailing slash, "" when
 * the base sits at the site root). DOMjudge deploys such as the official demo
 * live under /demoweb and emit that prefix in every absolute URL it writes.
 */
export function basePathOf(baseUrl: string): string {
  if (!baseUrl) return "";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "";
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return path === "" || path === "/" ? "" : path;
}

/**
 * Removes `prefix` from the start of a path, keeping the leading slash of the
 * remainder. Returns null when the path is not under the prefix, so callers can
 * leave foreign / unrelated values alone.
 */
function stripPrefixPath(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

/** Escapes a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites an upstream redirect target so the base-url prefix disappears:
 * `{origin}{prefix}/x` and `{prefix}/x` both become `/x`, query/hash kept.
 * Anything else (foreign origins, `mailto:`, unrelated paths) is untouched, as
 * is everything when the baseUrl has no prefix.
 */
export function rewriteLocation(location: string, baseUrl: string): string {
  const prefix = basePathOf(baseUrl);
  if (!prefix) return location;

  let absolute: URL | null = null;
  try {
    absolute = new URL(location);
  } catch {
    absolute = null;
  }
  if (absolute) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      return location;
    }
    // Only our own DOMjudge origin may be folded into a root path.
    if (absolute.origin !== base.origin) return location;
    const rest = stripPrefixPath(absolute.pathname, prefix);
    if (rest === null) return location;
    return `${rest}${absolute.search}${absolute.hash}`;
  }

  // Root-relative form: /demoweb/public?x=1#top
  const split = location.search(/[?#]/);
  const path = split === -1 ? location : location.slice(0, split);
  const tail = split === -1 ? "" : location.slice(split);
  const rest = stripPrefixPath(path, prefix);
  return rest === null ? location : `${rest}${tail}`;
}

/** Content types whose bodies are plain text we may safely rewrite. */
const REWRITABLE_TYPES = new Set([
  "text/html",
  "text/css",
  "application/javascript",
  "text/javascript",
]);

/** Characters that may precede a path reference in HTML/CSS/JS. */
const REFERENCE_BOUNDARY = `(^|[\\s"'\`()=,;:])`;

/**
 * Strips the base-url prefix out of a text asset. DOMjudge emits it as a
 * root-relative reference (`"/demoweb/js/x.js`, `url(/demoweb/img/a.png)`) or
 * as an absolute URL on its own origin; both are rewritten to root paths so the
 * browser asks us for `/js/x.js`, which the root proxy maps back to
 * `{baseUrl}/js/x.js`.
 */
function rewriteTextPaths(text: string, prefix: string, origin: string | null): string {
  const prefixed = escapeRegExp(prefix);
  let out = text;
  if (origin) {
    const escapedOrigin = escapeRegExp(origin);
    // https://host/demoweb/x -> /x
    out = out.split(`${origin}${prefix}/`).join("/");
    // https://host/demoweb (bare base root) -> /
    out = out.replace(new RegExp(`${escapedOrigin}${prefixed}(?=$|[\\s"'\`)>?,;:])`, "g"), "/");
  }
  // Relative references at a token boundary. Repeats are collapsed in a loop so
  // a stale /demoweb/demoweb/x can never survive as /demoweb/x.
  const reference = new RegExp(`${REFERENCE_BOUNDARY}${prefixed}(?=/|$|[\\s"'\`)>?,;:])`, "g");
  for (let i = 0; i < 10; i++) {
    const next = out.replace(reference, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Rewrites the body of text assets served by DOMjudge so their base-url prefix
 * is gone. A prefix-free baseUrl and every non-text response stream through
 * untouched, so binary payloads (PDFs, submissions, images) are never buffered.
 *
 * A response that still carries a content-encoding we cannot safely decode is
 * skipped with one WARN rather than risking a corrupted body: the page will
 * keep its upstream references and lose styling, but it stays valid.
 */
export async function rewriteUpstreamBody(
  res: Response,
  baseUrl: string,
  url?: string,
): Promise<Response> {
  const prefix = basePathOf(baseUrl);
  if (!prefix) return res;
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!REWRITABLE_TYPES.has(type)) return res;
  if (!res.body) return res; // 204/304 and HEAD replies have nothing to rewrite

  const encoding = res.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    log.warn(
      "proxy",
      `skip base-path rewrite: undecodable content-encoding "${encoding}"${url ? ` for ${url}` : ""}`,
    );
    return res;
  }

  let origin: string | null = null;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = null;
  }

  const text = await res.text();
  const rewritten = rewriteTextPaths(text, prefix, origin);
  const headers = new Headers(res.headers);
  // The body changed length; a stale content-length would truncate or hang it.
  headers.delete("content-length");
  headers.set("content-length", String(Buffer.byteLength(rewritten)));
  return new Response(rewritten, { status: res.status, statusText: res.statusText, headers });
}

/** Applies rewriteLocation to a redirect response, preserving its other headers. */
function rewriteRedirect(res: Response, baseUrl: string): Response {
  const location = res.headers.get("location");
  if (!location) return res;
  const next = rewriteLocation(location, baseUrl);
  if (next === location) return res;
  const headers = new Headers(res.headers);
  headers.set("location", next);
  const body = res.status === 204 || res.status === 304 ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Removes a leading base-url prefix from an incoming request path. Browsers
 * normally follow the rewritten root-relative links, but a cached page from
 * before the fix still asks for /demoweb/js/x.js; folding that away keeps the
 * forwarded target at exactly one prefix. Prefix-free baseUrls are untouched.
 */
export function stripRequestPrefix(path: string, baseUrl: string): string {
  const prefix = basePathOf(baseUrl);
  if (!prefix) return path;
  const rest = stripPrefixPath(path, prefix);
  return rest === null ? path : rest;
}

/** Shared upstream forwarding: headers, login injection, proxy call. */
async function forwardToDj(
  req: Request,
  cfg: Config,
  teamStore: TeamStore | undefined,
  payload: { sub: string },
  rawRest: string,
): Promise<Response> {
  const rest = stripRequestPrefix(rawRest, cfg.domjudge.baseUrl);
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
    const withCookies = await rewriteResponseCookies(res);
    if (withCookies.status >= 300 && withCookies.status < 400) {
      // A prefix-carrying Location (https://host/demoweb/public) would send the
      // browser to a path we cannot serve; fold it back to a root path.
      return rewriteRedirect(withCookies, cfg.domjudge.baseUrl);
    }
    // Only successful text replies are buffered; binaries keep streaming.
    if (withCookies.status >= 200 && withCookies.status < 300) {
      return await rewriteUpstreamBody(withCookies, cfg.domjudge.baseUrl, target);
    }
    return withCookies;
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

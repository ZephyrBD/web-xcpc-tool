import { compare } from "bcryptjs";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Config } from "../config";
import { signAdminToken, verifyAdminToken } from "../auth/token";
import type { Deps } from "../server";

export { verifyAdminToken };

export const ADMIN_COOKIE = "cxtool-admin";

/** Fixed messages so responses never reveal whether the username exists. */
const LOGIN_FAILED = "用户名或密码不对，再试一次？";
const LOGIN_UNAVAILABLE = "登录暂不可用，请联系管理员初始化账号";
const RATE_LIMITED = "尝试太频繁了，请稍等几分钟再试";
const UNAUTHORIZED = "未登录或登录已过期";

/**
 * Per-IP failed-login limiter, in memory (lost on restart — acceptable for a
 * single-process contest tool). Sliding window: an IP is blocked once it has
 * 5+ failures in the trailing 60 seconds; entries are pruned after 10 minutes.
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_FAILURES = 5;
  private static readonly PRUNE_AFTER_MS = 10 * 60_000;

  recordFailure(ip: string, now = Date.now()): void {
    const list = (this.failures.get(ip) ?? []).filter(
      (t) => now - t < LoginRateLimiter.PRUNE_AFTER_MS,
    );
    list.push(now);
    this.failures.set(ip, list);
  }

  isBlocked(ip: string, now = Date.now()): boolean {
    const list = this.failures.get(ip);
    if (!list) return false;
    const recent = list.filter((t) => now - t < LoginRateLimiter.WINDOW_MS);
    if (recent.length === 0) {
      this.failures.delete(ip);
      return false;
    }
    return recent.length >= LoginRateLimiter.MAX_FAILURES;
  }
}

export function clientIpOf(c: Context, deps?: Partial<Deps>): string {
  return (
    deps?.server?.requestIP(c.req.raw)?.address ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * `cfg` is a getter rather than a snapshot so username/password/jwt.secret and
 * contextPath edits apply immediately (runtime config store).
 */
export function createAdminLoginHandler(
  cfg: () => Config,
  deps?: Partial<Deps>,
  limiter: LoginRateLimiter = new LoginRateLimiter(),
): MiddlewareHandler {
  return async (c) => {
    const ip = clientIpOf(c, deps);
    if (limiter.isBlocked(ip)) {
      return c.json({ error: RATE_LIMITED }, 429);
    }
    const body = await c.req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const fail = () => {
      limiter.recordFailure(ip);
      return c.json({ error: LOGIN_FAILED }, 401);
    };
    if (!cfg().admin.passwordHash) {
      limiter.recordFailure(ip);
      return c.json({ error: LOGIN_UNAVAILABLE }, 401);
    }
    const current = cfg();
    if (username !== current.admin.username) return fail();
    if (!(await compare(password, current.admin.passwordHash))) return fail();
    const token = await signAdminToken(current.jwt.secret, current.admin.sessionTtlSeconds, username);
    // Cookie path follows the live contextPath (read after the await so a
    // concurrent settings PUT is already visible).
    const cookiePath = `${cfg().contextPath.replace(/\/+$/, "")}/`;
    c.header("Set-Cookie", `${ADMIN_COOKIE}=${token}; Path=${cookiePath}; HttpOnly; SameSite=Strict`);
    return c.json({ token });
  };
}

/**
 * CSRF guard for destructive routes whose auth may come from the admin cookie.
 * The cookie is SameSite=Strict, but a same-site sibling (or a browser that
 * drops the attribute) can still fire a cross-origin form/fetch, so the
 * browser-supplied Origin (or Referer when Origin is absent) must name this
 * very scheme+host: any cross-origin page would otherwise purge a contest's
 * data.
 *
 * The expected scheme is x-forwarded-proto when a reverse proxy set it, else
 * the request URL's own protocol (Bun reports the real one).
 * A request with neither header (curl, server-side callers) is not a browser
 * cross-site request and is allowed — those callers already hold the token.
 * Returns false when the request must be rejected.
 */
export function isSameOriginRequest(req: Request): boolean {
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!source) return true;
  // Behind a reverse proxy the Host header may be rewritten (nginx
  // proxy_set_header Host would fix that); fall back to the forwarded host so
  // a proxied admin page is not locked out.
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")].filter(
    (h): h is string => !!h,
  );
  const proto = (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    new URL(req.url).protocol.replace(/:$/, "")).toLowerCase();
  try {
    const url = new URL(source);
    // `hosts` is empty in a bare unit call without a Host header: fail open
    // (no host to compare against), never a silent 403 for every request.
    if (hosts.length === 0) return true;
    return hosts.includes(url.host) && url.protocol.replace(/:$/, "").toLowerCase() === proto;
  } catch {
    // "null" (sandboxed iframe, data: URL) or a malformed value: never
    // treat it as same-origin.
    return false;
  }
}

/** Auth for every /admin/api/* route except POST /admin/api/login. */export function requireAdmin(cfg: () => Config): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "POST" && c.req.path === "/admin/api/login") {
      return next();
    }
    let token = "";
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) token = auth.slice(7);
    if (!token) token = getCookie(c, ADMIN_COOKIE) ?? "";
    // EventSource cannot set headers, so SSE also accepts ?token=.
    if (!token && c.req.method === "GET" && c.req.path === "/admin/api/events") {
      token = c.req.query("token") ?? "";
    }
    const payload = token ? await verifyAdminToken(cfg().jwt.secret, token) : null;
    if (!payload) return c.json({ error: UNAUTHORIZED }, 401);
    await next();
  };
}

/** Test helper: mint Authorization headers for an admin principal. */
export async function adminAuthHeaders(cfg: Config): Promise<Record<string, string>> {
  const token = await signAdminToken(cfg.jwt.secret, cfg.admin.sessionTtlSeconds, cfg.admin.username || "admin");
  return { authorization: `Bearer ${token}` };
}

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { setDataDir } from "./store/store";
import { migrateLegacyDataDir } from "./store/dataRoot";
import { ensureAdminPassword, ensureJwtSecret, loadConfig, writeDefaultConfig } from "./config";
import { createApp } from "./server";
import { SseBus } from "./sse/bus";
import { PrintQueue } from "./print/queue";
import { BalloonService, type BalloonTask } from "./balloon/service";
import { DjClient, type DjTeam } from "./domjudge/client";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { JsonStore } from "./store/store";
import { TeamStore } from "./store/teams";
import { legacyContextPathRedirect, makeRootDispatch } from "./domjudge/proxy";
import { getVersionInfo } from "./version";
import { ConfigStore } from "./store/configStore";
import { initLogger, log, registerSecret } from "./log/logger";

/**
 * Single data root, relative to the process cwd (so `bun run dev` in
 * apps/server and a root-level launch each get their own checkout-local dir).
 * Every path below is anchored to it — via `setDataDir` or an explicit
 * `storePath(...)` — so there is exactly one `data/`, never `data/data/`.
 */
const DATA_ROOT = "data";
const STORE_DIR = resolve(DATA_ROOT);
const storePath = (name: string): string => join(STORE_DIR, name);

mkdirSync(DATA_ROOT, { recursive: true });
// One log file per run: truncated here, appended to by every module via `log`.
initLogger({ logFilePath: storePath(join("logs", "latest.log")) });
// Older builds could leave stores one level deeper; lift them once, before any
// store reads (the admin password now lives only in settings.json).
const migrated = migrateLegacyDataDir(DATA_ROOT);
if (migrated.length > 0) {
  log.info(
    "data",
    `moved legacy ${join(DATA_ROOT, "data")} entries up into ${STORE_DIR} (${migrated.join(", ")})`,
  );
}
const CONFIG_PATH = storePath("settings.json");
if (!existsSync(CONFIG_PATH)) {
  writeDefaultConfig(CONFIG_PATH);
}
const cfg = loadConfig(CONFIG_PATH);
cfg.jwt.secret = ensureJwtSecret(cfg, CONFIG_PATH);
// First launch: generate a readable admin password (hash + plaintext persisted);
// a configured hash is never replaced.
const adminCfg = ensureAdminPassword(cfg, CONFIG_PATH);
cfg.admin = adminCfg.admin;
// The generated plaintext is printed by the banner and masked in the log file.
registerSecret(cfg.admin.password);

// Runtime config store: every request reads `configStore.current`, and the
// admin settings PUT calls replace() so edits apply without a restart.
// Long-lived services (e.g. balloon polling) hook replace() through onChange.
const configStore = new ConfigStore(cfg);

// Absolute, so resolvePath returns store paths untouched (no second join).
setDataDir(STORE_DIR);

const bus = new SseBus();
const printQueue = new PrintQueue(storePath("print-tasks.json"));
// A getter keeps DOMjudge URL/credentials/timeout in step with the store.
const djClient = new DjClient(() => configStore.current.domjudge);
const teamsStore = new JsonStore<DjTeam[]>(storePath("teams.json"), []);
const teamStore = new TeamStore(
  storePath("team-passwords.json"),
  new SecretBox(ensureKeyFile(storePath("secret.key"))),
);
// Shared with BalloonService and the purge endpoint so all three see one file.
const balloonTasksStore = new JsonStore<BalloonTask[]>(storePath("balloon-tasks.json"), []);
const balloonService = new BalloonService({
  client: djClient,
  store: balloonTasksStore,
  bus,
  contestId: cfg.balloon.contestId,
  pollIntervalSeconds: cfg.balloon.pollIntervalSeconds,
  teams: [],
});

// Settings hot reload for the balloon poller: contestId/pollIntervalSeconds are
// the only balloon inputs that can change without a restart (pollOnce is
// untouched). A change stops and restarts the loop; an empty contestId leaves
// it stopped, exactly like start() at boot.
configStore.onChange((next) => {
  balloonService.reconfigure({
    contestId: next.balloon.contestId,
    pollIntervalSeconds: next.balloon.pollIntervalSeconds,
  });
});

let server: Bun.Server<never> | null = null;
const app = createApp(configStore, {
  dataDir: STORE_DIR,
  bus,
  printQueue,
  djClient,
  teamsStore,
  teamStore,
  balloonService,
  balloonTasks: balloonTasksStore,
  server: { requestIP: (req) => server?.requestIP(req) ?? null },
});
// Mounting and the port are fixed at boot: Hono routes and Bun.serve cannot be
// re-pointed at runtime, so a contextPath/port edit needs a restart (the admin
// settings page warns about this). Everything else hot-reloads.
const serving = cfg.contextPath ? new Hono().route(cfg.contextPath, app) : app;

// Everything outside the admin contextPath is reverse-proxied straight to
// DOMjudge with the same team-token semantics as /dj/*; the admin UI keeps
// its own prefix untouched.
const fetch_ = makeRootDispatch(serving, () => configStore.current, teamStore);
const fetchWithLegacyRedirect = (req: Request) =>
  legacyContextPathRedirect(cfg.contextPath, req) ?? fetch_(req);

// Cached old admin SPAs still request /cxtool/*, which now falls into the
// DOMjudge root proxy and 404s. 301 them onto the current contextPath.
const LEGACY_PREFIX = "/cxtool";
const redirectToContextPath = (req: Request): Response | null => {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== LEGACY_PREFIX && !url.pathname.startsWith(`${LEGACY_PREFIX}/`)) {
    return null;
  }
  const rest = url.pathname.slice(LEGACY_PREFIX.length);
  const target = `${configStore.current.contextPath.replace(/\/+$/, "")}${rest}` || "/";
  return Response.redirect(new URL(`${target}${url.search}`, url).toString(), 301);
};

server = Bun.serve({
  fetch: fetchWithLegacyRedirect,
  port: cfg.port,
});
balloonService.start();

/**
 * Startup banner: everything needed to reach the tool and log in, so a fresh
 * install never needs to hand-edit settings.json. Re-printed on every start;
 * the plaintext password comes from settings.json (admin.password) and is
 * masked in data/logs/latest.log (registered as a secret above).
 */
const printBanner = (): void => {
  // getVersionInfo().hash is the full version string (build tag, env, or git hash).
  const version = getVersionInfo().hash;
  const base = `http://localhost:${cfg.port}${cfg.contextPath.replace(/\/+$/, "")}`;
  log.info(
    "startup",
    [
      `Web XCPC Tool ${version}`,
      // CJK labels are two terminal columns wide, so they pad with one space less.
      `服务    ${base || "/"}`,
      `管理台  ${base}/admin   用户名: ${cfg.admin.username}`,
      cfg.admin.password
        ? `密码    ${cfg.admin.password}`
        : `密码    未保存明文（旧版配置），请在管理台「设置」页重设密码`,
      `DOMjudge ${cfg.domjudge.baseUrl || "未配置"}`,
      `气球    ${cfg.balloon.contestId || "未启用（未配置赛题 ID）"}`,
    ].join("\n"),
  );
};
printBanner();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    balloonService.stop();
    log.info("startup", `收到 ${signal}，正在退出`);
    process.exit(0);
  });
}

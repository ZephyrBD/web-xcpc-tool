import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { setDataDir } from "./store/store";
import { ensureJwtSecret, loadConfig, writeDefaultConfig } from "./config";
import { createApp } from "./server";
import { SseBus } from "./sse/bus";
import { PrintQueue } from "./print/queue";
import { BalloonService } from "./balloon/service";
import { DjClient, type DjTeam } from "./domjudge/client";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { JsonStore } from "./store/store";
import { TeamStore } from "./store/teams";
import { legacyContextPathRedirect, makeRootDispatch } from "./domjudge/proxy";

const CONFIG_PATH = "data/settings.json";
const DATA_DIR = "data";

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIG_PATH)) {
  writeDefaultConfig(CONFIG_PATH);
}
const cfg = loadConfig(CONFIG_PATH);
cfg.jwt.secret = ensureJwtSecret(cfg, CONFIG_PATH);

setDataDir(DATA_DIR);

const bus = new SseBus();
const printQueue = new PrintQueue(join(DATA_DIR, "print-tasks.json"));
const djClient = new DjClient(cfg.domjudge, undefined, cfg.domjudge.timeoutSeconds * 1000);
const teamsStore = new JsonStore<DjTeam[]>(join(DATA_DIR, "teams.json"), []);
const teamStore = new TeamStore(
  join(DATA_DIR, "team-passwords.json"),
  new SecretBox(ensureKeyFile(join(DATA_DIR, "secret.key"))),
);
const balloonService = new BalloonService({
  client: djClient,
  store: new JsonStore(join(DATA_DIR, "balloon-tasks.json"), []),
  bus,
  contestId: cfg.balloon.contestId,
  pollIntervalSeconds: cfg.balloon.pollIntervalSeconds,
  teams: [],
  problems: [],
});

let server: Bun.Server<never> | null = null;
const app = createApp(cfg, {
  bus,
  printQueue,
  djClient,
  teamsStore,
  teamStore,
  balloonService,
  server: { requestIP: (req) => server?.requestIP(req) ?? null },
});
const serving = cfg.contextPath ? new Hono().route(cfg.contextPath, app) : app;

// Everything outside the admin contextPath is reverse-proxied straight to
// DOMjudge with the same team-token semantics as /dj/*; the admin UI keeps
// its own prefix untouched.
const fetch_ = makeRootDispatch(serving, cfg, teamStore);
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
  const target = `${cfg.contextPath.replace(/\/+$/, "")}${rest}` || "/";
  return Response.redirect(new URL(`${target}${url.search}`, url).toString(), 301);
};

server = Bun.serve({
  fetch: fetchWithLegacyRedirect,
  port: cfg.port,
});
balloonService.start();
console.log(`cuitxcpctool server listening on :${cfg.port}${cfg.contextPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    balloonService.stop();
    process.exit(0);
  });
}

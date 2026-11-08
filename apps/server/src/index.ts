import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { setDataDir } from "./store/store";
import { ensureJwtSecret, loadConfig, writeDefaultConfig } from "./config";
import { createApp } from "./server";
import { AuthQueue } from "./queue/authQueue";
import { SseBus } from "./sse/bus";
import { PrintQueue } from "./print/queue";
import { BalloonService } from "./balloon/service";
import { DjClient, type DjTeam } from "./domjudge/client";
import { SecretBox, ensureKeyFile } from "./store/secretbox";
import { JsonStore } from "./store/store";
import { TeamStore } from "./store/teams";

const CONFIG_PATH = "data/settings.json";
const DATA_DIR = "data";

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIG_PATH)) {
  writeDefaultConfig(CONFIG_PATH);
}
const cfg = loadConfig(CONFIG_PATH);
cfg.jwt.secret = ensureJwtSecret(cfg, CONFIG_PATH);

setDataDir(DATA_DIR);

const authQueue = new AuthQueue(join(DATA_DIR, "auth-tasks.json"));
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
  authQueue,
  bus,
  printQueue,
  djClient,
  teamsStore,
  teamStore,
  balloonService,
  server: { requestIP: (req) => server?.requestIP(req) ?? null },
});
const serving = cfg.contextPath ? new Hono().route(cfg.contextPath, app) : app;

server = Bun.serve({
  fetch: serving.fetch,
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

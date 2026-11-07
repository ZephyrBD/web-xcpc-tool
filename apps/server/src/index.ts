import { existsSync, mkdirSync } from "node:fs";
import { setDataDir } from "./store/store";
import { ensureJwtSecret, loadConfig, writeDefaultConfig } from "./config";
import { createApp } from "./server";

const CONFIG_PATH = "data/settings.json";
const DATA_DIR = "data";

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIG_PATH)) {
  writeDefaultConfig(CONFIG_PATH);
}
const cfg = loadConfig(CONFIG_PATH);
cfg.jwt.secret = ensureJwtSecret(cfg, CONFIG_PATH);

setDataDir(DATA_DIR);
let server: Bun.Server<never> | null = null;
const app = createApp(cfg, { server: { requestIP: (req) => server?.requestIP(req) ?? null } });
const serving = cfg.contextPath ? app.basePath(cfg.contextPath) : app;

server = Bun.serve({
  fetch: serving.fetch,
  port: cfg.port,
});
console.log(`cuitxcpctool server listening on :${cfg.port}${cfg.contextPath}`);

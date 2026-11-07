import { existsSync, mkdirSync } from "node:fs";
import { setDataDir } from "./store/store";
import { loadConfig, writeDefaultConfig } from "./config";
import { createApp } from "./server";

const CONFIG_PATH = "data/settings.json";
const DATA_DIR = "data";

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIG_PATH)) {
  writeDefaultConfig(CONFIG_PATH);
}
const cfg = loadConfig(CONFIG_PATH);

if (!cfg.jwt.secret) {
  console.error("FATAL: jwt.secret is empty — set it in data/settings.json before starting the server.");
  process.exit(1);
}

setDataDir(DATA_DIR);
const app = createApp(cfg);
const serving = cfg.contextPath ? app.basePath(cfg.contextPath) : app;

Bun.serve({
  fetch: serving.fetch,
  port: cfg.port,
});
console.log(`cuitxcpctool server listening on :${cfg.port}${cfg.contextPath}`);

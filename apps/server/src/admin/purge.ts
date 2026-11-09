import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config } from "../config";
import type { JsonStore } from "../store/store";
import { settingsPathFor } from "./settings";

/** Rows removed per store plus the archived print files deleted under printed/ and pdf/. */
export type PurgeReport = {
  teams: number;
  /** Team rows holding a DOMjudge password. */
  passwords: number;
  /** Team rows holding a login code (its own field so the UI can show both). */
  teamCodes: number;
  printTasks: number;
  balloonTasks: number;
  loginHistory: number;
  loginRequests: number;
  /** Files deleted recursively under printed/ + pdf/. */
  filesRemoved: number;
};

/**
 * The pulled-data stores, as their concrete types. Team credentials and codes
 * share one keyed map (team-passwords.json), so the password/code counts come
 * from a single scan of it.
 */
export type PurgeDeps = {
  dataDir: string;
  teams: JsonStore<unknown[]>;
  printTasks: JsonStore<unknown[]>;
  balloonTasks: JsonStore<unknown[]>;
  loginHistory: JsonStore<unknown[]>;
  loginRequests: JsonStore<unknown[]>;
  /** team-passwords.json: { icpcId: { password?, teamCode?, djUsername? } | "<encrypted>" }. */
  teamCredentials: JsonStore<Record<string, unknown>>;
  /**
   * Called after settings.json has been rewritten with an empty
   * balloon.contestId — the HTTP handler hands the result to
   * ConfigStore.replace so every request sees the reset and the poller stops.
   * Omitted by callers that only care about the files.
   */
  contestIdReset?: (next: Config) => void;
};

/** Directories holding generated/archived print artifacts. */
const ARCHIVE_DIRS = ["printed", "pdf"] as const;

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

/** Removes `<dataDir>/printed` and `<dataDir>/pdf` recursively; returns the files deleted. */
function purgeArchiveDirs(dataDir: string): number {
  let removed = 0;
  for (const name of ARCHIVE_DIRS) {
    const dir = join(dataDir, name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    removed += countFiles(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  return removed;
}

function countCredentials(entries: Record<string, unknown>): { passwords: number; teamCodes: number } {
  let passwords = 0;
  let teamCodes = 0;
  for (const entry of Object.values(entries)) {
    // Legacy files stored the encrypted password as a bare string value.
    if (typeof entry === "string") {
      if (entry) passwords += 1;
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { password?: unknown; teamCode?: unknown };
    if (e.password) passwords += 1;
    if (e.teamCode) teamCodes += 1;
  }
  return { passwords, teamCodes };
}

/**
 * Clears balloon.contestId in settings.json with the same tmp+rename write as
 * applySettingsPatch, preserving every other setting (domjudge credentials,
 * admin hash, jwt secret, print token, poll interval) and secret.key.
 *
 * The on-disk file is the base — the live config may differ if it was
 * hand-edited. Returns the resulting config for the live store.
 */
function resetContestId(settingsPath: string): Config {
  let base: Config | undefined;
  if (existsSync(settingsPath)) {
    try {
      base = parseConfig(JSON.parse(readFileSync(settingsPath, "utf8")));
    } catch {
      // Fall through: a corrupt file must not abort the purge.
    }
  }
  // The file normally exists (index.ts writes it at boot); the all-defaults
  // parse is only a last resort so the reset still lands on disk.
  base ??= parseConfig({});
  const updated = parseConfig({ ...base, balloon: { ...base.balloon, contestId: "" } });
  const tmpPath = `${settingsPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  renameSync(tmpPath, settingsPath);
  return updated;
}

/**
 * Wipes everything pulled from DOMjudge (teams, credentials/codes, print and
 * balloon tasks, login history and approval requests, archived print files)
 * and clears the contest id so a different contest can be configured.
 *
 * settings.json and secret.key survive, so the same install keeps working and
 * only the contest-scoped data has to be re-pulled.
 */
export function purgePulledData(deps: PurgeDeps): PurgeReport {
  const credentials = deps.teamCredentials.load();
  const { passwords, teamCodes } = countCredentials(credentials);

  const report: PurgeReport = {
    teams: deps.teams.load().length,
    passwords,
    teamCodes,
    printTasks: deps.printTasks.load().length,
    balloonTasks: deps.balloonTasks.load().length,
    loginHistory: deps.loginHistory.load().length,
    loginRequests: deps.loginRequests.load().length,
    filesRemoved: purgeArchiveDirs(deps.dataDir),
  };

  // JsonStore writes unconditionally; an empty save over a missing file would
  // invent one, so only touch stores that actually held data.
  deps.teams.save([]);
  deps.teamCredentials.save({});
  deps.printTasks.save([]);
  deps.balloonTasks.save([]);
  deps.loginHistory.save([]);
  deps.loginRequests.save([]);

  const settingsPath = settingsPathFor(deps.dataDir);
  const updated = resetContestId(settingsPath);
  deps.contestIdReset?.(updated);

  return report;
}

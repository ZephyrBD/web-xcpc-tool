import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config } from "../config";
import type { JsonStore } from "../store/store";
import { backfillLiveSecrets, readConfigBase, settingsPathFor } from "./settings";

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
  /**
   * The running config; its admin hash and JWT secret are what the settings
   * rewrite backfills when the file on disk is partial (see backfillLiveSecrets).
   */
  liveCfg: Config;
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
 * Clears balloon.contestId in settings.json with the same base/guard/write
 * sequence as applySettingsPatch: the file normally wins, a missing or
 * unparseable one falls back to the live config, and admin hash / jwt secret
 * are backfilled from the live config so the purge can never lock the operator
 * out. Every other setting (domjudge credentials, poll interval, print token)
 * and secret.key survive untouched.
 */
function resetContestId(settingsPath: string, liveCfg: Config): Config {
  const base = readConfigBase(settingsPath, liveCfg);
  const current = base as unknown as Config;
  base.balloon = { ...current.balloon, contestId: "" };
  backfillLiveSecrets(base, liveCfg);
  const updated = parseConfig(base);
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

  // JsonStore has no "absent" state: save([]) writes a file even when none
  // existed, so a purge on a fresh install leaves empty JSON stores behind.
  // Harmless (every reader defaults to []), and keeps the live instances in
  // step with disk.
  deps.teams.save([]);
  deps.teamCredentials.save({});
  deps.printTasks.save([]);
  deps.balloonTasks.save([]);
  deps.loginHistory.save([]);
  deps.loginRequests.save([]);

  const settingsPath = settingsPathFor(deps.dataDir);
  const updated = resetContestId(settingsPath, deps.liveCfg);
  deps.contestIdReset?.(updated);

  return report;
}

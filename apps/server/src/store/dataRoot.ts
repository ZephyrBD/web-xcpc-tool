import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Files that may have been written one level too deep (see
 * `migrateLegacyDataDir`). `pdf/` and `printed/` hold absolute paths inside the
 * store records, so only these files are relocated.
 */
const STORE_FILES = [
  "settings.json",
  "teams.json",
  "team-passwords.json",
  "balloon-tasks.json",
  "print-tasks.json",
  "login-history.json",
  "login-requests.json",
  "secret.key",
];

/**
 * One-time lift of `<dataRoot>/data/*` up into `<dataRoot>/*`.
 *
 * Older builds resolved store files against the data dir but created their
 * own files against the cwd, so a repo-root launch wrote settings.json to
 * `./data/` and every JSON store to `./data/data/`. Now that the admin
 * password lives only in settings.json, those two must never be split.
 *
 * Moves (never copies over) only when the destination is free; a file that
 * already exists at the top level wins and the legacy copy is left alone.
 * Nothing is deleted. Returns the names that were moved.
 */
export function migrateLegacyDataDir(dataRoot: string): string[] {
  const root = resolve(dataRoot);
  const legacy = resolve(root, "data");
  if (!existsSync(legacy)) return [];
  mkdirSync(root, { recursive: true });
  const moved: string[] = [];
  for (const name of STORE_FILES) {
    const from = resolve(legacy, name);
    const to = resolve(root, name);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
      moved.push(name);
    } catch {
      // A lock or a permission problem must never abort startup or lose data;
      // the file simply stays where it was.
    }
  }
  return moved;
}

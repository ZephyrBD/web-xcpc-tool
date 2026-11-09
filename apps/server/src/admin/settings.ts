import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashSync } from "bcryptjs";
import { parseConfig, CONTEXT_PATH, type Config } from "../config";
import { isoOrEmpty } from "../config";
import { getVersionInfo } from "../version";

/**
 * Subset of settings.json editable from the admin UI. Secret fields are
 * write-only: an empty string means "leave unchanged" so the operator can
 * update e.g. baseUrl without retyping the DOMjudge password.
 */
export const settingsPatchSchema = z.object({
  domjudge: z
    .object({
      baseUrl: z.string().optional(),
      adminUser: z.string().optional(),
      adminPassword: z.string().optional(),
    })
    .optional(),
  balloon: z
    .object({
      /**
       * Trimmed server-side: the field is write-once, so a stray `"  C1  "`
       * would be stored verbatim and then locked (a later `"C1"` is a
       * different value and gets 403 forever). Trimming here also keeps the
       * lock comparison below meaningful.
       */
      contestId: z.string().trim().optional(),
      pollIntervalSeconds: z.number().int().positive().optional(),
    })
    .optional(),
  print: z.object({ token: z.string().optional() }).optional(),
  teamLogin: z
    .object({ start: isoOrEmpty.optional(), end: isoOrEmpty.optional() })
    .optional(),
  admin: z.object({ username: z.string().optional(), password: z.string().optional() }).optional(),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** First 4 chars + *** when set; empty string when unset. Never the full token. */
export function maskToken(token: string): string {
  return token ? `${token.slice(0, 4)}***` : "";
}

/** Config fields safe to expose to the admin UI. No password/token ever. */
export function safeSettingsView(cfg: Config) {
  return {
    port: cfg.port,
    /** Read-only: the mount is pinned to /wxt (the UI no longer edits it). */
    contextPath: CONTEXT_PATH,
    domjudge: {
      baseUrl: cfg.domjudge.baseUrl,
      adminUser: cfg.domjudge.adminUser,
      timeoutSeconds: cfg.domjudge.timeoutSeconds,
    },
    balloon: {
      contestId: cfg.balloon.contestId,
      pollIntervalSeconds: cfg.balloon.pollIntervalSeconds,
      locked: !!cfg.balloon.contestId,
    },
    print: { tokenMasked: maskToken(cfg.print.token) },
    teamLogin: { start: cfg.teamLogin.start, end: cfg.teamLogin.end },
    admin: { username: cfg.admin.username },
    version: getVersionInfo(),
  };
}

/**
 * The settings.json base every rewrite starts from: the file on disk when it
 * parses (another request may have written it since this process started),
 * otherwise a deep copy of the live config — a hand-edited or missing file
 * must never be silently replaced by schema defaults.
 */
export function readConfigBase(settingsPath: string, liveCfg: Config): Record<string, unknown> {
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(JSON.stringify(parseConfig(JSON.parse(readFileSync(settingsPath, "utf8"))))) as Record<string, unknown>;
    } catch {
      // Unparseable / schema-invalid: fall through to the live config.
    }
  }
  return JSON.parse(JSON.stringify(liveCfg)) as Record<string, unknown>;
}

/**
 * Partial settings.json guard, shared by every writer. index.ts bootstraps the
 * admin hash and the JWT secret in memory (and usually in the file), but a file
 * written without them parses to empty values — which locks the operator out
 * (every login compares against "") and makes signing fail with "Zero-length
 * key". Backfill ONLY what is empty, from the live config:
 *
 * - `admin`: the hash plus its banner plaintext; other admin fields (a rename,
 *   sessionTtlSeconds) are left as written.
 * - `jwt`: the secret; the TTL stays as written.
 *
 * Mutates and returns `base` for call chaining.
 */
export function backfillLiveSecrets(base: Record<string, unknown>, liveCfg: Config): Record<string, unknown> {
  const current = base as unknown as Config;
  if (!current.admin?.passwordHash && liveCfg.admin.passwordHash) {
    base.admin = {
      ...current.admin,
      passwordHash: liveCfg.admin.passwordHash,
      password: liveCfg.admin.password ?? current.admin?.password,
    };
  }
  if (liveCfg.jwt.secret && !current.jwt?.secret) {
    base.jwt = { ...current.jwt, secret: liveCfg.jwt.secret };
  }
  return base;
}

/**
 * Merges the patch into settings.json (only provided fields; empty-string
 * secrets are skipped) and returns the resulting parsed Config. Callers that
 * hot-reload must hand the result to `ConfigStore.replace` — writing the file
 * alone changes nothing until the next restart (that is what the admin PUT
 * does, and why the settings page no longer asks for one).
 *
 * `liveAdmin` (the currently running config) guards a partial settings.json:
 * when the merged result has no admin hash but the process has one — e.g. the
 * file was generated without an admin block and the hash was bootstrapped at
 * startup — the live block wins, so an unrelated PUT can never lock the
 * operator out. It defaults to `cfg.admin` (see backfillLiveSecrets).
 */
export function applySettingsPatch(
  cfg: Config,
  patch: SettingsPatch,
  settingsPath: string,
  liveAdmin?: Config["admin"],
): Config {
  const base = readConfigBase(settingsPath, cfg);
  const current = base as unknown as Config;
  if (patch.domjudge) {
    const { adminPassword, ...rest } = patch.domjudge;
    base.domjudge = { ...current.domjudge, ...rest, ...(adminPassword ? { adminPassword } : {}) };
  }
  if (patch.balloon) {
    // Trimmed again here so a caller that bypassed the schema (tests, a future
    // non-HTTP writer) cannot store a padded id that the write-once lock then
    // makes impossible to correct.
    const balloon = { ...patch.balloon };
    if (balloon.contestId !== undefined) balloon.contestId = balloon.contestId.trim();
    base.balloon = { ...current.balloon, ...balloon };
  }
  if (patch.print) {
    base.print = { ...current.print, ...(patch.print.token ? { token: patch.print.token } : {}) };
  }
  if (patch.teamLogin) base.teamLogin = { ...current.teamLogin, ...patch.teamLogin };
  if (patch.admin) {
    const { password, ...rest } = patch.admin;
    // Only "password" comes from the UI; it is hashed here and the plaintext
    // is kept alongside it purely so the startup banner can print it (the GET
    // view strips both — see safeSettingsView). A direct "passwordHash" is
    // stripped by the schema and can never be injected.
    base.admin = {
      ...current.admin,
      ...rest,
      ...(password ? { passwordHash: hashSync(password, 10), password } : {}),
    };
  }

  // Partial settings.json guard: the file had no usable admin hash or JWT
  // secret, but this process bootstrapped them — never let the disk base blank
  // a live secret (see backfillLiveSecrets).
  backfillLiveSecrets(
    base,
    liveAdmin ? { ...cfg, admin: liveAdmin } : cfg,
  );

  const updated = parseConfig(base);
  const tmpPath = `${settingsPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  renameSync(tmpPath, settingsPath);
  return updated;
}

/** Default settings.json path for a data dir, matching index.ts's CONFIG_PATH. */
export function settingsPathFor(dataDir: string): string {
  return join(dataDir, "settings.json");
}

/**
 * The balloon contest id is written once and then locked: balloon tasks,
 * archived sources and the DJ sync are all keyed by it, so silently pointing
 * the poller at another contest would mix two contests' data. Re-submitting
 * the same id (the settings form always sends it) stays allowed, and an empty
 * string is allowed because the purge flow resets the id.
 */
export function assertContestIdMutable(
  current: Config,
  patch: SettingsPatch,
): { ok: true } | { ok: false; reason: "locked" } {
  const next = patch.balloon?.contestId;
  if (!current.balloon.contestId || next === undefined || !next) return { ok: true };
  return next === current.balloon.contestId ? { ok: true } : { ok: false, reason: "locked" };
}

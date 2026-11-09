import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashSync } from "bcryptjs";
import { parseConfig, type Config } from "../config";
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
      contestId: z.string().optional(),
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
    contextPath: cfg.contextPath,
    domjudge: {
      baseUrl: cfg.domjudge.baseUrl,
      adminUser: cfg.domjudge.adminUser,
      timeoutSeconds: cfg.domjudge.timeoutSeconds,
    },
    balloon: {
      contestId: cfg.balloon.contestId,
      pollIntervalSeconds: cfg.balloon.pollIntervalSeconds,
    },
    print: { tokenMasked: maskToken(cfg.print.token) },
    teamLogin: { start: cfg.teamLogin.start, end: cfg.teamLogin.end },
    admin: { username: cfg.admin.username },
    version: getVersionInfo(),
  };
}

/**
 * Merges the patch into settings.json (only provided fields; empty-string
 * secrets are skipped) and returns the resulting parsed Config. The running
 * process keeps its old Config — changes take effect after a restart.
 */
export function applySettingsPatch(cfg: Config, patch: SettingsPatch, settingsPath: string): Config {
  // Prefer the settings on disk (another PUT may have written them since this
  // process started); fall back to the running config if the file is missing
  // or hand-edited into a shape the schema rejects.
  let base: Record<string, unknown>;
  if (existsSync(settingsPath)) {
    try {
      base = JSON.parse(
        JSON.stringify(parseConfig(JSON.parse(readFileSync(settingsPath, "utf8")))),
      ) as Record<string, unknown>;
    } catch {
      base = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
    }
  } else {
    base = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  }
  const current = base as unknown as Config;
  if (patch.domjudge) {
    const { adminPassword, ...rest } = patch.domjudge;
    base.domjudge = { ...current.domjudge, ...rest, ...(adminPassword ? { adminPassword } : {}) };
  }
  if (patch.balloon) base.balloon = { ...current.balloon, ...patch.balloon };
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

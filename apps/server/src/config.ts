import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hashSync } from "bcryptjs";
import { z } from "zod";

/** Empty string means "no restriction"; otherwise an ISO datetime. */
export const isoOrEmpty = z
  .string()
  .refine((s) => s === "" || !Number.isNaN(Date.parse(s)), {
    message: "must be an ISO datetime string or empty",
  });

const teamLoginSchema = z
  .object({
    start: isoOrEmpty.default(""),
    end: isoOrEmpty.default(""),
  })
  .default({ start: "", end: "" })
  .refine((v) => !v.start || !v.end || v.start < v.end, {
    message: "teamLogin.start must be before teamLogin.end",
  });

const configSchema = z.object({
  port: z.number().int().default(8080),
  contextPath: z.string().default("/wxt"),
  domjudge: z
    .object({
      baseUrl: z.string().default(""),
      adminUser: z.string().default(""),
      adminPassword: z.string().default(""),
      timeoutSeconds: z.number().int().min(1).default(10),
    })
    .default({ baseUrl: "", adminUser: "", adminPassword: "", timeoutSeconds: 10 }),
  jwt: z
    .object({
      secret: z.string(),
      ttlSeconds: z.number().int().positive(),
    })
    .default({ secret: "", ttlSeconds: 3600 }),
  teamLogin: teamLoginSchema,
  print: z
    .object({ token: z.string().default("") })
    .default({ token: "" }),
  balloon: z
    .object({
      contestId: z.string().default(""),
      pollIntervalSeconds: z.number().int().positive().default(30),
    })
    .default({ contestId: "", pollIntervalSeconds: 30 }),
  admin: z
    .object({
      username: z.string(),
      passwordHash: z.string(),
      /**
       * Plaintext of passwordHash, kept only so the startup banner can print
       * it. Never exposed by the admin API (see safeSettingsView).
       */
      password: z.string().optional(),
      sessionTtlSeconds: z.number().int().positive().default(28800),
    })
    .default({ username: "admin", passwordHash: "", sessionTtlSeconds: 28800 }),
});

export type Config = z.infer<typeof configSchema>;

/** Validates an arbitrary raw object against the full config schema. */
export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw);
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    return configSchema.parse({});
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return configSchema.parse(raw);
}

export function writeDefaultConfig(path: string): void {
  writeFileSync(path, JSON.stringify(configSchema.parse({}), null, 2));
}

/** Generate and persist a JWT secret on first launch; returns the secret to use for this run. */
export function ensureJwtSecret(cfg: Config, configPath: string): string {
  if (cfg.jwt.secret) return cfg.jwt.secret;
  const secret = randomBytes(32).toString("hex");
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      raw = {};
    }
  }
  raw.jwt = { ...(typeof raw.jwt === "object" && raw.jwt !== null ? raw.jwt : {}), secret };
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
  return secret;
}

/**
 * Alphabet for generated admin passwords: no confusables (0 O o 1 l I i), so
 * the operator can retype it from the terminal banner without guessing.
 */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const GENERATED_PASSWORD_LENGTH = 16;

/** Uniformly-random pick per character (rejection sampling avoids modulo bias). */
function generateAdminPassword(length = GENERATED_PASSWORD_LENGTH): string {
  const alphabetSize = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % alphabetSize);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(32)) {
      if (byte >= limit) continue; // reject to keep the distribution flat
      out += PASSWORD_ALPHABET[byte % alphabetSize];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Bootstrap the admin account on first launch: when no hash is configured,
 * generate a readable password, store its bcrypt hash plus the plaintext (so
 * the startup banner can print it), and write both back to settings.json.
 *
 * Idempotent: a configured hash is never replaced. A legacy settings.json with
 * a hash but no plaintext keeps that hash — the returned config simply has no
 * `admin.password`, signalling the caller to tell the operator to reset it.
 */
export function ensureAdminPassword(cfg: Config, configPath: string): Config {
  if (cfg.admin.passwordHash) return cfg;
  const password = generateAdminPassword();
  const passwordHash = hashSync(password, 10);
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      raw = {};
    }
  }
  const admin = typeof raw.admin === "object" && raw.admin !== null ? raw.admin : {};
  raw.admin = { ...admin, passwordHash, password };
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
  return { ...cfg, admin: { ...cfg.admin, passwordHash, password } };
}

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  contextPath: z.string().default("/cxtool"),
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

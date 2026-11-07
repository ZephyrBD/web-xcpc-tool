import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const configSchema = z.object({
  port: z.number().int().default(8080),
  contextPath: z.string().default("/cxtool"),
  domjudge: z
    .object({
      baseUrl: z.string().default(""),
      adminUser: z.string().default(""),
      adminPassword: z.string().default(""),
    })
    .default({ baseUrl: "", adminUser: "", adminPassword: "" }),
  jwt: z
    .object({
      secret: z.string(),
      ttlSeconds: z.number().int().positive(),
    })
    .default({ secret: "", ttlSeconds: 3600 }),
  oms: z
    .object({
      strategies: z.array(z.string()).default([]),
      uaRegexes: z.array(z.string()).default([]),
      customHeader: z
        .object({ name: z.string(), value: z.string() })
        .optional(),
      capture: z.boolean().default(false),
    })
    .default({ strategies: [], uaRegexes: [], capture: false }),
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
    .object({ username: z.string(), passwordHash: z.string() })
    .default({ username: "admin", passwordHash: "" }),
});

export type Config = z.infer<typeof configSchema>;

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

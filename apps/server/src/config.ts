import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const configSchema = z.object({
  port: z.number().int().default(8080),
  contextPath: z.string().default("/cxtool"),
  domjudge: z
    .object({ baseUrl: z.string() })
    .default({ baseUrl: "" }),
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

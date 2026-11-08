import { dirname, join } from "node:path";

/**
 * Version info for the copyright footer. The git short hash is resolved ONCE
 * at first call and cached; production deploys may ship without a .git
 * directory, in which case (or on any spawn error) we fall back to "dev".
 */
export interface VersionInfo {
  hash: string;
  year: number;
}

/**
 * Baked in at build time via `bun build --compile --define WXT_BUILD_VERSION:"<tag>"`.
 * Unset under plain `bun run` / `bun test`, hence the typeof guard.
 */
declare const WXT_BUILD_VERSION: string | undefined;

let cached: VersionInfo | null = null;

function resolveVersion(): string {
  // Build-time define (release binaries) → build/runtime env → git hash → "dev".
  const baked = typeof WXT_BUILD_VERSION !== "undefined" ? WXT_BUILD_VERSION : undefined;
  if (baked) return baked;
  if (process.env.WXT_VERSION) return process.env.WXT_VERSION;
  return resolveGitHash();
}

function resolveGitHash(): string {
  // version.ts lives at apps/server/src → repo root is three levels up.
  const repoRoot = join(dirname(import.meta.dir), "..", "..");
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) {
      const hash = proc.stdout.toString().trim();
      if (hash) return hash;
    }
  } catch {
    // fall through to "dev"
  }
  return "dev";
}

export function getVersionInfo(): VersionInfo {
  if (!cached) {
    cached = { hash: resolveVersion(), year: new Date().getFullYear() };
  }
  return cached;
}

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

let cached: VersionInfo | null = null;

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
    cached = { hash: resolveGitHash(), year: new Date().getFullYear() };
  }
  return cached;
}

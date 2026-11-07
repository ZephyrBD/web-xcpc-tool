import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

let dataDir = "";

/** Set the base directory used to resolve relative store paths. */
// relative paths: dataDir if set, else CWD
export function setDataDir(dir: string): void {
  dataDir = dir;
}

function resolvePath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  return dataDir ? join(resolve(dataDir), filePath) : resolve(filePath);
}

export class JsonStore<T> {
  private readonly filePath: string;
  private readonly defaultValue: T;

  constructor(filePath: string, defaultValue: T) {
    this.filePath = resolvePath(filePath);
    this.defaultValue = defaultValue;
  }

  load(): T {
    if (existsSync(this.filePath)) {
      const raw = readFileSync(this.filePath, "utf8");
      try {
        return JSON.parse(raw) as T;
      } catch (e) {
        throw new Error(
          `Failed to parse store file ${this.filePath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const tmpPath = this.filePath + ".tmp";
    if (existsSync(tmpPath)) {
      const raw = readFileSync(tmpPath, "utf8");
      let value: T;
      try {
        value = JSON.parse(raw) as T;
      } catch (e) {
        // corrupt tmp is unrecoverable — surface the path like the main-file branch
        throw new Error(
          `Failed to parse store file ${tmpPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Recover: promote the tmp file to the main file.
      renameSync(tmpPath, this.filePath);
      return value;
    }
    return this.defaultValue;
  }

  save(value: T): void {
    this.ensureDir();
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(value), "utf8");
    renameSync(tmpPath, this.filePath);
  }

  update(fn: (cur: T) => T): T {
    const next = fn(this.load());
    this.save(next);
    return next;
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

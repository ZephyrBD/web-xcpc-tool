import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../log/logger";

/**
 * Legacy installs could leave store files one level too deep (`data/data/`).
 * Nothing is migrated: the operator moves or deletes the directory by hand.
 */
export function warnLegacyDataDir(dataRoot: string): void {
  const legacy = resolve(dataRoot, "data");
  if (!existsSync(legacy)) return;
  log.warn(
    "data",
    `发现旧版数据目录 ${legacy}（不再自动迁移）：` +
      `请手动将其中的文件移动到 ${resolve(dataRoot)}，或直接删除该目录`,
  );
}

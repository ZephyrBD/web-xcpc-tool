import type { Config } from "../config";
import { log } from "../log/logger";

/**
 * Mutable holder for the running configuration so admin settings edits apply
 * without a restart. Everything that reads config per request goes through
 * `current`; long-lived services subscribe with `onChange`.
 *
 * There is deliberately no persistence here: `applySettingsPatch` already
 * writes settings.json, and this store only mirrors the live values.
 */
export class ConfigStore {
  private value: Config;
  private listeners = new Set<(next: Config) => void>();

  constructor(initial: Config) {
    this.value = initial;
  }

  get current(): Config {
    return this.value;
  }

  /**
   * Swap in a new config and notify subscribers. A throwing listener is
   * logged (never swallowed silently) but cannot starve the others, since the
   * PUT already persisted the file — hot reload must not fail the response.
   */
  replace(next: Config): void {
    this.value = next;
    // Snapshot: a listener registering another one must not fire it in the
    // same round (avoids re-entrant surprises), matching Set iteration safety.
    for (const cb of [...this.listeners]) {
      try {
        cb(next);
      } catch (err) {
        log.error("config", "change listener failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  /** Subscribes to replacements; returns an unsubscribe function. */
  onChange(cb: (next: Config) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

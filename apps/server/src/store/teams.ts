import type { SecretBox } from "./secretbox";
import { JsonStore } from "./store";

export class TeamStore {
  private readonly store: JsonStore<Record<string, string>>;
  private readonly box: SecretBox;

  constructor(filePath: string, secretBox: SecretBox) {
    this.store = new JsonStore<Record<string, string>>(filePath, {});
    this.box = secretBox;
  }

  setPassword(icpcId: string, password: string): void {
    this.store.update((cur) => ({ ...cur, [icpcId]: this.box.encrypt(password) }));
  }

  getPassword(icpcId: string): string | null {
    const cur = this.store.load();
    const payload = cur[icpcId];
    if (payload === undefined) return null;
    return this.box.decrypt(payload);
  }

  list(): Array<{ icpcId: string }> {
    return Object.keys(this.store.load()).map((icpcId) => ({ icpcId }));
  }
}

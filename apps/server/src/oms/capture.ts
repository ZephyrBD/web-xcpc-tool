import { appendFileSync } from "node:fs";
import type { ClientFingerprint } from "./identify";

const REDACTED_HEADERS = new Set(["cookie", "authorization"]);

export class FingerprintCapture {
  #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  record(fp: ClientFingerprint): void {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(fp.headers)) {
      if (!REDACTED_HEADERS.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    appendFileSync(this.#filePath, `${JSON.stringify({ ...fp, headers })}\n`);
  }

  close(): void {
    // appendFileSync writes unbuffered; nothing to flush
  }
}

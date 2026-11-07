import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { FingerprintCapture } from "./capture";
import type { ClientFingerprint } from "./identify";

function fp(headers: Record<string, string>): ClientFingerprint {
  return { ip: "10.0.0.5", method: "POST", path: "/cxtool/api/print", headers };
}

let capture: FingerprintCapture | null = null;
let dir: string | null = null;

afterEach(() => {
  capture?.close();
  capture = null;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("FingerprintCapture", () => {
  test("record writes one JSONL line per call and strips sensitive headers", () => {
    dir = mkdtempSync(join(tmpdir(), "fp-capture-"));
    const file = join(dir, "fingerprints.jsonl");
    capture = new FingerprintCapture(file);
    capture.record(fp({ "User-Agent": "OMSClient/1.0", Cookie: "session=secret", authorization: "Bearer tok" }));
    capture.record(fp({ "User-Agent": "QtWebEngine/6.5.3" }));
    capture.record(fp({ "User-Agent": "Chrome/120.0.0.0" }));

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({
      ip: "10.0.0.5",
      method: "POST",
      path: "/cxtool/api/print",
      headers: { "User-Agent": "OMSClient/1.0" },
    });
    expect(Object.keys(JSON.parse(lines[1]).headers)).not.toContain("cookie");
    expect(Object.keys(JSON.parse(lines[1]).headers)).not.toContain("authorization");
  });

  test("close is a no-op when nothing recorded", () => {
    dir = mkdtempSync(join(tmpdir(), "fp-capture-"));
    capture = new FingerprintCapture(join(dir, "fingerprints.jsonl"));
    expect(() => capture!.close()).not.toThrow();
  });
});

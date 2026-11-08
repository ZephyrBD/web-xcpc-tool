import { describe, expect, test } from "bun:test";
import { getVersionInfo } from "./version";

describe("getVersionInfo", () => {
  test("returns a plausible short git hash or the dev fallback", () => {
    const { hash } = getVersionInfo();
    // In a git checkout we get the short hash; production tarballs may have
    // no git at all, in which case the helper falls back to "dev".
    expect(hash).toMatch(/^(dev|[0-9a-f]{7,})$/);
  });

  test("returns the current year", () => {
    const { year } = getVersionInfo();
    expect(year).toBe(new Date().getFullYear());
  });

  test("caches the result across calls", () => {
    expect(getVersionInfo()).toBe(getVersionInfo());
  });
});

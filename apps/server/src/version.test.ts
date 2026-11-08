import { describe, expect, test } from "bun:test";
import { getVersionInfo } from "./version";

describe("getVersionInfo", () => {
  test("returns a plausible short git hash or the dev fallback", () => {
    const { hash } = getVersionInfo();
    // In a git checkout we get the short hash; production tarballs may have
    // no git at all, in which case the helper falls back to "dev".
    expect(hash).toMatch(/^(dev|[0-9a-f]{7,})$/);
  });

  test("prefers a WXT_VERSION env override over the git hash", async () => {
    const prev = process.env.WXT_VERSION;
    process.env.WXT_VERSION = "v9.9.9-test";
    try {
      // Cache-busting query so we get a fresh module (its version cache is empty).
      // @ts-expect-error bun treats the query string as a distinct module
      const mod = await import("./version?env-override");
      expect(mod.getVersionInfo().hash).toBe("v9.9.9-test");
    } finally {
      if (prev === undefined) delete process.env.WXT_VERSION;
      else process.env.WXT_VERSION = prev;
    }
  });

  test("returns the current year", () => {
    const { year } = getVersionInfo();
    expect(year).toBe(new Date().getFullYear());
  });

  test("caches the result across calls", () => {
    expect(getVersionInfo()).toBe(getVersionInfo());
  });
});

import { describe, expect, test } from "bun:test";

describe("smoke", () => {
  test("1 + 1 === 2", () => {
    expect(1 + 1).toBe(2);
  });
});

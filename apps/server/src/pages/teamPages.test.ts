import { describe, expect, test } from "bun:test";
import { verifyFormPage } from "./teamPages";

const text = (res: Response) => res.text();

/** Build an ISO instant whose LOCAL rendering is the given wall-clock time (formatting is local by design). */
const iso = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString();

describe("verifyFormPage login window hint", () => {
  test("renders the literal code hint and the formatted login window", async () => {
    const html = await text(
      verifyFormPage("/cx", undefined, null, {
        start: iso(2026, 11, 8, 9, 0, 0),
        end: iso(2026, 11, 8, 17, 0, 0),
      }),
    );
    expect(html).toContain("请查看你屏幕上类似 k3w932jattan 这种形式的代码并输入以登录Domjudge");
    expect(html).toContain("登录时段：2026-11-08 09:00:00~2026-11-08 17:00:00");
  });

  test("shows 不限 for missing bounds", async () => {
    const html = await text(verifyFormPage("/cx", undefined, null, { start: "", end: "" }));
    expect(html).toContain("登录时段：不限");
  });

  test("omitting the window entirely still renders the hint as 不限", async () => {
    const html = await text(verifyFormPage("/cx"));
    expect(html).toContain("登录时段：不限");
  });
});

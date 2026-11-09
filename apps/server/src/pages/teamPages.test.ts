import { describe, expect, test } from "bun:test";
import { verifyClaimDeniedPage, verifyFormPage, verifyMissPage, verifyWaitingPage } from "./teamPages";
const text = (res: Response) => res.text();

/** Build an ISO instant whose LOCAL rendering is the given wall-clock time (formatting is local by design). */
const iso = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString();

describe("verifyFormPage login window hint", () => {
  test("renders the literal code hint and the formatted login window", async () => {
    const html = await text(
      verifyFormPage(undefined, null, {
        start: iso(2026, 11, 8, 9, 0, 0),
        end: iso(2026, 11, 8, 17, 0, 0),
      }),
    );
    expect(html).toContain("请查看你屏幕上类似 k3w932jattan 这种形式的代码并输入以登录Domjudge");
    expect(html).toContain("登录时段：2026-11-08 09:00:00~2026-11-08 17:00:00");
  });

  test("shows 不限 for missing bounds", async () => {
    const html = await text(verifyFormPage(undefined, null, { start: "", end: "" }));
    expect(html).toContain("登录时段：不限");
  });

  test("omitting the window entirely still renders the hint as 不限", async () => {
    const html = await text(verifyFormPage());
    expect(html).toContain("登录时段：不限");
  });

  test("only start bound renders <start>~不限 (open-ended window)", async () => {
    const html = await text(
      verifyFormPage(undefined, null, { start: iso(2026, 11, 8, 9, 0, 0), end: "" }),
    );
    expect(html).toContain("登录时段：2026-11-08 09:00:00~不限");
  });

  test("only end bound renders 不限~<end> (window closing at end)", async () => {
    const html = await text(
      verifyFormPage(undefined, null, { start: "", end: iso(2026, 11, 8, 17, 0, 0) }),
    );
    expect(html).toContain("登录时段：不限~2026-11-08 17:00:00");
  });
});

describe("team page branding", () => {
  test("verify form posts to the fixed /wxt/public/verify path", async () => {
    const html = await text(verifyFormPage());
    expect(html).toContain('action="/wxt/public/verify"');
  });

  test("verify form page shows the Web XCPC Tool brand in title and above the card", async () => {
    const html = await text(verifyFormPage());
    expect(html).toContain("<title>Web XCPC Tool");
    expect(html).toContain("Web XCPC Tool");
    expect(html.indexOf("Web XCPC Tool")).toBeLessThan(html.indexOf("class=\"card\""));
  });

  test("all team pages carry the brand consistently", async () => {
    for (const html of await Promise.all([text(verifyFormPage()), text(verifyMissPage())])) {
      expect(html).toContain("<title>Web XCPC Tool");
      expect(html).toContain("Web XCPC Tool");
    }
  });
});

describe("copyright footer", () => {
  test("verifyFormPage shows the studio copyright and version hash", async () => {
    const html = await text(verifyFormPage());
    expect(html).toContain("Modding Craft ZBD Studio");
    expect(html).toContain("Version:");
    expect(html).toContain("Copyright (c) 2018~");
  });

  test("miss page carries the same footer", async () => {
    const html = await text(verifyMissPage());
    expect(html).toContain("Modding Craft ZBD Studio");
    expect(html).toContain("Version:");
  });
});

describe("team page links stay under the fixed /wxt mount", () => {
  test("the claim-denied page links back to /wxt/public/verify", async () => {
    const res = verifyClaimDeniedPage();
    expect(res.status).toBe(403);
    const html = await text(res);
    expect(html).toContain('href="/wxt/public/verify"');
  });

  test("the waiting page polls and claims under /wxt/public/verify", async () => {
    const html = await text(verifyWaitingPage("req-1", null));
    expect(html).toContain('"/wxt/public/verify"');
    expect(html).toContain('base + "/status?req="');
    expect(html).toContain('base + "/claim?req="');
  });
});

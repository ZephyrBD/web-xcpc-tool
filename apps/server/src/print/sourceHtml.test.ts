import { describe, expect, test } from "bun:test";
import { buildSourceHtml } from "./sourceHtml";
import type { PrintTask } from "./queue";

const task: PrintTask = {
  id: "t1",
  location: "I1",
  teamName: "队伍一",
  teamId: "42",
  originalFilename: "main.cpp",
  status: "pending",
  pdfPath: "pdf/t1.pdf",
  sourcePath: "printed/t1/main.cpp",
  createdAt: "2026-11-09T10:30:45.000Z",
};

describe("buildSourceHtml", () => {
  test("two-line fixed header with location, team, id and local time", () => {
    const html = buildSourceHtml(task, "int main(){}\n");
    expect(html).toContain("[I1] 队伍一 (42) | ");
    // yyyy-MM-dd HH:mm:ss shape
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(html).toContain("--- Web XCPC Tool ---");
    expect(html).toContain("position: fixed");
    expect(html).toContain("@page { size: A4; margin: 15mm; }");
    expect(html).toContain("Maple Mono NF CN");
    expect(html).toContain("white-space: pre-wrap");
  });

  test("C-like source is formatted by the original filename extension", () => {
    const html = buildSourceHtml(task, "int main(){\nprintf(\"hi\");\n}\n");
    expect(html).toContain("  printf(&quot;hi&quot;);");
  });

  test("code content is HTML-escaped (XSS guard on user code)", () => {
    const html = buildSourceHtml(task, '<script>alert("x")</script>');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("unparseable createdAt falls back to the raw string", () => {
    const html = buildSourceHtml({ ...task, createdAt: "not-a-date" }, "x");
    expect(html).toContain("| not-a-date");
  });
});

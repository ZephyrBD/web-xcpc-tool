import { describe, expect, test } from "bun:test";
import { generateCodePdf } from "./pdf";

const HEADER = { location: "A101", teamName: "队伍一", teamId: "1095218" };

describe("generateCodePdf", () => {
  test("produces a valid multi-line PDF buffer", async () => {
    const code = "int main(){\n  return 0;\n}\n".repeat(50);
    const { buffer, pages } = await generateCodePdf(code, HEADER);
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pages).toBeGreaterThanOrEqual(1);
    // A real PDF: the xref trailer closes the file.
    expect(buffer.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
    expect(buffer.byteLength).toBeGreaterThan(5_000); // embedded TTF subset
  });

  test("empty body still yields one page", async () => {
    const { buffer, pages } = await generateCodePdf("", HEADER);
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pages).toBe(1);
  });

  test("long content flows onto multiple pages with correct total count", async () => {
    // ~80 chars per line at 10pt monospace on A4; 200 wrapped lines ≈ 5 pages.
    const line = "x".repeat(200) + "\n";
    const { buffer, pages } = await generateCodePdf(line.repeat(200), HEADER);
    expect(pages).toBeGreaterThan(3);
    expect(buffer.toString("latin1")).toContain("/Type /Page");
  });

  test("renders CJK team names without throwing", async () => {
    const { buffer } = await generateCodePdf("print('你好');\n", { ...HEADER, teamName: "闪电队" });
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

import { describe, expect, test } from "bun:test";
import { formatCode } from "./format";

describe("formatCode", () => {
  test("C: brace-based auto-indent with 2-space steps", () => {
    const src = "int main(){\nif(x){\nreturn 0;\n}\n}\n";
    expect(formatCode(src, "cpp")).toBe(
      "int main(){\n  if(x){\n    return 0;\n  }\n}\n",
    );
  });

  test("C: line starting with } decrements before printing", () => {
    const src = "void f(){\nwhile(1){\n}\n}\n";
    expect(formatCode(src, "c")).toBe("void f(){\n  while(1){\n  }\n}\n");
  });

  test("C: closing brace never goes negative", () => {
    expect(formatCode("}\n}", "java")).toBe("}\n}\n");
  });

  test("C: blank lines are dropped and lines trimmed", () => {
    expect(formatCode("int  a;\n\n   \nint b;", "c")).toBe("int  a;\nint b;\n");
  });

  test("python: keeps indentation, drops blank lines", () => {
    const src = "def f():\n    return 1\n\nprint(f())\n";
    expect(formatCode(src, "py")).toBe("def f():\n    return 1\nprint(f())\n");
  });

  test("CRLF and lone CR are normalized to LF", () => {
    expect(formatCode("a{\r\nb;\r\n}\r\n", "c")).toBe("a{\n  b;\n}\n");
    expect(formatCode("x=1\r\ny=2\r", "py")).toBe("x=1\ny=2\n");
  });

  test("unknown extension passes through unchanged (except newline normalization)", () => {
    expect(formatCode("line1\n\nline2", "txt")).toBe("line1\n\nline2");
    expect(formatCode("  keep  me ", "hs")).toBe("  keep  me ");
  });

  test("blank input yields empty output", () => {
    expect(formatCode("", "cpp")).toBe("");
    expect(formatCode("   \n\t", "py")).toBe("");
  });
});

/**
 * Code formatting for print output — a faithful port of the legacy Java
 * CodeFormatter (src/main/java/top/techmczs/cuitxcpctool/utils/CodeFormatter.java):
 * CRLF is normalized to LF; C/C++/Java sources get brace-based auto-indent
 * with blank lines dropped; Python keeps indentation but drops blank lines;
 * everything else passes through unchanged.
 */

const C_LIKE = new Set(["c", "cpp", "java"]);

function formatCCode(code: string): string {
  const out: string[] = [];
  let indent = 0;
  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("}")) indent = Math.max(0, indent - 1);
    out.push("  ".repeat(indent) + trimmed);
    if (trimmed.endsWith("{") && !trimmed.startsWith("}")) indent++;
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

function formatPythonCode(code: string): string {
  return code.split("\n").filter((line) => line.trim() !== "").join("\n") + "\n";
}

export function formatCode(code: string, fileSuffix: string): string {
  if (code.trim() === "") return "";
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const ext = fileSuffix.toLowerCase();
  if (C_LIKE.has(ext)) return formatCCode(normalized);
  if (ext === "py") return formatPythonCode(normalized);
  return normalized;
}

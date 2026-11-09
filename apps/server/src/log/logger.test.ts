import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, initLogger, log, registerSecret } from "./logger";

/** Collects what the logger writes to its console stream. */
function capture() {
  const chunks: string[] = [];
  const stream = {
    isTTY: true,
    write: (s: string) => {
      chunks.push(String(s));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join(""), lines: () => chunks.join("").split("\n").filter(Boolean) };
}

function tempFile(name = "latest.log") {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  return { dir, path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LINE = /^\d{2} \d{2}:\d{2}:\d{2} +[^ ]+ \[[DIWEC]\] .+$/;

/** Asserts every non-empty line of a log file matches the canonical format (no anchors on `\n$`). */
function expectFileLines(raw: string): void {
  const lines = raw.split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l).toMatch(/^\d{2} \d{2}:\d{2}:\d{2} +[^ ]+ \[[DIWEC]\] .+$/);
}

describe("logger line format", () => {
  test("matches `dd hh:mm:ss name [X] msg`", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ stream, color: false });
    logger.info("balloon", "polled 3 balloons");
    const [line] = lines();
    expect(line).toMatch(LINE);
    expect(line).toMatch(/ \[\w\] polled 3 balloons$/);
    // dd + one space + hh:mm:ss
    expect(line.slice(0, 11)).toMatch(/^\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("name is right-aligned to width 9, long names are not truncated", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ stream, color: false });
    logger.info("ab", "x");
    logger.info("server", "x");
    logger.warn("a-very-long-component-name", "x");
    const [short, mid, long] = lines();
    // 11 chars of `dd hh:mm:ss` + one space, then the right-aligned name column.
    expect(short.slice(0, 12)).toMatch(/^\d{2} \d{2}:\d{2}:\d{2} $/);
    expect(short.slice(12)).toStartWith(`${"ab".padStart(9)} [I] x`);
    expect(mid.slice(12)).toStartWith(`${"server".padStart(9)} [I] x`);
    // Long names are kept whole: no truncation, no padding.
    expect(long.slice(12)).toStartWith("a-very-long-component-name [W] ");
  });

  test("tags map to D/I/W/E/C", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ stream, color: false });
    logger.debug("n", "d");
    logger.info("n", "i");
    logger.warn("n", "w");
    logger.error("n", "e");
    logger.critical("n", "c");
    expect(lines().map((l) => l.match(/\[(\w)\]/)?.[1])).toEqual(["D", "I", "W", "E", "C"]);
  });

  test("message and trailing args are joined", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ stream, color: false });
    logger.error("balloon", "poll failed:", "boom");
    expect(lines()[0]).toEndWith("balloon [E] poll failed: boom");
  });

  test("multi-line messages indent continuation lines to the msg column", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ stream, color: false });
    logger.info("banner", "one\ntwo\n\nthree");
    const out = lines();
    // 11 (timestamp + space) + 9 (name) + 6 (" [I] ") = 26
    const indent = 26;
    expect(out[0]).toEndWith(" [I] one");
    expect(out[0].indexOf("one")).toBe(indent);
    expect(out[1]).toBe(" ".repeat(indent) + "two");
    expect(out[2]).toBe(" ".repeat(indent));
    expect(out[3]).toBe(" ".repeat(indent) + "three");
  });
});

describe("logger color", () => {
  test("color:false emits no ANSI", () => {
    const { stream, text } = capture();
    createLogger({ stream, color: false }).info("n", "m");
    expect(text()).not.toContain("\x1b");
  });

  test("color:true colors timestamp gray, tag per level, and resets after each span", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ stream, color: true });
    logger.info("n", "i");
    logger.warn("n", "w");
    logger.error("n", "e");
    logger.critical("n", "c");
    logger.debug("n", "d");
    const [info, warn, error, critical, debug] = lines();
    expect(info).toContain("\x1b[90m");
    expect(info).toContain("\x1b[36m");
    expect(warn).toContain("\x1b[33m");
    expect(error).toContain("\x1b[31m");
    expect(critical).toContain("\x1b[1;91m");
    expect(debug).toContain("\x1b[90m");
    for (const line of lines()) expect(line).toEndWith("\x1b[0m");
  });

  test("NO_COLOR and FORCE_COLOR=0 disable color even on a TTY", () => {
    const { stream, text } = capture();
    const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
    try {
      process.env.NO_COLOR = "1";
      createLogger({ stream }).info("n", "m");
      expect(text()).not.toContain("\x1b");

      process.env.NO_COLOR = "";
      createLogger({ stream }).info("n", "m");
      expect(text()).not.toContain("\x1b");

      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "0";
      createLogger({ stream }).info("n", "m");
      expect(text()).not.toContain("\x1b");

      // supports-color convention: an empty FORCE_COLOR disables color too.
      process.env.FORCE_COLOR = "";
      createLogger({ stream }).info("n", "m");
      expect(text()).not.toContain("\x1b");
    } finally {
      if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved.NO_COLOR;
      if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.FORCE_COLOR;
    }
  });

  test("non-TTY streams get no color; FORCE_COLOR=1 forces it", () => {
    const tty = capture();
    const chunks: string[] = [];
    const notTty = {
      isTTY: false,
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
    try {
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
      createLogger({ stream: notTty }).info("n", "m");
      expect(chunks.join("")).not.toContain("\x1b");

      chunks.length = 0;
      const forced: string[] = [];
      const forcedStream = {
        isTTY: false,
        write: (s: string) => {
          forced.push(String(s));
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      process.env.FORCE_COLOR = "1";
      createLogger({ stream: forcedStream }).info("n", "m");
      expect(forced.join("")).toContain("\x1b[");
      expect(tty.text()).toBe("");
    } finally {
      if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved.NO_COLOR;
      if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.FORCE_COLOR;
    }
  });
});

describe("logger file output", () => {
  test("file gets plain lines (no ANSI) with the same continuation alignment", () => {
    const f = tempFile();
    const { stream } = capture();
    try {
      const logger = createLogger({ stream, color: true, filePath: f.path });
      logger.info("banner", "one\ntwo");
      const raw = readFileSync(f.path, "utf8");
      expect(raw).not.toContain("\x1b");
      const [first, second] = raw.split("\n");
      expectFileLines(first);
      expect(second).toBe(" ".repeat(26) + "two");
    } finally {
      f.cleanup();
    }
  });

  test("registered secrets are masked in the file but kept on the console", () => {
    const f = tempFile();
    const { stream, text } = capture();
    try {
      const logger = createLogger({ stream, color: false, filePath: f.path, secrets: ["s3cret-pw"] });
      logger.info("banner", "admin s3cret-pw");
      logger.registerSecret("another");
      logger.info("banner", "x another y");
      const raw = readFileSync(f.path, "utf8");
      expect(raw).toContain("admin ********");
      expect(raw).not.toContain("s3cret-pw");
      expect(raw).toContain("x ******** y");
      expect(text()).toContain("admin s3cret-pw");
      expect(text()).toContain("x another y");
    } finally {
      f.cleanup();
    }
  });

  test("secrets shorter than 6 chars are ignored so unrelated text is not mangled", () => {
    const f = tempFile();
    try {
      // "abc" (3) and "abcde" (5) are below the threshold; "abcdef" (6) is not.
      const logger = createLogger({ filePath: f.path, console: false, secrets: ["abc", "abcde"] });
      logger.registerSecret("abcdef");
      logger.info("n", "abcdef and abcde and abc");
      const raw = readFileSync(f.path, "utf8");
      expect(raw.trimEnd()).toEndWith("******** and abcde and abc");
    } finally {
      f.cleanup();
    }
  });

  test("masking is independent of registration order (longest-first, stable ties)", () => {
    const f = tempFile();
    try {
      // "abcdef123456" contains "abcdef": whichever registers first, the whole
      // secret is masked, never a half-masked remainder.
      const a = createLogger({ filePath: f.path, console: false, secrets: ["abcdef", "abcdef123456"] });
      a.info("n", "token abcdef123456");
      const b = createLogger({ filePath: join(f.dir, "b.log"), console: false, secrets: ["abcdef123456", "abcdef"] });
      b.info("n", "token abcdef123456");
      const lineA = readFileSync(f.path, "utf8").trim();
      const lineB = readFileSync(join(f.dir, "b.log"), "utf8").trim();
      expect(lineA).toEndWith("token ********");
      expect(lineB.slice(lineB.indexOf("token"))).toBe(lineA.slice(lineA.indexOf("token")));
      expect(lineB).not.toContain("123456");
    } finally {
      f.cleanup();
    }
  });

  test("a rotated password registered later is masked for subsequent lines only", () => {
    const f = tempFile();
    const { stream, text } = capture();
    try {
      const logger = createLogger({ stream, color: false, filePath: f.path, secrets: ["old-password-1"] });
      logger.info("banner", "admin old-password-1");
      // Simulates a settings PUT installing a new plaintext admin password.
      logger.registerSecret("new-password-2");
      logger.info("banner", "admin new-password-2");
      const [first, second] = readFileSync(f.path, "utf8").trim().split("\n");
      expect(first).toEndWith("admin ********");
      expect(second).toEndWith("admin ********");
      expect(text()).toContain("admin old-password-1");
      expect(text()).toContain("admin new-password-2");
    } finally {
      f.cleanup();
    }
  });

  test("file parent directory is created on demand", () => {
    const f = tempFile();
    const nested = join(f.dir, "logs", "deep", "latest.log");
    try {
      createLogger({ filePath: nested, color: false, stream: capture().stream }).info("n", "m");
      expect(existsSync(nested)).toBe(true);
      expectFileLines(readFileSync(nested, "utf8"));
    } finally {
      f.cleanup();
    }
  });

  test("console:false writes the file only", () => {
    const f = tempFile();
    const { stream, text } = capture();
    try {
      createLogger({ stream, console: false, filePath: f.path }).info("n", "m");
      expect(text()).toBe("");
      expectFileLines(readFileSync(f.path, "utf8"));
    } finally {
      f.cleanup();
    }
  });
});

describe("initLogger", () => {
  test("truncates the log file at startup and installs the module logger", () => {
    const f = tempFile();
    const { stream, text } = capture();
    try {
      // Pre-existing content must vanish: one fresh file per start.
      createLogger({ filePath: f.path, ...{ stream }, color: false }).info("old", "stale line");
      const logger = initLogger({ logFilePath: f.path, stream, color: false });
      logger.info("new", "fresh line");
      const raw = readFileSync(f.path, "utf8");
      expect(raw).not.toContain("stale line");
      expect(raw).toContain("fresh line");
      expect(text()).toContain("stale line");
      expect(text()).toContain("fresh line");
    } finally {
      f.cleanup();
    }
  });

  test("secrets passed to initLogger are masked in the file", () => {
    const f = tempFile();
    try {
      const logger = initLogger({ logFilePath: f.path, console: false, secrets: ["pw-123456"] });
      logger.info("banner", "admin admin pw-123456");
      const raw = readFileSync(f.path, "utf8");
      expect(raw).toContain("admin admin ********");
      expect(raw).not.toContain("pw-123456");
    } finally {
      f.cleanup();
    }
  });

  test("a rotated admin password registered later (config change) is masked in the file, plaintext on console", () => {
    const f = tempFile();
    const { stream, text } = capture();
    try {
      // Boot: the first plaintext password registered with the process logger.
      initLogger({ logFilePath: f.path, stream, color: false, secrets: ["boot-password"] });
      log.info("startup", "密码     boot-password");

      // A settings PUT / purge swaps in a new plaintext password; index.ts's
      // configStore.onChange listener registers it before the next log line.
      registerSecret("rotated-password");
      log.info("admin", "密码     rotated-password");

      const raw = readFileSync(f.path, "utf8");
      expect(raw).toContain("密码     ********");
      expect(raw).not.toContain("boot-password");
      expect(raw).not.toContain("rotated-password");
      // Console keeps both plaintexts.
      expect(text()).toContain("boot-password");
      expect(text()).toContain("rotated-password");
    } finally {
      f.cleanup();
    }
  });

  test("the DOMjudge admin password is masked like the admin one", () => {
    const f = tempFile();
    const { stream, text } = capture();
    try {
      // index.ts registers both secrets at boot (admin.password and
      // domjudge.adminPassword) and again from configStore.onChange.
      initLogger({ logFilePath: f.path, stream, color: false, secrets: ["admin-boot-pw", "dj-boot-pw"] });
      log.error("proxy", "upstream error: https://dj.example.com/api/v4 users Basic dj-boot-pw");

      // A settings PUT rotates the DOMjudge credential.
      registerSecret("dj-rotated-pw");
      log.error("proxy", "upstream error: dj-rotated-pw rejected");

      const raw = readFileSync(f.path, "utf8");
      expect(raw).not.toContain("dj-boot-pw");
      expect(raw).not.toContain("dj-rotated-pw");
      expect(raw).toContain("********");
      // Console keeps the plaintext (operators debug from the terminal).
      expect(text()).toContain("dj-rotated-pw");
    } finally {
      f.cleanup();
    }
  });

  test("registerSecret ignores empty and shorter-than-6 values", () => {
    const f = tempFile();
    try {
      initLogger({ logFilePath: f.path, console: false, secrets: [""] });
      registerSecret("");
      registerSecret("abc");
      log.info("n", "abc stays readable");
      const raw = readFileSync(f.path, "utf8");
      expect(raw).toContain("abc stays readable");
    } finally {
      f.cleanup();
    }
  });
});

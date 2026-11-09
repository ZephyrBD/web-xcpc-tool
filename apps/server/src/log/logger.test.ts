import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, initLogger } from "./logger";

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
    expect(out[0]).toStartWith(" ".repeat(0) + out[0].slice(0, indent) + "one");
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

  test("file parent directory is created on demand", () => {
    const f = tempFile();
    const nested = join(f.dir, "logs", "deep", "latest.log");
    try {
      createLogger({ filePath: nested, color: false, ...capture() }).info("n", "m");
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
});

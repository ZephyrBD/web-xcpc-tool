import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Structured line logger: one human-first line per event on the console and,
 * optionally, a single truncated-on-startup file (`data/logs/latest.log`).
 *
 * Line format (day-of-month, 24h clock, name right-aligned to 9, one tag):
 *
 *   09 14:03:07   balloon [I] polled 3 balloons
 *
 * Tags: D=debug, I=info, W=warn, E=error, C=critical. Multi-line messages have
 * their continuation lines indented to the column where `msg` starts, so
 * stacked lines line up in both the console and the file.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "critical";

/** Single uppercase letter that follows the aligned name. */
const TAGS: Record<LogLevel, string> = {
  debug: "D",
  info: "I",
  warn: "W",
  error: "E",
  critical: "C",
};

/** ANSI 16-color span per tag; name and message are never colored. */
const COLOR: Record<"timestamp" | LogLevel, string> = {
  timestamp: "\x1b[90m", // gray
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  critical: "\x1b[1;91m", // bold bright red
};
const RESET = "\x1b[0m";

/** Width the name column is padded to (longer names are kept whole). */
const NAME_WIDTH = 9;

export type LoggerOptions = {
  /** Append target. Parent directories are created; the file is not truncated here (see initLogger). */
  filePath?: string;
  /** Force color on (true) or off (false); omitted = auto-detect from stream/env. */
  color?: boolean;
  /** Console target; defaults to process.stdout. */
  stream?: NodeJS.WriteStream;
  /** Set false to keep file output only (no console copy). */
  console?: boolean;
  /** Plaintext secrets masked as `********` in the FILE output only. */
  secrets?: string[];
};

export type Logger = {
  debug(name: string, msg: string, ...args: unknown[]): void;
  info(name: string, msg: string, ...args: unknown[]): void;
  warn(name: string, msg: string, ...args: unknown[]): void;
  error(name: string, msg: string, ...args: unknown[]): void;
  critical(name: string, msg: string, ...args: unknown[]): void;
  /** Registers a plaintext secret to mask in file output. */
  registerSecret(secret: string): void;
};

const MASK = "********";

/**
 * Shortest secret worth masking. Generated admin passwords are 16 chars, while
 * a 1-3 char "password" would turn every line containing that letter sequence
 * into noise (and mask unrelated text), so shorter values are ignored: they are
 * not secrets in any meaningful sense and the log stays readable.
 */
const MIN_SECRET_LENGTH = 6;

/** True when `stream` is a TTY and nothing (NO_COLOR / FORCE_COLOR) forbids color. */
function autoColor(stream: NodeJS.WriteStream | undefined, env: NodeJS.ProcessEnv): boolean {
  const force = env.FORCE_COLOR;
  // supports-color convention: FORCE_COLOR wins over NO_COLOR, "" disables.
  if (force === "") return false;
  if (force === "0" || force === "false") return false;
  if (force !== undefined) return true; // "1"/"2"/"3"/"true"/any non-empty value
  if (env.NO_COLOR !== undefined) return false;
  return stream?.isTTY === true;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `dd hh:mm:ss` in local time. */
function timestamp(d: Date): string {
  return `${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Message plus trailing args flattened onto one text block (stack traces carry their own newlines). */
function messageText(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;
  return [msg, ...args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : String(a)))].join(
    " ",
  );
}

/**
 * Prefix width as seen by a human: `dd hh:mm:ss` + space + name column + " [X]".
 * Continuation lines are padded with this many spaces so they start under `msg`.
 */
function visiblePrefixWidth(ts: string, name: string): number {
  const label = name.padStart(NAME_WIDTH);
  return ts.length + 1 + label.length + " [X]".length + 1;
}

function indentContinuation(text: string, width: number): string {
  if (!text.includes("\n")) return text;
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n");
}

/**
 * Applies every registered secret as a plain substring replacement. The list is
 * kept longest-first (see addSecret), so a secret that contains another one is
 * masked whole; ties are broken by the value itself, so the masking result never
 * depends on registration order.
 */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join(MASK);
  return out;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const stream = opts.stream ?? process.stdout;
  const toConsole = opts.console !== false;
  const useColor = toConsole && (opts.color ?? autoColor(stream, process.env));
  const filePath = opts.filePath;
  // Longest first so a secret containing another secret is masked whole (ties
  // by value, so masking is independent of registration order).
  const secrets: string[] = [];
  const addSecret = (s: string | undefined): void => {
    if (!s || s.length < MIN_SECRET_LENGTH) return;
    if (secrets.includes(s)) return;
    secrets.push(s);
    secrets.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  };
  for (const s of opts.secrets ?? []) addSecret(s);

  if (filePath) mkdirSync(dirname(filePath), { recursive: true });

  const write = (level: LogLevel, name: string, msg: string, args: unknown[]): void => {
    const ts = timestamp(new Date());
    const label = name.padStart(NAME_WIDTH);
    const tag = TAGS[level];
    const width = visiblePrefixWidth(ts, name);
    const text = indentContinuation(messageText(msg, args), width);
    const suffix = `${label} [${tag}] ${text}`;

    const consoleLine = useColor
      ? `${COLOR.timestamp}${ts}${RESET} ${COLOR[level]}${suffix}${RESET}`
      : `${ts} ${suffix}`;
    if (toConsole) stream.write(`${consoleLine}\n`);

    if (!filePath) return;
    const plain = `${ts} ${suffix}`;
    const line = secrets.length > 0 ? redact(plain, secrets) : plain;
    try {
      appendFileSync(filePath, `${line}\n`, "utf8");
    } catch {
      // A log write must never take the caller down (disk full, ro mount, ...).
    }
  };

  return {
    debug: (name, msg, ...args) => write("debug", name, msg, args),
    info: (name, msg, ...args) => write("info", name, msg, args),
    warn: (name, msg, ...args) => write("warn", name, msg, args),
    error: (name, msg, ...args) => write("error", name, msg, args),
    critical: (name, msg, ...args) => write("critical", name, msg, args),
    registerSecret: addSecret,
  };
}

/** A logger that colors per env/stream but writes no file: the default until initLogger runs. */
const defaultLogger = createLogger();

let active: Logger = defaultLogger;

export type InitLoggerOptions = {
  /** File to truncate on startup and append to. `false` disables file output. */
  logFilePath?: string | false;
  /** Console output toggle (default true). */
  console?: boolean;
  /** Force color on/off; omitted = auto-detect. */
  color?: boolean;
  /** Console stream (tests); defaults to process.stdout. */
  stream?: NodeJS.WriteStream;
  /** Plaintext secrets to mask in the file. */
  secrets?: string[];
};

/**
 * Installs the process-wide logger. The log file is emptied here (one file,
 * `data/logs/latest.log` by convention): every start begins a fresh log.
 */
export function initLogger(opts: InitLoggerOptions = {}): Logger {
  const filePath = opts.logFilePath === false ? undefined : opts.logFilePath;
  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "", "utf8");
  }
  const installed = createLogger({
    ...(filePath ? { filePath } : {}),
    ...(opts.color !== undefined ? { color: opts.color } : {}),
    ...(opts.console !== undefined ? { console: opts.console } : {}),
    ...(opts.stream ? { stream: opts.stream } : {}),
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
  });
  active = installed;
  return installed;
}

/** Module-level facade: always forwards to the currently installed logger. */
export const log: Logger = {
  debug: (name, msg, ...args) => active.debug(name, msg, ...args),
  info: (name, msg, ...args) => active.info(name, msg, ...args),
  warn: (name, msg, ...args) => active.warn(name, msg, ...args),
  error: (name, msg, ...args) => active.error(name, msg, ...args),
  critical: (name, msg, ...args) => active.critical(name, msg, ...args),
  registerSecret: (s) => active.registerSecret(s),
};

/** Masks `s` in every log file from now on (console keeps plaintext). */
export function registerSecret(s: string | undefined): void {
  if (s) active.registerSecret(s);
}

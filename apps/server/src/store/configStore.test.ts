import { describe, expect, test } from "bun:test";
import { CONTEXT_PATH, loadConfig, type Config } from "../config";
import { ConfigStore } from "./configStore";

/** contextPath is pinned, so tests use port/teamLogin as the observable marker. */
const makeCfg = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
  ...overrides,
});

describe("ConfigStore", () => {
  test("current returns the initial config", () => {
    const cfg = makeCfg();
    const store = new ConfigStore(cfg);
    expect(store.current).toBe(cfg);
    expect(store.current.contextPath).toBe(CONTEXT_PATH);
  });

  test("replace swaps the live config", () => {
    const store = new ConfigStore(makeCfg({ port: 8080 }));
    const next = makeCfg({ port: 9090 });
    store.replace(next);
    expect(store.current).toBe(next);
    expect(store.current.port).toBe(9090);
    // The mount can never move: every parsed config carries the same value.
    expect(store.current.contextPath).toBe(CONTEXT_PATH);
  });

  test("onChange callbacks receive the new config", () => {
    const store = new ConfigStore(makeCfg());
    const seen: Config[] = [];
    store.onChange((c) => seen.push(c));
    const next = makeCfg({ port: 7001 });
    store.replace(next);
    expect(seen).toEqual([next]);
  });

  test("unsubscribing stops further callbacks", () => {
    const store = new ConfigStore(makeCfg());
    let calls = 0;
    const unsub = store.onChange(() => calls++);
    store.replace(makeCfg({ port: 7001 }));
    unsub();
    store.replace(makeCfg({ port: 7002 }));
    expect(calls).toBe(1);
  });

  test("a throwing listener does not starve the others", () => {
    const store = new ConfigStore(makeCfg());
    const seen: number[] = [];
    store.onChange(() => {
      throw new Error("boom");
    });
    store.onChange((c) => seen.push(c.port));
    store.replace(makeCfg({ port: 7001 }));
    expect(seen).toEqual([7001]);
  });

  test("stable listener registration order: listeners added during a replace wait for the next one", () => {
    const store = new ConfigStore(makeCfg());
    const seen: string[] = [];
    store.onChange(() => {
      store.onChange((c) => seen.push(`late:${c.teamLogin.end}`));
    });
    store.replace(makeCfg({ teamLogin: { start: "", end: "2001-01-01T00:00:00Z" } }));
    store.replace(makeCfg({ teamLogin: { start: "", end: "2002-01-01T00:00:00Z" } }));
    expect(seen).toEqual(["late:2002-01-01T00:00:00Z"]);
  });
});
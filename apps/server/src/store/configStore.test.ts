import { describe, expect, test } from "bun:test";
import { loadConfig, type Config } from "../config";
import { ConfigStore } from "./configStore";

const makeCfg = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig("/nonexistent/settings.json"),
  jwt: { secret: "test-secret", ttlSeconds: 3600 },
  ...overrides,
});

describe("ConfigStore", () => {
  test("current returns the initial config", () => {
    const cfg = makeCfg({ contextPath: "/wxt" });
    const store = new ConfigStore(cfg);
    expect(store.current).toBe(cfg);
    expect(store.current.contextPath).toBe("/wxt");
  });

  test("replace swaps the live config", () => {
    const store = new ConfigStore(makeCfg({ contextPath: "/wxt" }));
    const next = makeCfg({ contextPath: "/cxtool" });
    store.replace(next);
    expect(store.current).toBe(next);
    expect(store.current.contextPath).toBe("/cxtool");
  });

  test("onChange callbacks receive the new config", () => {
    const store = new ConfigStore(makeCfg());
    const seen: Config[] = [];
    store.onChange((c) => seen.push(c));
    const next = makeCfg({ contextPath: "/next" });
    store.replace(next);
    expect(seen).toEqual([next]);
  });

  test("unsubscribing stops further callbacks", () => {
    const store = new ConfigStore(makeCfg());
    let calls = 0;
    const unsub = store.onChange(() => calls++);
    store.replace(makeCfg({ contextPath: "/a" }));
    unsub();
    store.replace(makeCfg({ contextPath: "/b" }));
    expect(calls).toBe(1);
  });

  test("a throwing listener does not starve the others", () => {
    const store = new ConfigStore(makeCfg());
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error("boom");
    });
    store.onChange((c) => seen.push(c.contextPath));
    store.replace(makeCfg({ contextPath: "/ok" }));
    expect(seen).toEqual(["/ok"]);
  });

  test("stable listener registration order: listeners added during a replace wait for the next one", () => {
    const store = new ConfigStore(makeCfg());
    const seen: string[] = [];
    store.onChange(() => {
      store.onChange((c) => seen.push(`late:${c.contextPath}`));
    });
    store.replace(makeCfg({ contextPath: "/first" }));
    store.replace(makeCfg({ contextPath: "/second" }));
    expect(seen).toEqual(["late:/second"]);
  });
});

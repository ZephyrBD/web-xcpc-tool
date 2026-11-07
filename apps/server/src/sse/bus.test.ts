import { describe, expect, test } from "bun:test";
import { SseBus } from "./bus";

describe("SseBus", () => {
  test("subscribe receives published events", () => {
    const bus = new SseBus();
    const seen: Array<{ event: string; data: unknown }> = [];
    bus.subscribe("admin", (e) => seen.push(e));
    bus.publish("admin", "auth-task", { id: "1" });
    expect(seen).toEqual([{ event: "auth-task", data: { id: "1" } }]);
  });

  test("unsubscribe stops receiving events", () => {
    const bus = new SseBus();
    const seen: Array<{ event: string; data: unknown }> = [];
    const off = bus.subscribe("admin", (e) => seen.push(e));
    off();
    bus.publish("admin", "auth-task", { id: "1" });
    expect(seen).toEqual([]);
  });

  test("events are channel-scoped", () => {
    const bus = new SseBus();
    const seen: Array<{ event: string; data: unknown }> = [];
    bus.subscribe("other", (e) => seen.push(e));
    bus.publish("admin", "auth-task", { id: "1" });
    expect(seen).toEqual([]);
  });
});

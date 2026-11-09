import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoginRequestStore } from "./loginRequests";

describe("LoginRequestStore", () => {
  let dataDir: string;
  let filePath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "login-req-"));
    filePath = join(dataDir, "login-requests.json");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const sampleReq = () => ({
    icpcId: "icpc1",
    teamCode: "abcdefgh2345",
    teamName: "Team X",
    ip: "127.0.0.1",
  });

  test("create generates a uuid id and pending status", () => {
    const store = new LoginRequestStore(filePath);
    const r = store.create(sampleReq());
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.status).toBe("pending");
    expect(r.decidedAt).toBeNull();
    expect(r.requestedAt).not.toBe("");
    expect(store.listAll().length).toBe(1);
  });

  test("get returns null for unknown ids", () => {
    const store = new LoginRequestStore(filePath);
    store.create(sampleReq());
    expect(store.get("no-such-id")).toBeNull();
  });

  test("decide only mutates pending requests", () => {
    const store = new LoginRequestStore(filePath);
    const r = store.create(sampleReq());
    expect(store.decide(r.id, "approved")?.status).toBe("approved");
    expect(store.decide(r.id, "rejected")).toBeNull();
    expect(store.get(r.id)?.status).toBe("approved");
    expect(store.get(r.id)?.decidedAt).not.toBeNull();
  });

  test("consume only succeeds for approved and claims exactly once", () => {
    const store = new LoginRequestStore(filePath);
    const r = store.create(sampleReq());
    // pending requests cannot be claimed
    expect(store.consume(r.id)).toBeNull();
    store.decide(r.id, "approved");
    const consumed = store.consume(r.id);
    expect(consumed?.status).toBe("claimed");
    // approval is valid ONCE — the second claim must fail
    expect(store.consume(r.id)).toBeNull();
  });

  test("listPending filters out decided requests", () => {
    const store = new LoginRequestStore(filePath);
    const a = store.create(sampleReq());
    const b = store.create({ ...sampleReq(), icpcId: "icpc2" });
    store.decide(a.id, "rejected");
    expect(store.listPending().map((r) => r.id)).toEqual([b.id]);
  });

  test("state survives a restart (same path, new store instance)", () => {
    const store = new LoginRequestStore(filePath);
    const r = store.create(sampleReq());
    store.decide(r.id, "approved");

    const reloaded = new LoginRequestStore(filePath);
    expect(reloaded.get(r.id)?.status).toBe("approved");
    expect(reloaded.consume(r.id)?.status).toBe("claimed");
  });
});

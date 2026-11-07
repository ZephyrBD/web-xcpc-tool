import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthQueue } from "./authQueue";
import { setDataDir } from "../store/store";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "authqueue-"));
  setDataDir(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  setDataDir("");
});

function makeQueue(): AuthQueue {
  const q = new AuthQueue();
  q.autoAccept = false;
  return q;
}

describe("AuthQueue", () => {
  test("enqueue with autoAccept=false creates pending task, approve transitions to approved", () => {
    const q = makeQueue();
    const t = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    expect(t.status).toBe("pending");
    expect(t.examNum).toBe("e1");
    expect(t.id).toBeTruthy();
    expect(t.createdAt).toBeTruthy();

    const approved = q.approve(t.id);
    expect(approved?.status).toBe("approved");
    expect(q.approve("nope")).toBeNull();
  });

  test("duplicate pending examNum+clientId is deduplicated", () => {
    const q = makeQueue();
    const a = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    const b = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "other" });
    expect(b.id).toBe(a.id);
    expect(b.strategy).toBe("ua");
    expect(q.list().length).toBe(1);

    // same examNum but different client is not deduplicated
    const c = q.enqueue({ examNum: "e1", clientId: "c2", strategy: "ua" });
    expect(c.id).not.toBe(a.id);
    expect(q.list().length).toBe(2);
  });

  test("autoAccept=true enqueues directly as auto-done", () => {
    const q = makeQueue();
    q.autoAccept = true;
    const t = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    expect(t.status).toBe("auto-done");
    expect(q.list("auto-done").length).toBe(1);
  });

  test("list filters by status and reject transitions to rejected", () => {
    const q = makeQueue();
    const a = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    const b = q.enqueue({ examNum: "e2", clientId: "c2", strategy: "ua" });
    q.reject(a.id);
    expect(q.reject("nope")).toBeNull();
    expect(q.list("rejected").map((t) => t.id)).toEqual([a.id]);
    expect(q.list("pending").map((t) => t.id)).toEqual([b.id]);
    expect(q.list().length).toBe(2);
  });

  test("onChange fires on mutations, unsubscribe stops it", () => {
    const q = makeQueue();
    const seen: string[] = [];
    const off = q.onChange((t) => seen.push(t.status));
    q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    off();
    q.enqueue({ examNum: "e2", clientId: "c2", strategy: "ua" });
    expect(seen).toEqual(["pending"]);
  });

  test("persists through JsonStore on mutations", () => {
    const path = join("auth-tasks.json");
    const q = makeQueue();
    const t = q.enqueue({ examNum: "e1", clientId: "c1", strategy: "ua" });
    q.approve(t.id);

    expect(existsSync(join(dataDir, path))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dataDir, path), "utf8"));
    expect(raw.length).toBe(1);
    expect(raw[0].status).toBe("approved");

    // reload from disk
    const q2 = new AuthQueue(path);
    expect(q2.list().length).toBe(1);
    expect(q2.list()[0].status).toBe("approved");
  });
});

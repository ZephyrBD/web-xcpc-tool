import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrintQueue } from "./queue";
import { setDataDir } from "../store/store";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "printqueue-"));
  setDataDir(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  setDataDir("");
});

describe("PrintQueue", () => {
  test("add creates a pending task with id and createdAt", () => {
    const q = new PrintQueue();
    const t = q.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "main.pdf",
      pdfPath: "pdf/x.pdf",
    });
    expect(t.status).toBe("pending");
    expect(t.id).toBeTruthy();
    expect(t.createdAt).toBeTruthy();
    expect(t.location).toBe("room1");
    expect(t.teamName).toBe("team-a");
    expect(t.teamId).toBe("42");
    expect(t.originalFilename).toBe("main.pdf");
    expect(t.pdfPath).toBe("pdf/x.pdf");
  });

  test("ack transitions pending task, default is printed, unknown id returns null", () => {
    const q = new PrintQueue();
    const t = q.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "main.pdf",
      pdfPath: "pdf/x.pdf",
    });
    const acked = q.ack(t.id);
    expect(acked?.status).toBe("printed");
    expect(q.ack("nope")).toBeNull();

    const t2 = q.add({
      location: "room2",
      teamName: "team-b",
      teamId: "43",
      originalFilename: "b.pdf",
      pdfPath: "pdf/y.pdf",
    });
    expect(q.ack(t2.id, "failed")?.status).toBe("failed");
  });

  test("ack only transitions pending tasks", () => {
    const q = new PrintQueue();
    const t = q.add({
      location: "room1",
      teamName: "team-a",
      teamId: "42",
      originalFilename: "main.pdf",
      pdfPath: "pdf/x.pdf",
    });
    q.ack(t.id);
    expect(q.ack(t.id)).toBeNull();
    expect(q.list("printed").length).toBe(1);
  });

  test("list filters by status", () => {
    const q = new PrintQueue();
    const a = q.add({
      location: "r1",
      teamName: "a",
      teamId: "1",
      originalFilename: "a.pdf",
      pdfPath: "pdf/a.pdf",
    });
    q.add({
      location: "r2",
      teamName: "b",
      teamId: "2",
      originalFilename: "b.pdf",
      pdfPath: "pdf/b.pdf",
    });
    q.ack(a.id);
    expect(q.list("pending").length).toBe(1);
    expect(q.list("printed").length).toBe(1);
    expect(q.list().length).toBe(2);
  });

  test("onChange fires on mutations, unsubscribe stops it", () => {
    const q = new PrintQueue();
    const seen: string[] = [];
    const off = q.onChange((t) => seen.push(t.status));
    q.add({
      location: "r1",
      teamName: "a",
      teamId: "1",
      originalFilename: "a.pdf",
      pdfPath: "pdf/a.pdf",
    });
    off();
    q.add({
      location: "r2",
      teamName: "b",
      teamId: "2",
      originalFilename: "b.pdf",
      pdfPath: "pdf/b.pdf",
    });
    expect(seen).toEqual(["pending"]);
  });

  test("persists through JsonStore on mutations", () => {
    const q = new PrintQueue("print-tasks.json");
    const t = q.add({
      location: "r1",
      teamName: "a",
      teamId: "1",
      originalFilename: "a.pdf",
      pdfPath: "pdf/a.pdf",
    });
    q.ack(t.id);

    expect(existsSync(join(dataDir, "print-tasks.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dataDir, "print-tasks.json"), "utf8"));
    expect(raw.length).toBe(1);
    expect(raw[0].status).toBe("printed");

    const q2 = new PrintQueue("print-tasks.json");
    expect(q2.list().length).toBe(1);
    expect(q2.list()[0].status).toBe("printed");
  });
});

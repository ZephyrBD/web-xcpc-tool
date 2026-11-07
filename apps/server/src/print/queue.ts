import { randomUUID } from "node:crypto";
import { JsonStore } from "../store/store";

export type PrintTaskStatus = "pending" | "printed" | "failed";

export type PrintTask = {
  id: string;
  location: string;
  teamName: string;
  teamId: string;
  originalFilename: string;
  status: PrintTaskStatus;
  pdfPath: string;
  createdAt: string;
};

export class PrintQueue {
  private readonly store: JsonStore<PrintTask[]>;
  private readonly listeners: Array<(t: PrintTask) => void> = [];

  constructor(filePath = "print-tasks.json") {
    this.store = new JsonStore<PrintTask[]>(filePath, []);
  }

  add(t: Omit<PrintTask, "id" | "status" | "createdAt">): PrintTask {
    const task: PrintTask = {
      ...t,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.store.update((cur) => [...cur, task]);
    this.notify(task);
    return task;
  }

  ack(id: string, status: "printed" | "failed" = "printed"): PrintTask | null {
    let updated: PrintTask | null = null;
    this.store.update((cur) =>
      cur.map((t) => {
        if (t.id !== id || t.status !== "pending") return t;
        updated = { ...t, status };
        return updated;
      }),
    );
    if (!updated) return null;
    this.notify(updated);
    return updated;
  }

  list(status?: PrintTaskStatus): PrintTask[] {
    const all = this.store.load();
    return status ? all.filter((t) => t.status === status) : all;
  }

  onChange(cb: (t: PrintTask) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(t: PrintTask): void {
    for (const cb of this.listeners) cb(t);
  }
}

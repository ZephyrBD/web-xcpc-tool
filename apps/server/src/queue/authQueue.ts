import { randomUUID } from "node:crypto";
import { JsonStore } from "../store/store";

export type AuthTaskStatus = "pending" | "approved" | "rejected" | "auto-done";

export type AuthTask = {
  id: string;
  examNum: string;
  clientId: string | null;
  strategy: string;
  status: AuthTaskStatus;
  createdAt: string;
};

export class AuthQueue {
  autoAccept = false;
  private readonly store: JsonStore<AuthTask[]>;
  private readonly listeners: Array<(t: AuthTask) => void> = [];

  constructor(filePath = "auth-tasks.json") {
    this.store = new JsonStore<AuthTask[]>(filePath, []);
  }

  enqueue(t: Omit<AuthTask, "id" | "status" | "createdAt">): AuthTask {
    const existing = this.store
      .load()
      .find(
        (x) =>
          x.status === "pending" &&
          x.examNum === t.examNum &&
          x.clientId === t.clientId,
      );
    if (existing) return existing;

    const task: AuthTask = {
      ...t,
      id: randomUUID(),
      status: this.autoAccept ? "auto-done" : "pending",
      createdAt: new Date().toISOString(),
    };
    this.store.update((cur) => [...cur, task]);
    this.notify(task);
    return task;
  }

  approve(id: string): AuthTask | null {
    return this.transition(id, "approved");
  }

  reject(id: string): AuthTask | null {
    return this.transition(id, "rejected");
  }

  list(status?: AuthTaskStatus): AuthTask[] {
    const all = this.store.load();
    return status ? all.filter((t) => t.status === status) : all;
  }

  onChange(cb: (t: AuthTask) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private transition(id: string, status: AuthTaskStatus): AuthTask | null {
    let updated: AuthTask | null = null;
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

  private notify(t: AuthTask): void {
    for (const cb of this.listeners) cb(t);
  }
}

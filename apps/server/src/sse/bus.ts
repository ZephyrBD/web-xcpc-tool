export type SseEvent = { event: string; data: unknown };

export class SseBus {
  private readonly channels = new Map<string, Array<(e: SseEvent) => void>>();

  publish(channel: string, event: string, data: unknown): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    for (const cb of subs) cb({ event, data });
  }

  subscribe(channel: string, cb: (e: SseEvent) => void): () => void {
    const subs = this.channels.get(channel) ?? [];
    subs.push(cb);
    this.channels.set(channel, subs);
    return () => {
      const list = this.channels.get(channel);
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }
}

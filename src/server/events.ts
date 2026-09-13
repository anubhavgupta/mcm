import type { Response } from 'express';
import type { ManagerEvent, ServerStatus, Throughput, UsageSummary } from '../shared/types';

export class Events {
  private latestThroughput?: Throughput;
  private sequence = 0;
  private history: { id: number; event: ManagerEvent }[] = [];
  private clients = new Set<Response>();
  private timers = new Map<Response, ReturnType<typeof setInterval>>();
  constructor(private redact: (text: string) => string = text => text) {}
  emit(event: ManagerEvent): void {
    const safe = JSON.parse(JSON.stringify(event), (_key, value: unknown) => typeof value === 'string' ? this.redact(value) : value) as ManagerEvent;
    if (safe.type === 'throughput') this.latestThroughput = safe.data;
    if (safe.type === 'status' && (safe.data.phase === 'starting' || safe.data.phase === 'stopped')) this.latestThroughput = undefined;
    const entry = { id: ++this.sequence, event: safe };
    this.history.push(entry);
    if (this.history.length > 500) this.history.shift();
    for (const client of this.clients) this.write(client, entry.id, entry.event);
  }
  log(text: string, stream: 'stdout' | 'stderr' | 'manager' = 'manager'): void {
    this.emit({ type: 'log', data: { timestamp: new Date().toISOString(), stream, text: text.slice(0, 16384) } });
  }
  private write(response: Response, id: number, event: ManagerEvent): void {
    if (response.writableLength > 256 * 1024) { response.destroy(); return; }
    response.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  connect(response: Response, status: ServerStatus, lastId?: string, usage?: UsageSummary): void {
    response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const cursor = lastId && /^\d+$/.test(lastId) ? Number(lastId) : undefined;
    for (const entry of this.history) {
      if (cursor !== undefined ? entry.id > cursor : entry.event.type === 'log') this.write(response, entry.id, entry.event);
    }
    response.write(`data: ${JSON.stringify({ type: 'status', data: status })}\n\n`);
    if (this.latestThroughput) response.write(`data: ${JSON.stringify({ type: 'throughput', data: this.latestThroughput })}\n\n`);
    if (usage) response.write(`data: ${JSON.stringify({ type: 'usage', data: usage })}\n\n`);
    this.clients.add(response);
    const timer = setInterval(() => {
      if (response.writableLength > 256 * 1024) response.destroy();
      else response.write(': heartbeat\n\n');
    }, 15000);
    timer.unref();
    this.timers.set(response, timer);
    response.on('close', () => {
      this.clients.delete(response);
      clearInterval(timer);
      this.timers.delete(response);
    });
  }
  close(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.timers.clear();
  }
}

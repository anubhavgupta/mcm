import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { Events } from './events';

class FakeResponse extends EventEmitter {
  text = '';
  writableLength = 0;
  ended = false;
  destroyed = false;
  status(): this { return this; }
  set(): this { return this; }
  flushHeaders(): void {}
  write(text: string): boolean { this.text += text; return true; }
  end(): void { this.ended = true; this.emit('close'); }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

describe('bounded SSE event delivery', () => {
  it('heartbeats, bounded replay, and shutdown cleanup work without retaining disconnected clients', () => {
    vi.useFakeTimers();
    try {
      const events = new Events();
      for (let i = 0; i < 600; i++) events.log(`line-${i}`);
      const response = new FakeResponse();
      events.connect(response as unknown as Response, { phase: 'stopped' });
      expect(response.text).not.toContain('"line-0"');
      expect(response.text).toContain('"line-599"');
      vi.advanceTimersByTime(15000);
      expect(response.text).toContain(': heartbeat');
      events.close();
      expect(response.ended).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('disconnects backpressured event consumers and redacts token characters safely', () => {
    const token = 'hf_"quoted"';
    const events = new Events(text => text.split(token).join('[REDACTED]'));
    const response = new FakeResponse();
    events.connect(response as unknown as Response, { phase: 'stopped' });
    events.log(`secret: ${token}`);
    expect(response.text).toContain('[REDACTED]');
    expect(response.text).not.toContain('quoted');
    response.writableLength = 300 * 1024;
    events.log('too slow');
    expect(response.destroyed).toBe(true);
    events.close();
  });
});

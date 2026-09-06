import type { Throughput } from '../shared/types';
import { Events } from './events';

export interface RequestContext {
  requestId: string;
  protocol: 'openai' | 'anthropic';
  method: string;
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  signal: AbortSignal;
}
export interface ResponseContext {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
export interface OutboundRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Undefined preserves the original request stream; setting this deliberately replaces it. */
  body?: string | Uint8Array;
  /** Opt-in original-body buffering, limited to 2 MiB. Unchanged bytes are replayed if body is not replaced. */
  readBody(): Promise<Uint8Array>;
}

/** Only beforeRequest mutates traffic; observation hooks receive copies of stream chunks. */
export interface Interceptor {
  beforeRequest?(context: RequestContext, outbound: OutboundRequest): void | Promise<void>;
  onRequest?(context: RequestContext): void | Promise<void>;
  onRequestChunk?(context: RequestContext, chunk: Uint8Array): void | Promise<void>;
  onResponse?(context: RequestContext, response: ResponseContext): void | Promise<void>;
  onResponseChunk?(context: RequestContext, chunk: Uint8Array): void | Promise<void>;
  onComplete?(context: RequestContext): void | Promise<void>;
  onError?(context: RequestContext, error: Error): void | Promise<void>;
}

/** Incremental UTF-8/SSE parser. Oversized events are skipped, not partially interpreted. */
export class SseParser {
  private decoder = new TextDecoder();
  private line = '';
  private data: string[] = [];
  private size = 0;
  private dropping = false;
  private previousCR = false;
  constructor(private onData: (data: string) => void, private maxBytes = 256 * 1024) {}
  push(chunk: Uint8Array): void { this.consume(this.decoder.decode(chunk, { stream: true })); }
  finish(): void {
    this.consume(this.decoder.decode());
    if (this.line) this.endLine();
    this.dispatch();
  }
  private consume(text: string): void {
    for (const character of text) {
      if (character === '\n' && this.previousCR) { this.previousCR = false; continue; }
      this.previousCR = character === '\r';
      if (character === '\n' || character === '\r') this.endLine();
      else {
        this.size += character.length * 3;
        if (this.size > this.maxBytes) { this.dropping = true; this.data = []; this.line = ''; }
        if (!this.dropping) this.line += character;
        else this.line = '!';
      }
    }
  }
  private endLine(): void {
    if (!this.line) this.dispatch();
    else if (!this.dropping && (this.line === 'data' || this.line.startsWith('data:'))) {
      this.data.push(this.line === 'data' ? '' : this.line.slice(5).replace(/^ /, ''));
    }
    this.line = '';
  }
  private dispatch(): void {
    if (!this.dropping && this.data.length) this.onData(this.data.join('\n'));
    this.data = [];
    this.size = 0;
    this.dropping = false;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function tokenCount(value: unknown): number | null {
  const count = nonnegative(value);
  return count !== null && Number.isInteger(count) ? count : null;
}

export function nativeTimings(value: unknown): Partial<Throughput> | undefined {
  const body = record(value);
  const timings = record(body?.timings) ?? record(record(body?.message)?.timings);
  const usage = record(body?.usage) ?? record(record(body?.message)?.usage);
  const inputTokens = tokenCount(timings?.prompt_n) ?? tokenCount(usage?.prompt_tokens) ?? tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(timings?.predicted_n) ?? tokenCount(usage?.completion_tokens) ?? tokenCount(usage?.output_tokens);
  if (!timings) {
    if (inputTokens === null && outputTokens === null) return undefined;
    return {
      ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}),
    };
  }
  const pp = nonnegative(timings.prompt_per_second);
  const tg = nonnegative(timings.predicted_per_second);
  return {
    pp, tg, inputTokens, outputTokens,
    source: pp !== null || tg !== null ? 'llama.cpp' : 'unavailable',
  };
}

export function parsePrometheus(text: string): { pp: number | null; tg: number | null } {
  const rates = { pp: null as number | null, tg: null as number | null };
  for (const line of text.split('\n')) {
    const match = /^(llamacpp:(?:prompt|predicted)_tokens_seconds)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\S+)?\s*$/.exec(line);
    if (!match) continue;
    const rate = nonnegative(Number(match[2]));
    if (rate !== null) rates[match[1]!.includes(':prompt_') ? 'pp' : 'tg'] = rate;
  }
  return rates;
}

interface Observation {
  throughput: Throughput;
  parser?: SseParser;
  chunks: Uint8Array[];
  bytes: number;
  json: boolean;
}

export class ThroughputInterceptor implements Interceptor {
  private observations = new Map<string, Observation>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private controller = new AbortController();
  constructor(private events: Events, private upstream: () => string, private fetcher: typeof fetch = fetch, private pollMs = 1000) {}
  onRequest(context: RequestContext): void {
    const observation: Observation = {
      throughput: { requestId: context.requestId, protocol: context.protocol, pp: null, tg: null, inputTokens: null, outputTokens: null, source: 'unavailable', active: true },
      chunks: [], bytes: 0, json: false,
    };
    this.observations.set(context.requestId, observation);
    this.emit(observation);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
      this.timer.unref();
    }
  }
  onResponse(context: RequestContext, response: ResponseContext): void {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType.includes('text/event-stream')) {
      observation.parser = new SseParser(data => this.parse(observation, data));
    } else observation.json = contentType.includes('json');
  }
  onResponseChunk(context: RequestContext, chunk: Uint8Array): void {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    if (observation.parser) observation.parser.push(chunk);
    else if (observation.json) {
      observation.bytes += chunk.byteLength;
      if (observation.bytes <= 1024 * 1024) observation.chunks.push(chunk.slice());
      else observation.chunks = [];
    }
  }
  onComplete(context: RequestContext): void { this.finish(context); }
  onError(context: RequestContext): void { this.finish(context); }
  private parse(observation: Observation, text: string): void {
    try {
      const timings = nativeTimings(JSON.parse(text));
      if (timings) {
        Object.assign(observation.throughput, timings, timings.source ? { measurement: 'timings' } : {});
        this.emit(observation);
      }
    } catch { /* SSE keepalives, [DONE], and non-JSON content are not measurements. */ }
  }
  private emit(observation: Observation): void {
    this.events.emit({ type: 'throughput', data: { ...observation.throughput } });
  }
  private finish(context: RequestContext): void {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    observation.parser?.finish();
    if (observation.json && observation.bytes <= 1024 * 1024) {
      this.parse(observation, Buffer.concat(observation.chunks).toString('utf8'));
    }
    observation.throughput.active = false;
    this.emit(observation);
    this.observations.delete(context.requestId);
    if (!this.observations.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  private async poll(): Promise<void> {
    if (this.polling || !this.observations.size) return;
    this.polling = true;
    try {
      const response = await this.fetcher(new URL('/metrics', this.upstream()), {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(1500)]), redirect: 'error',
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const reader = response.body?.getReader();
      if (!reader) return;
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 256 * 1024) { await reader.cancel(); return; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const rates = parsePrometheus(Buffer.concat(chunks).toString('utf8'));
      if (rates.pp === null && rates.tg === null) return;
      for (const observation of this.observations.values()) {
        Object.assign(observation.throughput, rates, { source: 'llama.cpp', measurement: 'prometheus' });
        this.emit(observation);
      }
    } catch { /* Unsupported metrics endpoints leave measurements unavailable. */ }
    finally { this.polling = false; }
  }
  close(): void {
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.observations.clear();
  }
}

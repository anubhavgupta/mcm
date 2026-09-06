import { describe, expect, it, vi } from 'vitest';
import { Events } from './events';
import { nativeTimings, parsePrometheus, SseParser, ThroughputInterceptor, type RequestContext } from './interceptors';
import type { ManagerEvent } from '../shared/types';

const context: RequestContext = { requestId: 'one', protocol: 'anthropic', method: 'POST', path: '/v1/messages', headers: {}, signal: new AbortController().signal };
describe('bounded native timing observation', () => {
  it('handles arbitrary UTF-8, LF, CRLF, and CR boundaries including multiline SSE', () => {
    const values: string[] = [];
    const parser = new SseParser(value => values.push(value));
    const bytes = new TextEncoder().encode(': comment\r\ndata: {"text":"😊"}\r\n\r\ndata: a\rdata: b\r\rdata: final\n\n');
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    parser.finish();
    expect(values).toEqual(['{"text":"😊"}', 'a\nb', 'final']);
  });
  it('discards oversized events and resumes at the next boundary', () => {
    const values: string[] = [];
    const parser = new SseParser(value => values.push(value), 60);
    parser.push(new TextEncoder().encode(`data: ${'x'.repeat(1000)}\n\ndata: valid\n\n`));
    parser.finish();
    expect(values).toEqual(['valid']);
  });
  it('uses only llama.cpp native rates and token counts', () => {
    expect(nativeTimings({ usage: { prompt_tokens: 4, completion_tokens: 7 } })).toEqual({ inputTokens: 4, outputTokens: 7 });
    expect(nativeTimings({ timings: { prompt_per_second: 44, predicted_per_second: 22, prompt_n: 10, predicted_n: 8 } })).toEqual({
      pp: 44, tg: 22, inputTokens: 10, outputTokens: 8, source: 'llama.cpp',
    });
    expect(nativeTimings({ timings: { predicted_per_second: -1, prompt_per_second: Infinity } })).toMatchObject({ pp: null, tg: null, source: 'unavailable' });
    expect(parsePrometheus('# HELP anything\nllamacpp:prompt_tokens_seconds 45.3\nllamacpp:predicted_tokens_seconds{slot="0"} 2.1e1\nllamacpp:tokens_predicted_total 999'))
      .toEqual({ pp: 45.3, tg: 21 });
    expect(parsePrometheus('llamacpp:predicted_tokens_seconds NaN')).toEqual({ pp: null, tg: null });
  });
  it('never counts SSE chunks as tokens and observes JSON timings without translation', () => {
    const events = new Events();
    const emit = vi.spyOn(events, 'emit');
    const observer = new ThroughputInterceptor(events, () => 'http://127.0.0.1:1');
    observer.onRequest(context);
    observer.onResponse(context, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    observer.onResponseChunk(context, Buffer.from('data: {"delta":{"text":"hello"}}\n\ndata: [DONE]\n\n'));
    observer.onComplete(context);
    const last = emit.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ type: 'throughput', data: { pp: null, tg: null, inputTokens: null, outputTokens: null, active: false, source: 'unavailable' } });
    observer.onRequest(context);
    observer.onResponse(context, { status: 200, headers: { 'content-type': 'application/json' } });
    observer.onResponseChunk(context, Buffer.from('{"timings":{"predicted_per_second":12,"predicted_n":3}}'));
    observer.onComplete(context);
    expect(emit.mock.calls.at(-1)![0]).toMatchObject({ data: { pp: null, tg: 12, outputTokens: 3, measurement: 'timings', active: false } });
    observer.close();
  });
  it('polls native Prometheus gauges while requests are active', async () => {
    const events = new Events();
    const seen: ManagerEvent[] = [];
    vi.spyOn(events, 'emit').mockImplementation(event => { seen.push(event); });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('llamacpp:predicted_tokens_seconds 33\n'));
    const observer = new ThroughputInterceptor(events, () => 'http://localhost:8080', fetcher, 10);
    observer.onRequest(context);
    await vi.waitFor(() => expect(seen.some(event => event.type === 'throughput' && event.data.tg === 33)).toBe(true));
    expect(seen.at(-1)).toMatchObject({ data: { pp: null, tg: 33, measurement: 'prometheus', source: 'llama.cpp', inputTokens: null, outputTokens: null } });
    observer.onComplete(context);
    observer.close();
  });
});

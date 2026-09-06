import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { Interceptor, OutboundRequest, RequestContext, ResponseContext } from './interceptors';
import { Events } from './events';

const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection',
]);
export function filteredHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const excluded = new Set(hopHeaders);
  for (const value of String(headers.connection ?? '').split(',')) excluded.add(value.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}

export class ProxyService {
  private pending = new Set<AbortController>();
  private completions = new Set<Promise<void>>();
  private closing = false;
  constructor(private upstream: () => string, private interceptors: Interceptor[], private events: Events) {}
  private async observe<K extends keyof Interceptor>(hook: K, ...args: Parameters<NonNullable<Interceptor[K]>>): Promise<void> {
    for (const interceptor of this.interceptors) {
      try {
        const fn = interceptor[hook] as ((...args: unknown[]) => void | Promise<void>) | undefined;
        if (fn) await fn.apply(interceptor, args);
      } catch {
        this.events.log(`Interceptor ${hook} failed; protocol passthrough continues.`);
      }
    }
  }
  async handle(request: Request, response: Response): Promise<void> {
    if (this.closing) {
      response.status(503).json({ error: 'Manager is shutting down.' });
      return;
    }
    const controller = new AbortController();
    this.pending.add(controller);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    this.completions.add(completion);
    let completed = false;
    let preparing = false;
    const original = new URL(request.originalUrl, 'http://localhost');
    const context: RequestContext = {
      requestId: randomUUID(), protocol: original.pathname === '/v1/messages' || original.pathname.startsWith('/v1/messages/') ? 'anthropic' : 'openai',
      method: request.method, path: request.originalUrl, headers: { ...request.headers }, signal: controller.signal,
    };
    const cancel = (): void => { if (!completed && !response.writableFinished) controller.abort(); };
    request.once('aborted', cancel);
    response.once('close', cancel);
    await this.observe('onRequest', context);
    try {
      const target = new URL(this.upstream());
      target.pathname = original.pathname;
      target.search = original.search;
      let originalBody: Buffer | undefined;
      let readingBody: Promise<Buffer> | undefined;
      const outbound: OutboundRequest = {
        headers: { ...request.headers },
        readBody: async () => {
          readingBody ??= (async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const value of request.iterator({ destroyOnReturn: false })) {
              const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
              size += chunk.byteLength;
              if (size > 2 * 1024 * 1024) throw new Error('Interceptor request-body read exceeded 2 MiB.');
              chunks.push(chunk);
            }
            originalBody = Buffer.concat(chunks);
            return originalBody;
          })();
          return new Uint8Array(await readingBody);
        },
      };
      for (const interceptor of this.interceptors) {
        if (!interceptor.beforeRequest) continue;
        preparing = true;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        let abort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('Request interceptor aborted or timed out.'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        try { await Promise.race([interceptor.beforeRequest(context, outbound), aborted]); }
        finally { signal.removeEventListener('abort', abort); }
      }
      if (readingBody) await readingBody;
      preparing = false;
      const headers = filteredHeaders(Object.fromEntries(Object.entries(outbound.headers).map(([key, value]) => [key.toLowerCase(), value])));
      headers.host = target.host;
      // MCM owns proxy CORS; upstream credentials and protocol-specific headers pass through.
      delete headers.origin;
      const body = outbound.body !== undefined ? Buffer.from(outbound.body) : originalBody;
      if (body !== undefined) {
        headers['content-length'] = String(body.byteLength);
        if (outbound.body !== undefined) delete headers['content-encoding'];
        if (originalBody === undefined) request.resume();
      }
      await this.observe('onOutboundRequest', context, Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]),
      ));
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: request.method, headers, signal: controller.signal,
      });
      const timeout = setTimeout(() => upstream.destroy(new Error('Upstream response headers timed out.')), 30000);
      timeout.unref();
      upstream.once('close', () => clearTimeout(timeout));
      const incomingPromise = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        upstream.once('response', incoming => { clearTimeout(timeout); resolve(incoming); });
        upstream.once('error', reject);
      });
      const observer = new Transform({
        transform: (chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) => {
          this.observe('onRequestChunk', context, new Uint8Array(chunk)).then(() => callback(null, chunk), callback);
        },
        flush: (callback: TransformCallback) => {
          this.observe('onRequestEnd', context).then(() => callback(), callback);
        },
      });
      const requestPiping = pipeline(body !== undefined ? Readable.from([body]) : request, observer, upstream).catch(error => {
        controller.abort();
        throw error;
      });
      // Handle upload errors immediately while waiting for response headers.
      void requestPiping.catch(() => {});
      const incoming = await incomingPromise;
      const responseHeaders = filteredHeaders(incoming.headers);
      for (const key of Object.keys(responseHeaders)) {
        if (key.startsWith('access-control-')) delete responseHeaders[key];
      }
      response.status(incoming.statusCode ?? 502);
      for (const [name, value] of Object.entries(responseHeaders)) if (value !== undefined) response.setHeader(name, value);
      const responseContext: ResponseContext = { status: incoming.statusCode ?? 502, headers: incoming.headers };
      await this.observe('onResponse', context, responseContext);
      response.flushHeaders();
      const responseObserver = new Transform({
        transform: (chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) => {
          this.observe('onResponseChunk', context, new Uint8Array(chunk)).then(() => callback(null, chunk), callback);
        },
      });
      await pipeline(incoming, responseObserver, response, { signal: controller.signal });
      completed = true;
      await requestPiping;
      await this.observe('onComplete', context);
    } catch (error) {
      controller.abort();
      request.resume();
      await this.observe('onError', context, error instanceof Error ? error : new Error('Proxy failed.'));
      if (!response.headersSent && !response.destroyed) {
        response.status(502).json({ error: preparing
          ? 'Request interceptor preparation failed. Body reads are limited to 2 MiB; check trusted interceptor configuration.'
          : 'Upstream request failed. Check the server status and upstream URL.' });
      } else if (!response.writableEnded) response.destroy();
    } finally {
      completed = true;
      request.removeListener('aborted', cancel);
      response.removeListener('close', cancel);
      this.pending.delete(controller);
      this.completions.delete(completion);
      resolveCompletion();
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.pending) controller.abort();
    await Promise.all(this.completions);
  }
}

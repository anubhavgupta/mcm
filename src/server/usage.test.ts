import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { emptyWorkspace } from '../shared/config';
import { emptyUsageTotals } from '../shared/usage';
import type { ModelConfig, ModelPricing } from '../shared/types';
import { Events } from './events';
import type { RequestContext } from './interceptors';
import { Store } from './storage';
import { UsageInterceptor, UsageStore } from './usage';

let directory: string;
let usage: UsageStore;
let events: Events;
let workspaceStore: Store;
const pricing = { inputUsdPerMillion: 2, outputUsdPerMillion: 4 };
const model: ModelConfig = { id: 'one', name: 'One', model: { filename: 'one.gguf', repo: 'owner/one' }, values: {}, pricing };
const context: RequestContext = {
  requestId: 'one', protocol: 'openai', method: 'POST', path: '/v1/chat/completions', headers: {}, signal: new AbortController().signal,
};
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  workspaceStore = new Store(directory);
  await workspaceStore.init();
  events = new Events();
  usage = new UsageStore(directory, events);
  await usage.init();
});
afterEach(async () => {
  events.close();
  await rm(directory, { recursive: true, force: true });
});

describe('durable cumulative accounting', () => {
  it('serializes concurrent completions, reopens all-time history and resets only the session', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      usage.record({ inputTokens: index, outputTokens: 2, pricing })));
    await usage.close();
    const prior = usage.getSummary();
    expect(prior.allTime).toEqual(prior.session);
    expect(prior.allTime).toMatchObject({ inputTokens: 190, outputTokens: 40, requestCount: 20, unpricedTokens: 0, missingUsageRequests: 0 });
    expect(prior.allTime.costUsd).toBeCloseTo(0.00054);
    const reopened = new UsageStore(directory, events);
    await reopened.init();
    expect(reopened.getSummary()).toMatchObject({ allTime: prior.allTime, session: emptyUsageTotals(), trackingStartedAt: prior.trackingStartedAt });
    expect(reopened.getSummary().sessionId).not.toBe(prior.sessionId);
    await reopened.record({ inputTokens: 3, outputTokens: 1, pricing });
    expect(reopened.getSummary().allTime.requestCount).toBe(21);
    expect(reopened.getSummary().session.requestCount).toBe(1);
    expect((await stat(join(directory, 'usage.json'))).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'));
    expect(persisted).toEqual({ version: 1, trackingStartedAt: prior.trackingStartedAt, allTime: reopened.getSummary().allTime });
  });
  it('separates unknown pricing, explicitly free usage, partial usage and historical prices', async () => {
    await usage.record({ inputTokens: 8, outputTokens: 2 });
    expect(usage.getSummary().allTime).toMatchObject({ costUsd: null, unpricedTokens: 10 });
    await usage.record({ inputTokens: 0, outputTokens: 0, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } });
    expect(usage.getSummary().allTime.costUsd).toBe(0);
    await usage.record({ inputTokens: 1000000, outputTokens: null, pricing });
    await usage.record({ inputTokens: null, outputTokens: 1000000, pricing: { inputUsdPerMillion: 9, outputUsdPerMillion: 7 } });
    await usage.record({ inputTokens: null, outputTokens: null });
    expect(usage.getSummary().allTime).toEqual({
      inputTokens: 1000008, outputTokens: 1000002, costUsd: 9, requestCount: 5, unpricedTokens: 10, missingUsageRequests: 3,
    });
  });
  it('never includes history in portable workspaces or settings, and imports/deletes preserve it', async () => {
    await usage.record({ inputTokens: 7, outputTokens: 9, pricing });
    await workspaceStore.saveWorkspace({ ...emptyWorkspace(), models: [model] });
    await workspaceStore.saveSettings({ hfRepo: 'owner/config' });
    await workspaceStore.saveWorkspace(emptyWorkspace());
    for (const name of ['workspace.json', 'settings.json']) {
      expect(await readFile(join(directory, name), 'utf8')).not.toMatch(/allTime|sessionId|inputTokens|costUsd|requestCount/);
    }
    const reopened = new UsageStore(directory, events);
    await reopened.init();
    expect(reopened.getSummary().allTime.requestCount).toBe(1);
  });
  it('rejects corrupt history rather than resetting it', async () => {
    await writeFile(join(directory, 'usage.json'), '{"invalid":true}');
    await expect(new UsageStore(directory, events).init()).rejects.toThrow('Cannot load usage.json');
  });
  it('surfaces write failures, rejects flush, and retains unsaved observations for the next successful write', async () => {
    const emitted = vi.spyOn(events, 'emit');
    await rm(join(directory, 'usage.json'));
    await mkdir(join(directory, 'usage.json'));
    await expect(usage.record({ inputTokens: 8, outputTokens: 2, pricing })).rejects.toThrow();
    expect(usage.getSummary().error).toContain('could not be saved');
    expect(emitted.mock.calls.some(([event]) => event.type === 'log')).toBe(true);
    expect(emitted.mock.calls.some(([event]) => event.type === 'usage' && event.data.error)).toBe(true);
    await expect(usage.close()).rejects.toThrow('could not be saved');
    await rm(join(directory, 'usage.json'), { recursive: true });
    await usage.record({ inputTokens: 3, outputTokens: 1, pricing });
    await usage.close();
    expect(usage.getSummary().error).toBeUndefined();
    const reopened = new UsageStore(directory, events);
    await reopened.init();
    expect(reopened.getSummary().allTime).toMatchObject({ inputTokens: 11, outputTokens: 3, requestCount: 2 });
  });
});

describe('reported request token observation', () => {
  function start(options: { models?: ModelConfig[]; managedModelId?: string; basePricing?: ModelPricing; ctx?: RequestContext; streaming?: boolean; requestModel?: string } = {}) {
    const ctx = options.ctx ?? context;
    const observer = new UsageInterceptor(usage, () => ({
      models: options.models ?? [structuredClone(model)], managedModelId: options.managedModelId,
      basePricing: options.basePricing,
    }));
    observer.onRequest(ctx);
    observer.onOutboundRequest(ctx, {});
    observer.onRequestChunk(ctx, Buffer.from(JSON.stringify({ model: options.requestModel ?? 'one' })));
    observer.onRequestEnd(ctx);
    observer.onResponse(ctx, { status: 200, headers: { 'content-type': options.streaming ? 'text/event-stream' : 'application/json' } });
    const send = (body: unknown) => observer.onResponseChunk(ctx, Buffer.from(options.streaming ? `data: ${JSON.stringify(body)}\n\n` : JSON.stringify(body)));
    return { observer, send, finish: () => observer.onComplete(ctx) };
  }
  it.each([
    { usage: { prompt_tokens: 8, completion_tokens: 4 } },
    { usage: { input_tokens: 8, output_tokens: 4 } },
    { response: { usage: { input_tokens: 8, output_tokens: 4 } } },
    { message: { usage: { input_tokens: 8, output_tokens: 4 } } },
    { timings: { prompt_n: 8, predicted_n: 4, predicted_per_second: 999 } },
  ])('reads complete nonstream JSON and nested Responses/message usage %#', async payload => {
    const { send, finish } = start();
    send(payload);
    await finish();
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 8, outputTokens: 4, requestCount: 1, missingUsageRequests: 0, unpricedTokens: 0 });
    expect(usage.getSummary().session.costUsd).toBeCloseTo(0.000032);
  });
  it('updates both totals before stream completion and commits each concurrent contribution exactly once', async () => {
    const first = start({ streaming: true });
    const secondContext = { ...context, requestId: 'two' };
    const second = start({ streaming: true, ctx: secondContext });
    first.send({ usage: { prompt_tokens: 4, completion_tokens: 2 } });
    second.send({ usage: { prompt_tokens: 3, completion_tokens: 1 } });
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 7, outputTokens: 3, requestCount: 2, missingUsageRequests: 0 });
    first.send({ usage: { completion_tokens: 5 } });
    first.send({ usage: { completion_tokens: 5 } });
    expect(usage.getSummary().allTime).toMatchObject({ inputTokens: 7, outputTokens: 6, requestCount: 2 });
    const beforeCommit = usage.getSummary();
    await first.finish();
    expect(usage.getSummary()).toEqual(beforeCommit);
    const persisted = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'));
    expect(persisted.allTime).toMatchObject({ inputTokens: 4, outputTokens: 5, requestCount: 1 });
    await second.observer.onError(secondContext);
    expect(usage.getSummary().allTime).toMatchObject({ inputTokens: 7, outputTokens: 6, requestCount: 2, missingUsageRequests: 1 });
    await second.finish();
    expect(usage.getSummary().allTime.requestCount).toBe(2);
  });
  it('does not mark a still-running partial usage report as an incomplete request', async () => {
    const current = start({ streaming: true });
    current.send({ usage: { prompt_tokens: 8 } });
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 8, outputTokens: 0, requestCount: 1, missingUsageRequests: 0 });
    await current.finish();
    expect(usage.getSummary().session.missingUsageRequests).toBe(1);
  });
  it('retains cumulative maxima rather than summing repeats, and never lets zero placeholders erase totals', async () => {
    const { observer, send, finish } = start({ streaming: true });
    send({ usage: { prompt_tokens: 8, completion_tokens: 2 } });
    send({ usage: { prompt_tokens: 8, completion_tokens: 4 } });
    send({ usage: { prompt_tokens: 8, completion_tokens: 4 } });
    send({ usage: { prompt_tokens: 0, completion_tokens: 0 }, timings: { prompt_n: 0, predicted_n: 0 } });
    expect(usage.getSummary().session.requestCount).toBe(1);
    await finish();
    await finish();
    await observer.onError(context);
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 8, outputTokens: 4, requestCount: 1, missingUsageRequests: 0 });
  });
  it('adds Anthropic cache categories once across message_start and cumulative message_delta', async () => {
    const { send, finish } = start({ streaming: true, ctx: { ...context, protocol: 'anthropic', path: '/v1/messages' } });
    send({ type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 2 } } } });
    send({ type: 'message_delta', usage: { output_tokens: 4 } });
    send({ type: 'message_delta', usage: { output_tokens: 4 } });
    send({ type: 'message_stop' });
    await finish();
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 20, outputTokens: 4, requestCount: 1, missingUsageRequests: 0 });
    expect(usage.getSummary().session.costUsd).toBeCloseTo(0.000056);
  });
  it('retains received partial counts on cancellation and marks even fully reported failed requests incomplete', async () => {
    const { observer, send } = start({ streaming: true });
    send({ usage: { prompt_tokens: 8 } });
    await observer.onError(context);
    await observer.onComplete(context);
    const next = start({ streaming: true, ctx: { ...context, requestId: 'two', path: '/v1/responses' } });
    next.send({ type: 'response.incomplete', response: { usage: { input_tokens: 3, output_tokens: 2 } } });
    await next.finish();
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 11, outputTokens: 2, requestCount: 2, missingUsageRequests: 2 });
  });
  it('prefers explicit API usage over evaluated timings without adding OpenAI cache breakdowns twice', async () => {
    const { send, finish } = start();
    send({ usage: { prompt_tokens: 108, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 100 } }, timings: { prompt_n: 8, predicted_n: 6 } });
    await finish();
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 108, outputTokens: 4, missingUsageRequests: 0 });
  });
  it('treats explicit API zero as reported usage rather than replacing it with native timings', async () => {
    const { send, finish } = start();
    send({ usage: { input_tokens: 0, output_tokens: 0 }, timings: { prompt_n: 8, predicted_n: 4 } });
    await finish();
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0, missingUsageRequests: 0 });
  });
  it.each([0, 4])('uses timings after a streaming placeholder zero but honors late final API usage %i', async final => {
    const { send, finish } = start({ streaming: true });
    send({ choices: [{ delta: { role: 'assistant' } }], usage: { prompt_tokens: 8, completion_tokens: 0 } });
    send({ choices: [{ delta: { content: 'not a token count' } }], timings: { predicted_n: 3 } });
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 8, outputTokens: 3, requestCount: 1 });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 8, completion_tokens: final } });
    await finish();
    expect(usage.getSummary().session).toMatchObject({ inputTokens: 8, outputTokens: final, requestCount: 1 });
  });
  it.each(['one', 'One', 'one.gguf', 'owner/one'])('resolves unambiguous outbound model alias %s', async requestModel => {
    const { send, finish } = start({ requestModel });
    send({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await finish();
    expect(usage.getSummary().session.unpricedTokens).toBe(0);
    expect(usage.getSummary().session.costUsd).toBeCloseTo(0.000006);
  });
  it('uses default base values for unknown/ambiguous external models', async () => {
    for (const requestModel of ['unknown', 'one.gguf']) {
      const { send, finish } = start({ requestModel, models: [model, { ...model, id: 'two' }] });
      send({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
      await finish();
    }
    expect(usage.getSummary().session).toMatchObject({ unpricedTokens: 0, requestCount: 2 });
    expect(usage.getSummary().session.costUsd).toBeCloseTo(0.0000045, 10);
  });
  it('managed actual model wins over an arbitrary request.model; missing managed config never selects another', async () => {
    const { send, finish } = start({
      managedModelId: 'one', requestModel: 'two',
      models: [model, { ...model, id: 'two', pricing: { inputUsdPerMillion: 50, outputUsdPerMillion: 50 } }],
    });
    send({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    await finish();
    expect(usage.getSummary().session.costUsd).toBe(6);
    const next = start({ managedModelId: 'deleted', requestModel: 'one' });
    next.send({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await next.finish();
    expect(usage.getSummary().session.unpricedTokens).toBe(0);
  });
  it('uses configurable base pricing for unpriced models, preserving zero model overrides', async () => {
    const { pricing: _pricing, ...withoutPrice } = model;
    const basePricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 3 };
    const fallback = start({ models: [withoutPrice], managedModelId: withoutPrice.id, basePricing });
    fallback.send({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    await fallback.finish();
    expect(usage.getSummary().session.costUsd).toBe(4);
    const free = start({ models: [{ ...model, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }], basePricing });
    free.send({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    await free.finish();
    expect(usage.getSummary().session.costUsd).toBe(4);
    expect(usage.getSummary().session.unpricedTokens).toBe(0);
  });
  it('snapshots base pricing so edits affect only future requests', async () => {
    const basePricing = { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1 };
    const current = start({ models: [], basePricing });
    basePricing.inputUsdPerMillion = 100;
    current.send({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    await current.finish();
    expect(usage.getSummary().session.costUsd).toBe(1.5);
  });
  it('snapshots pricing at outbound request time before edits, including explicitly free pricing', async () => {
    const models = [structuredClone(model)];
    const first = start({ models, streaming: true });
    models[0]!.pricing = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    first.send({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    await first.finish();
    const second = start({ models });
    second.send({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    await second.finish();
    expect(usage.getSummary().session).toMatchObject({ costUsd: 6, unpricedTokens: 0, requestCount: 2 });
  });
  it('does not count discovery, health, content deltas or server rates as token usage', async () => {
    const observer = new UsageInterceptor(usage, () => ({ models: [model] }));
    for (const path of ['/v1/models', '/health']) {
      const ctx = { ...context, method: 'GET', path };
      observer.onRequest(ctx);
      await observer.onComplete(ctx);
    }
    expect(usage.getSummary().session.requestCount).toBe(0);
    const next = start({ streaming: true });
    next.send({ delta: { text: 'hello' }, timings: { prompt_per_second: 80, predicted_per_second: 40 } });
    await next.finish();
    expect(usage.getSummary().session).toEqual({ ...emptyUsageTotals(), requestCount: 1, missingUsageRequests: 1 });
  });
  it('bounds optional request/response observation without rejecting protocol bytes', async () => {
    const observer = new UsageInterceptor(usage, () => ({ models: [model] }));
    observer.onRequest(context);
    observer.onOutboundRequest(context, {});
    observer.onRequestChunk(context, Buffer.from(JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024), model: 'one' })));
    observer.onRequestEnd(context);
    observer.onResponse(context, { status: 200, headers: { 'content-type': 'application/json' } });
    observer.onResponseChunk(context, Buffer.from(JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024), usage: { prompt_tokens: 4, completion_tokens: 2 } })));
    await observer.onComplete(context);
    expect(usage.getSummary().session).toEqual({ ...emptyUsageTotals(), requestCount: 1, missingUsageRequests: 1 });
  });
});

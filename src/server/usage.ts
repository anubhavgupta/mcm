import { randomUUID } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelConfig, ModelPricing, UsageSummary, UsageTotals } from '../shared/types';
import { emptyUsageTotals, usageTotalsSchema } from '../shared/usage';
import { Events } from './events';
import { SseParser, type Interceptor, type RequestContext, type ResponseContext } from './interceptors';
import { atomicJson } from './storage';
import { defaultPricing } from '../shared/config';

const persistedSchema = z.object({
  version: z.literal(1),
  trackingStartedAt: z.string().datetime(),
  allTime: usageTotalsSchema,
}).strict();

export interface RequestUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  pricing?: ModelPricing;
  incomplete?: boolean;
}

export class UsageStore {
  private summary: UsageSummary;
  private queue: Promise<void> = Promise.resolve();
  private pending = new Map<string, RequestUsage>();
  constructor(private directory: string, private events: Events) {
    const now = new Date().toISOString();
    this.summary = {
      allTime: emptyUsageTotals(), session: emptyUsageTotals(), sessionId: randomUUID(),
      sessionStartedAt: now, trackingStartedAt: now,
    };
  }
  async init(): Promise<void> {
    try {
      const path = join(this.directory, 'usage.json');
      await chmod(path, 0o600);
      const persisted = persistedSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      this.summary.allTime = persisted.allTime;
      this.summary.trackingStartedAt = persisted.trackingStartedAt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Cannot load usage.json: invalid or unreadable accounting history.', { cause: error });
      }
      await this.persist();
    }
  }
  getSummary(): UsageSummary {
    const summary = structuredClone(this.summary);
    for (const usage of this.pending.values()) {
      this.add(summary.allTime, usage, true);
      this.add(summary.session, usage, true);
    }
    return summary;
  }
  updatePending(requestId: string, usage: RequestUsage): void {
    if (usage.inputTokens === null && usage.outputTokens === null) return;
    const previous = this.pending.get(requestId);
    if (previous && previous.inputTokens === usage.inputTokens && previous.outputTokens === usage.outputTokens &&
      previous.pricing?.inputUsdPerMillion === usage.pricing?.inputUsdPerMillion &&
      previous.pricing?.outputUsdPerMillion === usage.pricing?.outputUsdPerMillion) return;
    this.pending.set(requestId, structuredClone(usage));
    this.events.emit({ type: 'usage', data: this.getSummary() });
  }
  record(usage: RequestUsage, requestId?: string): Promise<void> {
    if (requestId !== undefined) this.pending.delete(requestId);
    // Keep observed usage in memory even if disk fails; a subsequent write includes it.
    for (const totals of [this.summary.allTime, this.summary.session]) this.add(totals, usage);
    const operation = this.queue.then(async () => {
      try {
        await this.persist();
        delete this.summary.error;
        this.events.emit({ type: 'usage', data: this.getSummary() });
      } catch (error) {
        this.summary.error = 'Usage history could not be saved. Totals include unsaved usage; check local filesystem permissions and free space.';
        this.events.log(this.summary.error);
        this.events.emit({ type: 'usage', data: this.getSummary() });
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private add(totals: UsageTotals, usage: RequestUsage, pending = false): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.requestCount++;
    if (!pending && (usage.incomplete || usage.inputTokens === null || usage.outputTokens === null)) totals.missingUsageRequests++;
    if (usage.pricing && (usage.inputTokens !== null || usage.outputTokens !== null)) {
      totals.costUsd = (totals.costUsd ?? 0) + input / 1e6 * usage.pricing.inputUsdPerMillion + output / 1e6 * usage.pricing.outputUsdPerMillion;
    } else totals.unpricedTokens += input + output;
  }
  private async persist(): Promise<void> {
    const data = persistedSchema.parse({
      version: 1, trackingStartedAt: this.summary.trackingStartedAt, allTime: this.summary.allTime,
    });
    await atomicJson(this.directory, 'usage.json', data);
  }
  async close(): Promise<void> {
    await this.queue;
    if (this.summary.error) throw new Error(this.summary.error);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function maximum(previous: number | null, next: unknown): number | null {
  const value = count(next);
  return value === null ? previous : Math.max(previous ?? 0, value);
}

interface ModelSnapshot { models: ModelConfig[]; managedModelId?: string; basePricing?: ModelPricing }
interface Observation {
  context: RequestContext;
  models?: ModelSnapshot;
  pricing?: ModelPricing;
  requestChunks: Uint8Array[];
  requestBytes: number;
  requestDone: boolean;
  requestEncoded?: boolean;
  parser?: SseParser;
  json: boolean;
  chunks: Uint8Array[];
  bytes: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  timingInput: number | null;
  timingOutput: number | null;
  finalOutput?: boolean;
  finalInput?: boolean;
  finishedChoice?: boolean;
  incomplete: boolean;
}

/** Live reported usage with bounded copies; completed requests are persisted once. */
export class UsageInterceptor implements Interceptor {
  private observations = new Map<string, Observation>();
  constructor(private store: UsageStore, private snapshot: () => ModelSnapshot) {}
  onRequest(context: RequestContext): void {
    if (context.method !== 'POST' || !/^\/v1\/(?:chat\/completions|completions|messages|responses|embeddings)\/?$/.test(context.path.split('?')[0]!)) return;
    this.observations.set(context.requestId, {
      context, requestChunks: [], requestBytes: 0, requestDone: false,
      json: false, chunks: [], bytes: 0, input: null, output: null,
      cacheRead: null, cacheCreation: null, timingInput: null, timingOutput: null, incomplete: false,
    });
  }
  onOutboundRequest(context: RequestContext, headers: RequestContext['headers']): void {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    observation.models = structuredClone(this.snapshot());
    observation.pricing = observation.models.basePricing ?? { ...defaultPricing };
    observation.requestEncoded = Boolean(headers['content-encoding'] && headers['content-encoding'] !== 'identity');
    const id = observation.models.managedModelId;
    if (id !== undefined) observation.pricing = observation.models.models.find(model => model.id === id)?.pricing ?? observation.pricing;
  }
  onRequestChunk(context: RequestContext, chunk: Uint8Array): void {
    const observation = this.observations.get(context.requestId);
    if (!observation || observation.requestDone || observation.requestEncoded || observation.models?.managedModelId !== undefined) return;
    observation.requestBytes += chunk.byteLength;
    if (observation.requestBytes <= 2 * 1024 * 1024) observation.requestChunks.push(chunk.slice());
    else observation.requestChunks = [];
  }
  onRequestEnd(context: RequestContext): void {
    const observation = this.observations.get(context.requestId);
    if (!observation || observation.requestDone) return;
    observation.requestDone = true;
    if (observation.models?.managedModelId === undefined && observation.requestBytes <= 2 * 1024 * 1024) {
      try {
        const modelName = object(JSON.parse(Buffer.concat(observation.requestChunks).toString('utf8')))?.model;
        if (typeof modelName === 'string') {
          const matches = observation.models?.models.filter(model =>
            [model.id, model.name, model.model.filename, model.model.repo].includes(modelName)) ?? [];
          if (matches.length === 1) observation.pricing = matches[0]!.pricing ?? observation.pricing;
        }
      } catch { /* Unidentifiable models retain the snapshotted base price. */ }
    }
    observation.requestChunks = [];
  }
  onResponse(context: RequestContext, response: ResponseContext): void {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    observation.incomplete ||= response.status >= 400;
    const type = String(response.headers['content-type'] ?? '');
    if (type.includes('text/event-stream')) observation.parser = new SseParser(data => this.parse(observation, data));
    else observation.json = type.includes('json');
  }
  onResponseChunk(context: RequestContext, chunk: Uint8Array): void {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    if (observation.parser) observation.parser.push(chunk);
    else if (observation.json) {
      observation.bytes += chunk.byteLength;
      if (observation.bytes <= 2 * 1024 * 1024) observation.chunks.push(chunk.slice());
      else observation.chunks = [];
    }
  }
  private parse(observation: Observation, text: string): void {
    let body: Record<string, unknown> | undefined;
    try { body = object(JSON.parse(text)); } catch { return; }
    if (!body) return;
    const response = object(body.response);
    observation.incomplete ||= Boolean(body.error || body.type === 'error' || body.type === 'response.failed' ||
      body.type === 'response.incomplete' || response?.status === 'incomplete' || response?.status === 'failed');
    const message = object(body.message);
    const usage = object(body.usage) ?? object(response?.usage) ?? object(message?.usage);
    const timings = object(body.timings) ?? object(response?.timings) ?? object(message?.timings);
    observation.finishedChoice ||= Array.isArray(body.choices) && body.choices.some(value => object(value)?.finish_reason != null);
    const finalUsage = !observation.parser || observation.finishedChoice || body.type === 'message_delta' ||
      (Array.isArray(body.choices) && body.choices.length === 0);
    if (finalUsage && count(usage?.completion_tokens ?? usage?.output_tokens) !== null) observation.finalOutput = true;
    if (finalUsage && count(usage?.prompt_tokens ?? usage?.input_tokens) !== null) observation.finalInput = true;
    observation.input = maximum(observation.input, usage?.prompt_tokens ?? usage?.input_tokens);
    observation.output = maximum(observation.output, usage?.completion_tokens ?? usage?.output_tokens);
    // Anthropic input_tokens excludes these two disjoint categories. Do not add nested cache breakdowns.
    if (observation.context.protocol === 'anthropic' && usage?.prompt_tokens === undefined) {
      observation.cacheRead = maximum(observation.cacheRead, usage?.cache_read_input_tokens);
      observation.cacheCreation = maximum(observation.cacheCreation, usage?.cache_creation_input_tokens);
    }
    observation.timingInput = maximum(observation.timingInput, timings?.prompt_n);
    observation.timingOutput = maximum(observation.timingOutput, timings?.predicted_n);
    this.store.updatePending(observation.context.requestId, this.reportedUsage(observation, false));
  }
  onComplete(context: RequestContext): Promise<void> { return this.finish(context, false); }
  onError(context: RequestContext): Promise<void> { return this.finish(context, true); }
  private async finish(context: RequestContext, incomplete: boolean): Promise<void> {
    const observation = this.observations.get(context.requestId);
    if (!observation) return;
    this.onRequestEnd(context);
    this.observations.delete(context.requestId);
    observation.parser?.finish();
    if (observation.json && observation.bytes <= 2 * 1024 * 1024) this.parse(observation, Buffer.concat(observation.chunks).toString('utf8'));
    await this.store.record(this.reportedUsage(observation, incomplete), context.requestId);
  }
  private reportedUsage(observation: Observation, incomplete: boolean): RequestUsage {
    const partialCache = observation.input === null && observation.timingInput === null &&
      (observation.cacheRead !== null || observation.cacheCreation !== null);
    const input = observation.input === null && !partialCache ? null :
      (observation.input ?? 0) + (observation.cacheRead ?? 0) + (observation.cacheCreation ?? 0);
    // API usage includes consumed/cached tokens; timings may cover only evaluated tokens.
    return {
      inputTokens: input === 0 && observation.parser && !observation.finalInput ?
        observation.timingInput ?? 0 : input ?? observation.timingInput,
      outputTokens: observation.output === 0 && observation.parser && !observation.finalOutput ?
        observation.timingOutput ?? 0 : observation.output ?? observation.timingOutput,
      pricing: observation.pricing, incomplete: incomplete || observation.incomplete || partialCache,
    };
  }
}

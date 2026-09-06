import { randomUUID } from 'node:crypto';

type ObjectValue = Record<string, unknown>;
const MiB = 1024 * 1024;
export class AnthropicTranslationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function anthropicError(message: string, status = 502) {
  const type = status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' :
    status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' :
      status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : 'api_error';
  return { type: 'error', error: { type, message } };
}
function object(value: unknown, where: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object.`);
  return value as ObjectValue;
}
function fail(message: string): never { throw new AnthropicTranslationError(message); }
function keys(value: ObjectValue, allowed: string[], where: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    fail(`${where} contains unsupported fields. Supported fields: ${allowed.join(', ')}. Use passthrough mode for provider extensions.`);
  }
}
function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be a string.`);
  return value;
}
function nonempty(value: unknown, where: string): string {
  const result = text(value, where);
  if (!result) fail(`${where} must not be empty.`);
  return result;
}
function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array.`);
  return value;
}
function contentPart(value: unknown): ObjectValue {
  const block = object(value, 'content block');
  if (block.type === 'text') {
    keys(block, ['type', 'text', 'cache_control'], 'text block');
    return { type: 'text', text: text(block.text, 'text block.text') };
  }
  if (block.type === 'image') {
    keys(block, ['type', 'source', 'cache_control'], 'image block');
    const source = object(block.source, 'image source');
    if (source.type === 'base64') {
      keys(source, ['type', 'media_type', 'data'], 'base64 image source');
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(source.media_type))) fail('Unsupported image media_type.');
      const data = nonempty(source.data, 'image source.data');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('Image source.data must be base64.');
      return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${data}` } };
    }
    if (source.type === 'url') {
      keys(source, ['type', 'url'], 'URL image source');
      const url = text(source.url, 'image source.url');
      if (!/^https?:\/\//.test(url)) fail('Image URLs must use HTTP or HTTPS.');
      return { type: 'image_url', image_url: { url } };
    }
    fail('Unsupported image source. Use base64 or URL images.');
  }
  fail('Unsupported content block. Translation supports text, image, assistant thinking/tool_use and user tool_result; use passthrough for documents or provider extensions.');
}

/** Cache-control, metadata and thinking signatures are provider hints, not llama.cpp prompt fields. */
export function translateAnthropicRequest(value: unknown): ObjectValue {
  const body = object(value, 'request');
  keys(body, ['model', 'max_tokens', 'stream', 'system', 'messages', 'tools', 'tool_choice', 'stop_sequences',
    'temperature', 'top_p', 'top_k', 'thinking', 'chat_template_kwargs', 'metadata', 'cache_control'], 'request');
  const result: ObjectValue = { model: nonempty(body.model, 'model') };
  if (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1) fail('max_tokens must be a positive integer.');
  result.max_tokens = body.max_tokens;
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream must be a boolean.');
  result.stream = body.stream ?? false;
  if (body.stream) {
    result.timings_per_token = true;
    result.stream_options = { include_usage: true };
  }
  for (const field of ['temperature', 'top_p', 'top_k']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || Number(body[field]) < 0 ||
      (field === 'top_k' && !Number.isSafeInteger(body[field])) || (field === 'top_p' && Number(body[field]) > 1)) {
      fail(`${field} must be a valid nonnegative sampling value.`);
    }
    result[field] = body[field];
  }
  if (body.stop_sequences !== undefined) result.stop = array(body.stop_sequences, 'stop_sequences').map(value => text(value, 'stop sequence'));
  if (body.chat_template_kwargs !== undefined) result.chat_template_kwargs = object(body.chat_template_kwargs, 'chat_template_kwargs');
  if (body.thinking !== undefined) {
    const thinking = object(body.thinking, 'thinking');
    keys(thinking, ['type', 'budget_tokens'], 'thinking');
    if (!['enabled', 'disabled', 'adaptive'].includes(String(thinking.type))) fail('thinking.type must be enabled, disabled or adaptive.');
    if (thinking.type === 'enabled' && (!Number.isSafeInteger(thinking.budget_tokens) || Number(thinking.budget_tokens) < 1)) {
      fail('Enabled thinking requires a positive integer budget_tokens.');
    }
    if (thinking.type === 'disabled' && thinking.budget_tokens !== undefined) fail('Disabled thinking cannot specify budget_tokens.');
    if (thinking.type === 'adaptive' && thinking.budget_tokens !== undefined) fail('Adaptive thinking cannot specify a fixed budget_tokens.');
    result.chat_template_kwargs = { ...result.chat_template_kwargs as ObjectValue, enable_thinking: thinking.type !== 'disabled' };
    if (thinking.type !== 'adaptive') result.thinking_budget_tokens = thinking.type === 'enabled' ? thinking.budget_tokens : 0;
  }
  const messages: ObjectValue[] = [];
  if (body.system !== undefined) {
    const system = typeof body.system === 'string' ? body.system : array(body.system, 'system').map(value => {
      const block = object(value, 'system block');
      if (block.type !== 'text') fail('System content supports only text blocks.');
      return contentPart(block).text;
    }).join('\n\n');
    messages.push({ role: 'system', content: system });
  }
  const toolIds = new Set<string>();
  const resolvedTools = new Set<string>();
  for (const value of array(body.messages, 'messages')) {
    const message = object(value, 'message');
    keys(message, ['role', 'content'], 'message');
    if (message.role !== 'user' && message.role !== 'assistant') fail('Messages must have user or assistant roles.');
    if (typeof message.content === 'string') { messages.push({ role: message.role, content: message.content }); continue; }
    const parts: ObjectValue[] = [];
    const calls: ObjectValue[] = [];
    let reasoning = '';
    const flushUser = () => {
      if (parts.length) messages.push({ role: 'user', content: parts.splice(0) });
    };
    for (const value of array(message.content, 'message.content')) {
      const block = object(value, 'content block');
      if (block.type === 'thinking') {
        if (message.role !== 'assistant') fail('Thinking blocks require an assistant message.');
        keys(block, ['type', 'thinking', 'signature', 'cache_control'], 'thinking block');
        reasoning += text(block.thinking, 'thinking block.thinking');
      } else if (block.type === 'tool_use') {
        if (message.role !== 'assistant') fail('tool_use blocks require an assistant message.');
        keys(block, ['type', 'id', 'name', 'input', 'cache_control'], 'tool_use block');
        const id = nonempty(block.id, 'tool_use.id');
        if (toolIds.has(id)) fail('tool_use IDs must be unique.');
        toolIds.add(id);
        calls.push({ id, type: 'function', function: { name: nonempty(block.name, 'tool_use.name'), arguments: JSON.stringify(object(block.input, 'tool_use.input')) } });
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user') fail('tool_result blocks require a user message.');
        keys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], 'tool_result block');
        const id = nonempty(block.tool_use_id, 'tool_result.tool_use_id');
        if (!toolIds.has(id) || resolvedTools.has(id)) fail('tool_result must reference a preceding, unresolved tool_use ID.');
        resolvedTools.add(id);
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') fail('tool_result.is_error must be boolean.');
        let content: unknown = typeof block.content === 'string' ? block.content :
          block.content === undefined ? '' : array(block.content, 'tool_result.content').map(contentPart);
        if (block.is_error) content = typeof content === 'string' ? `Tool error: ${content}` :
          [{ type: 'text', text: 'Tool error:' }, ...content as ObjectValue[]];
        flushUser();
        messages.push({ role: 'tool', tool_call_id: id, content });
      } else parts.push(contentPart(block));
    }
    if (message.role === 'user') flushUser();
    else messages.push({ role: 'assistant', content: parts.length ? parts : null,
      ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) });
  }
  result.messages = messages;
  if (body.tools !== undefined) result.tools = array(body.tools, 'tools').map(value => {
    const tool = object(value, 'tool');
    keys(tool, ['name', 'description', 'input_schema', 'cache_control', 'type'], 'tool');
    if (tool.type !== undefined && tool.type !== 'custom') fail('Only custom function tools are supported; hosted provider tools require passthrough.');
    return { type: 'function', function: { name: nonempty(tool.name, 'tool.name'),
      ...(tool.description !== undefined ? { description: text(tool.description, 'tool.description') } : {}),
      parameters: object(tool.input_schema, 'tool.input_schema') } };
  });
  if (body.tool_choice !== undefined) {
    const choice = object(body.tool_choice, 'tool_choice');
    keys(choice, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
    if (!['auto', 'any', 'tool', 'none'].includes(String(choice.type))) fail('Unsupported tool_choice.type.');
    if (choice.type !== 'tool' && choice.name !== undefined) fail('tool_choice.name requires type tool.');
    result.tool_choice = choice.type === 'tool' ? { type: 'function', function: { name: nonempty(choice.name, 'tool_choice.name') } } :
      choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== 'boolean') fail('disable_parallel_tool_use must be boolean.');
      result.parallel_tool_calls = !choice.disable_parallel_tool_use;
    }
  }
  return result;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function optionalObject(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
class Counts {
  input?: number;
  output?: number;
  cached?: number;
  timingInput?: number;
  timingOutput?: number;
  finalOutput = false;
  finalInput = false;
  finishedChoice = false;
  update(body: ObjectValue): void {
    const usage = optionalObject(body.usage);
    const timings = optionalObject(body.timings);
    const max = (previous: number | undefined, value: unknown) => count(value) === undefined ? previous : Math.max(previous ?? 0, count(value)!);
    this.input = max(this.input, usage.prompt_tokens);
    this.output = max(this.output, usage.completion_tokens);
    this.cached = max(this.cached, optionalObject(usage.prompt_tokens_details).cached_tokens);
    this.timingInput = max(this.timingInput, timings.prompt_n);
    this.timingOutput = max(this.timingOutput, timings.predicted_n);
    this.finishedChoice ||= Array.isArray(body.choices) && body.choices.some(value => optionalObject(value).finish_reason != null);
    const finalUsage = this.finishedChoice || (Array.isArray(body.choices) && body.choices.length === 0);
    if (finalUsage && count(usage.completion_tokens) !== undefined) this.finalOutput = true;
    if (finalUsage && count(usage.prompt_tokens) !== undefined) this.finalInput = true;
  }
  value(streaming = false) {
    const total = streaming && this.input === 0 && !this.finalInput ? this.timingInput ?? 0 : this.input ?? this.timingInput ?? 0;
    const cached = Math.min(total, this.cached ?? 0);
    return { input_tokens: total - cached, output_tokens: streaming && this.output === 0 && !this.finalOutput ?
      this.timingOutput ?? 0 : this.output ?? this.timingOutput ?? 0,
      ...(this.cached !== undefined ? { cache_read_input_tokens: cached } : {}) };
  }
}
function stopReason(value: unknown, tools: boolean): string {
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'stop' || value == null) return tools ? 'tool_use' : 'end_turn';
  throw new AnthropicTranslationError('Upstream returned an unsupported finish_reason; use a compatible llama.cpp chat-completions endpoint.', 502);
}
function parseArguments(value: unknown): ObjectValue {
  try { return object(JSON.parse(text(value, 'tool arguments')), 'tool arguments'); }
  catch { throw new AnthropicTranslationError('Upstream returned invalid tool arguments; expected a JSON object.', 502); }
}
export function translateOpenAIResponse(value: unknown, model: string): ObjectValue {
  const body = object(value, 'upstream response');
  if (body.error) throw new AnthropicTranslationError('Upstream returned an error instead of a completion.', 502);
  const choices = array(body.choices, 'upstream choices');
  if (choices.length !== 1) throw new AnthropicTranslationError('Upstream must return exactly one completion choice.', 502);
  const choice = object(choices[0], 'upstream choice');
  const message = object(choice.message, 'upstream message');
  if (message.refusal || message.audio || message.function_call) throw new AnthropicTranslationError('Upstream returned unsupported refusal/audio/legacy function content.', 502);
  const content: ObjectValue[] = [];
  if (message.reasoning_content) content.push({ type: 'thinking', thinking: text(message.reasoning_content, 'reasoning_content'), signature: '' });
  if (message.content != null && message.content !== '') content.push({ type: 'text', text: text(message.content, 'upstream message.content') });
  if (message.tool_calls !== undefined) for (const value of array(message.tool_calls, 'tool_calls')) {
    const tool = object(value, 'tool call');
    const fn = object(tool.function, 'tool function');
    if (tool.type !== undefined && tool.type !== 'function') throw new AnthropicTranslationError('Unsupported upstream tool type.', 502);
    content.push({ type: 'tool_use', id: nonempty(tool.id, 'tool id'), name: nonempty(fn.name, 'tool name'), input: parseArguments(fn.arguments) });
  }
  const counts = new Counts();
  counts.update(body);
  return { id: typeof body.id === 'string' ? body.id : `msg_${randomUUID()}`, type: 'message', role: 'assistant',
    model: typeof body.model === 'string' ? body.model : model, content,
    stop_reason: stopReason(choice.finish_reason, content.some(block => block.type === 'tool_use')), stop_sequence: null, usage: counts.value() };
}
export function upstreamErrorBody(value: unknown, status: number) {
  const error = optionalObject(optionalObject(value).error);
  return anthropicError(typeof error.message === 'string' ? error.message : 'Upstream request failed. Check the compatible llama.cpp server and its logs.', status);
}

/** Strict, bounded SSE framing, separate from fail-open metric observers. */
async function* sseData(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let data: string[] = [];
  let bytes = 0;
  let cr = false;
  function* consume(text: string): Generator<string> {
    for (const char of text) {
      if (char === '\n' && cr) { cr = false; continue; }
      cr = char === '\r';
      if (char === '\n' || char === '\r') {
        if (!line) {
          if (data.length) yield data.join('\n');
          data = []; bytes = 0;
        } else if (line === 'data' || line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        line = '';
      } else {
        bytes += Buffer.byteLength(char);
        if (bytes > MiB) throw new AnthropicTranslationError('Upstream SSE event exceeds the 1 MiB translation limit.', 502);
        line += char;
      }
    }
  }
  for await (const chunk of source) yield* consume(decoder.decode(chunk, { stream: true }));
  yield* consume(decoder.decode());
  if (line) yield* consume('\n');
  if (data.length) yield data.join('\n');
}
const event = (type: string, data: ObjectValue) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
interface StreamTool { index: number; id: string; name: string; args: string; started: boolean }
export class AnthropicStream {
  failure?: Error;
  completed = false;
  constructor(private model: string) {}
  async *translate(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
    const counts = new Counts();
    const tools = new Map<number, StreamTool>();
    let started = false;
    let done = false;
    let finish: unknown;
    let nextIndex = 0;
    let active: { type: string; index: number } | undefined;
    let argumentBytes = 0;
    const closeText = () => {
      if (!active) return '';
      const output = event('content_block_stop', { index: active.index });
      active = undefined;
      return output;
    };
    try {
      for await (const data of sseData(source)) {
        if (data.trim() === '[DONE]') { done = true; break; }
        let body: ObjectValue;
        try { body = object(JSON.parse(data), 'upstream event'); }
        catch { throw new AnthropicTranslationError('Upstream sent invalid JSON in an SSE event.', 502); }
        if (body.error) throw new AnthropicTranslationError('Upstream reported a streaming error. Check llama.cpp logs.', 502);
        counts.update(body);
        if (!started) {
          started = true;
          yield event('message_start', { message: { id: typeof body.id === 'string' ? body.id : `msg_${randomUUID()}`,
            type: 'message', role: 'assistant', model: typeof body.model === 'string' ? body.model : this.model,
            content: [], stop_reason: null, stop_sequence: null, usage: { ...counts.value(), output_tokens: 0 } } });
        }
        const choices = body.choices === undefined ? [] : array(body.choices, 'upstream choices');
        if (choices.length > 1) throw new AnthropicTranslationError('Upstream must return one completion choice.', 502);
        if (!choices.length) continue;
        const choice = object(choices[0], 'upstream choice');
        if (choice.index !== undefined && choice.index !== 0) throw new AnthropicTranslationError('Unexpected upstream choice index.', 502);
        if (choice.finish_reason != null) finish = choice.finish_reason;
        const delta = optionalObject(choice.delta);
        if (delta.refusal || delta.audio || delta.function_call) throw new AnthropicTranslationError('Unsupported upstream refusal/audio/legacy function delta.', 502);
        for (const [field, type] of [['reasoning_content', 'thinking'], ['content', 'text']]) {
          if (delta[field!] == null || delta[field!] === '') continue;
          const value = text(delta[field!], 'upstream content delta');
          if (active?.type !== type) {
            yield closeText();
            active = { type: type!, index: nextIndex++ };
            yield event('content_block_start', { index: active.index, content_block: type === 'text' ?
              { type, text: '' } : { type, thinking: '', signature: '' } });
          }
          yield event('content_block_delta', { index: active.index, delta: type === 'text' ?
            { type: 'text_delta', text: value } : { type: 'thinking_delta', thinking: value } });
        }
        if (delta.tool_calls !== undefined) for (const value of array(delta.tool_calls, 'tool deltas')) {
          yield closeText();
          const call = object(value, 'tool delta');
          const key = count(call.index);
          if (key === undefined) throw new AnthropicTranslationError('Upstream tool delta requires a nonnegative index.', 502);
          if (call.type !== undefined && call.type !== 'function') throw new AnthropicTranslationError('Unsupported upstream tool type.', 502);
          let tool = tools.get(key);
          if (!tool) {
            if (tools.size >= 128) throw new AnthropicTranslationError('Upstream exceeds 128 tool calls per message.', 502);
            tool = { index: nextIndex++, id: '', name: '', args: '', started: false };
            tools.set(key, tool);
          }
          const fn = optionalObject(call.function);
          if (call.id) {
            const id = text(call.id, 'tool id');
            if (tool.id && tool.id !== id) throw new AnthropicTranslationError('Upstream changed a streaming tool ID.', 502);
            tool.id = id;
          }
          if (fn.name) {
            const name = text(fn.name, 'tool name');
            if (tool.name && tool.name !== name) throw new AnthropicTranslationError('Upstream changed a streaming tool name.', 502);
            tool.name = name;
          }
          const args = fn.arguments === undefined ? '' : text(fn.arguments, 'tool arguments delta');
          argumentBytes += Buffer.byteLength(args);
          if (argumentBytes > 2 * MiB) throw new AnthropicTranslationError('Upstream tool arguments exceed the 2 MiB per-message limit.', 502);
          tool.args += args;
          if (!tool.started && tool.id && tool.name) {
            tool.started = true;
            yield event('content_block_start', { index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
            if (tool.args) yield event('content_block_delta', { index: tool.index, delta: { type: 'input_json_delta', partial_json: tool.args } });
          } else if (tool.started && args) yield event('content_block_delta', { index: tool.index, delta: { type: 'input_json_delta', partial_json: args } });
        }
      }
      if (!started) throw new AnthropicTranslationError('Upstream returned an empty SSE stream.', 502);
      if (!done && finish == null) throw new AnthropicTranslationError('Upstream stream ended without a completion marker.', 502);
      for (const tool of tools.values()) {
        if (!tool.started) throw new AnthropicTranslationError('Upstream ended before supplying a tool ID and name.', 502);
        parseArguments(tool.args || '{}');
      }
      const reason = stopReason(finish, tools.size > 0);
      yield closeText();
      for (const tool of tools.values()) yield event('content_block_stop', { index: tool.index });
      yield event('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: counts.value(true) });
      yield event('message_stop', {});
      this.completed = true;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error('Translation failed.');
      yield event('error', { error: anthropicError(error instanceof AnthropicTranslationError ? error.message :
        'Upstream stream failed or returned invalid content. Check the compatible llama.cpp server.').error });
    }
  }
}

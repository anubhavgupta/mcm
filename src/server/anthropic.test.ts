import { describe, expect, it } from 'vitest';
import { AnthropicStream, translateAnthropicRequest, translateOpenAIResponse } from './anthropic';

const request = { model: 'local', max_tokens: 512, messages: [{ role: 'user', content: 'Hello' }] };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function stream(text: string, fragment = false) {
  const translator = new AnthropicStream('fallback-model');
  async function* chunks() {
    const bytes = Buffer.from(text);
    if (fragment) for (const byte of bytes) yield Buffer.of(byte);
    else yield bytes;
  }
  let output = '';
  for await (const chunk of translator.translate(chunks())) output += chunk;
  const events = output.split('\n\n').filter(Boolean).map(value => JSON.parse(value.split('\ndata: ')[1]!));
  return { events, failure: translator.failure, output };
}

describe('Anthropic request translation', () => {
  it('maps cached system blocks, thinking, function calls/results, images and sampling without losing prompt content', () => {
    const value = translateAnthropicRequest({
      ...request, stream: true, system: [
        { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Use tools.' },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'Let me inspect.', signature: 'opaque-provider-signature' },
          { type: 'text', text: 'Inspecting now' },
          { type: 'tool_use', id: 'call_1', name: 'inspect', input: { filename: '猫.png' } },
          { type: 'tool_use', id: 'call_2', name: 'inspect', input: { filename: 'dog.png' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'A cat' }, { type: 'image', source: { type: 'url', url: 'https://example.test/cat.png' } }] },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'File missing', is_error: true },
          { type: 'text', text: 'Summarize these.' },
        ] },
      ],
      tools: [{ name: 'inspect', description: 'Inspect a file', input_schema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] }, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'inspect', disable_parallel_tool_use: true },
      temperature: 0.7, top_p: 0.9, top_k: 40, stop_sequences: ['STOP'],
      thinking: { type: 'enabled', budget_tokens: 256 }, chat_template_kwargs: { custom_flag: true },
      metadata: { user_id: 'provider-hint' }, cache_control: { type: 'ephemeral' },
    });
    expect(value).toEqual({
      model: 'local', max_tokens: 512, stream: true, timings_per_token: true, stream_options: { include_usage: true },
      temperature: 0.7, top_p: 0.9, top_k: 40, stop: ['STOP'], thinking_budget_tokens: 256,
      chat_template_kwargs: { custom_flag: true, enable_thinking: true },
      tools: [{ type: 'function', function: { name: 'inspect', description: 'Inspect a file', parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } } }],
      tool_choice: { type: 'function', function: { name: 'inspect' } }, parallel_tool_calls: false,
      messages: [
        { role: 'system', content: 'You are helpful.\n\nUse tools.' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Inspecting now' }], reasoning_content: 'Let me inspect.', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'inspect', arguments: '{"filename":"猫.png"}' } },
          { id: 'call_2', type: 'function', function: { name: 'inspect', arguments: '{"filename":"dog.png"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'A cat' }, { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } }] },
        { role: 'tool', tool_call_id: 'call_2', content: 'Tool error: File missing' },
        { role: 'user', content: [{ type: 'text', text: 'Summarize these.' }] },
      ],
    });
  });
  it.each([['auto', 'auto'], ['any', 'required'], ['none', 'none']])('maps tool choice %s', (type, expected) => {
    expect(translateAnthropicRequest({ ...request, tool_choice: { type, disable_parallel_tool_use: false } }))
      .toMatchObject({ tool_choice: expected, parallel_tool_calls: true });
  });
  it('preserves plain system/assistant text and disabled thinking without injecting stream options', () => {
    const translated = translateAnthropicRequest({ ...request, system: 'system', messages: [{ role: 'assistant', content: 'prefix' }], thinking: { type: 'disabled' } });
    expect(translated).toMatchObject({ messages: [{ role: 'system', content: 'system' }, { role: 'assistant', content: 'prefix' }],
      thinking_budget_tokens: 0, chat_template_kwargs: { enable_thinking: false } });
    expect(translated).not.toHaveProperty('stream_options');
    expect(translated).not.toHaveProperty('timings_per_token');
  });
  it.each([false, true])('accepts adaptive thinking without assigning a fixed budget (stream=%s)', stream => {
    const translated = translateAnthropicRequest({
      ...request, stream, thinking: { type: 'adaptive' },
      chat_template_kwargs: { custom_flag: true },
    });
    expect(translated).toMatchObject({ stream, chat_template_kwargs: { custom_flag: true, enable_thinking: true } });
    expect(translated).not.toHaveProperty('thinking_budget_tokens');
    if (stream) expect(translated).toMatchObject({ timings_per_token: true, stream_options: { include_usage: true } });
  });
  it.each([
    { messages: [{ role: 'user', content: [{ type: 'document', source: { data: 'private prompt' } }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'private prompt' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'private prompt' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'id', name: 'name', input: {} }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'private prompt' } }] }] },
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { thinking: { type: 'adaptive', budget_tokens: 256 } },
    { thinking: { type: 'unknown' } },
    { output_config: { format: { type: 'json_schema' } } },
    { service_tier: 'priority' },
    { max_tokens: 0 },
    { stream: 'true' },
    { temperature: -1 },
    { top_p: 2 },
    { tool_choice: { type: 'unknown' } },
  ])('rejects unsupported semantics with private values omitted %#', patch => {
    expect(() => translateAnthropicRequest({ ...request, ...patch })).toThrow();
    try { translateAnthropicRequest({ ...request, ...patch }); } catch (error) {
      expect(String(error)).not.toContain('private prompt');
    }
  });
});

describe('OpenAI JSON response translation', () => {
  it('returns a complete Anthropic text/thinking/tool response with split cached input usage', () => {
    expect(translateOpenAIResponse({
      id: 'chatcmpl-1', model: 'actual', choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: '你好 😊', reasoning_content: 'Consider it',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
      } }], usage: { prompt_tokens: 108, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } },
    }, 'fallback')).toEqual({
      id: 'chatcmpl-1', model: 'actual', type: 'message', role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Consider it', signature: '' }, { type: 'text', text: '你好 😊' },
        { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 9, cache_read_input_tokens: 100 },
    });
  });
  it.each([['stop', 'end_turn'], ['length', 'max_tokens'], [null, 'end_turn']])('maps stop reason %s with timing fallback', (finish_reason, expected) => {
    expect(translateOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason }], timings: { prompt_n: 10, predicted_n: 2 } }, 'fallback'))
      .toMatchObject({ model: 'fallback', stop_reason: expected, usage: { input_tokens: 10, output_tokens: 2 } });
  });
  it('never overwrites authoritative JSON usage with timings', () => {
    expect(translateOpenAIResponse({ choices: [{ message: { content: null } }], usage: { prompt_tokens: 0, completion_tokens: 0 }, timings: { prompt_n: 10, predicted_n: 2 } }, 'fallback'))
      .toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 } });
  });
  it.each(['{broken', '[]', 'null', '"not an object"'])('rejects malformed tool arguments %s', args => {
    expect(() => translateOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: 'one', function: { name: 'tool', arguments: args } }] } }] }, 'fallback')).toThrow('tool arguments');
  });
});

describe('strict streaming translation', () => {
  it('preserves fragmented UTF-8, CRLF, reasoning, parallel tools and late usage after finish_reason', async () => {
    const { events, failure, output } = await stream(
      ': keepalive\r\n' +
      sse({ id: 'chat-id', model: 'actual', choices: [{ index: 0, delta: { role: 'assistant' } }], usage: { prompt_tokens: 12, completion_tokens: 0 } }).replaceAll('\n', '\r\n') +
      sse({ choices: [{ delta: { reasoning_content: 'Think 😊' } }] }) +
      sse({ choices: [{ delta: { content: '你好' } }] }) +
      sse({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'first', arguments: '{"city":' } },
        { index: 1, id: 'call_b', function: { name: 'second', arguments: '{"n":' } },
      ] } }] }) +
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '"東京"}' } }] } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], timings: { predicted_n: 99 } }) +
      sse({ choices: [], usage: { prompt_tokens: 112, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } } }) +
      'data: [DONE]\n\n', true);
    expect(failure).toBeUndefined();
    expect(output).not.toContain('timings');
    expect(events[0]).toMatchObject({ type: 'message_start', message: { id: 'chat-id', model: 'actual', usage: { input_tokens: 12, output_tokens: 0 } } });
    expect(events.filter(event => event.type === 'content_block_start').map(event => [event.index, event.content_block.type, event.content_block.id]))
      .toEqual([[0, 'thinking', undefined], [1, 'text', undefined], [2, 'tool_use', 'call_a'], [3, 'tool_use', 'call_b']]);
    expect(events.filter(event => event.delta?.type === 'input_json_delta' && event.index === 2).map(event => event.delta.partial_json).join('')).toBe('{"city":"東京"}');
    expect(events.filter(event => event.delta?.type === 'input_json_delta' && event.index === 3).map(event => event.delta.partial_json).join('')).toBe('{"n":2}');
    expect(events.at(-2)).toEqual({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 100 } });
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(1);
    expect(events.filter(event => event.type === 'content_block_stop').map(event => event.index)).toEqual([0, 1, 2, 3]);
    expect(output).toContain('Think 😊');
    expect(output).toContain('你好');
  });
  it.each([true, false])('finalizes normal upstream termination with or without DONE (%s), using native counts not chunks', async done => {
    const result = await stream(sse({ choices: [{ delta: { content: 'Hello' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) +
      sse({ timings: { prompt_n: 10, predicted_n: 2 } }) + (done ? 'data: [DONE]\n\n' : sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
    expect(result.events.at(-2)).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(result.failure).toBeUndefined();
  });
  it('buffers tool arguments only until tool metadata is available', async () => {
    const result = await stream(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }] }) +
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'tool', arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }));
    expect(result.failure).toBeUndefined();
    expect(result.events.filter(event => event.delta?.type === 'input_json_delta')).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    ]);
  });
  it.each([
    '',
    'data: {invalid}\n\n',
    sse({ error: { message: 'backend failed' } }),
    sse({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'id', function: { name: 'tool', arguments: '{broken' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }),
    `data: ${'x'.repeat(1024 * 1024)}\n\n`,
  ])('emits an error rather than successful termination for malformed or failed streams %#', async bad => {
    const result = await stream(sse({ choices: [{ delta: { content: 'partial' } }] }) + bad);
    expect(result.failure).toBeDefined();
    expect(result.events.at(-1)).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(result.events.some(event => event.type === 'message_stop')).toBe(false);
    expect(result.events.some(event => event.type === 'message_delta')).toBe(false);
  });
  it('rejects invalid UTF-8 and empty streams, and handles an iterator failure as an error event', async () => {
    for (const source of [
      (async function* () { yield Buffer.from([0xff]); })(),
      (async function* () {})(),
      (async function* () { yield Buffer.from(sse({ choices: [{ delta: { content: 'partial' } }] })); throw new Error('private transport detail'); })(),
    ]) {
      const translator = new AnthropicStream('model');
      let output = '';
      for await (const value of translator.translate(source)) output += value;
      expect(translator.failure).toBeDefined();
      expect(output).toContain('event: error');
      expect(output).not.toContain('message_stop');
      expect(output).not.toContain('private transport detail');
    }
  });
});

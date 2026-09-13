#!/usr/bin/env node
// A deterministic test double, not an inference engine.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  const catalog = JSON.parse(await readFile(new URL('../../src/shared/catalog.json', import.meta.url), 'utf8'));
  console.log(catalog.fields.flatMap(field => [field.flag, ...(field.aliases ?? [])]).filter(Boolean).join('\n'));
  console.log('--model\n--host\n--port\n--metrics');
  process.exit(0);
}

const port = Number(args[args.indexOf('--port') + 1]);
if (!port) throw new Error('Missing --port');
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', 'text/plain');
    res.end('llamacpp:prompt_tokens_seconds 125.5\nllamacpp:predicted_tokens_seconds 32.5\n');
    return;
  }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/v1/messages')) {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const input = JSON.parse(body);
    const anthropic = req.url === '/v1/messages';
    const timings = { prompt_n: 10, prompt_per_second: 125.5, predicted_n: 2, predicted_per_second: 32.5 };
    if (input.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const first = anthropic
        ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
        : { choices: [{ index: 0, delta: { content: 'Hello' } }] };
      res.write(`data: ${JSON.stringify(first)}\n\n`);
      if (input.timings_per_token) {
        res.write(`data: ${JSON.stringify({ timings: { ...timings, predicted_n: 1 } })}\n\n`);
      }
      const timer = setTimeout(() => {
        res.write(`data: ${JSON.stringify({ timings })}\n\n`);
        res.end(anthropic ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n');
      }, input.timings_per_token ? 4000 : 60);
      res.on('close', () => clearTimeout(timer));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(anthropic
        ? { type: 'message', content: [{ type: 'text', text: 'Hello' }], timings }
        : { choices: [{ message: { role: 'assistant', content: 'Hello' } }], timings }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown fixture endpoint' }));
});
server.listen(port, '127.0.0.1', () => console.log('Fixture model ready'));
const shutdown = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

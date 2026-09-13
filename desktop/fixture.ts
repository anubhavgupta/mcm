import { createServer } from 'node:http';
import catalog from '../src/shared/catalog.json' with { type: 'json' };

// A standalone test double: no model loading and no Node installation required.
if (Deno.args.includes('--version')) { console.log('version: b9000 (abcdef12)'); Deno.exit(); }
if (Deno.args.includes('--help')) {
  console.log(catalog.fields.flatMap(field => [field.flag, ...('aliases' in field ? field.aliases ?? [] : [])]).filter(Boolean).join('\n'));
  console.log('--model\n--host\n--port\n--metrics');
  Deno.exit();
}
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end('{"status":"ok"}');
});
server.listen(Number(Deno.args[Deno.args.indexOf('--port') + 1]), '127.0.0.1');
const stop = () => { server.closeAllConnections(); server.close(() => Deno.exit()); };
Deno.addSignalListener('SIGINT', stop);
if (Deno.build.os !== 'windows') Deno.addSignalListener('SIGTERM', stop);

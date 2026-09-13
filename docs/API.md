# API reference

All management endpoints return JSON; errors are `{ error: string }` with a non-2xx status.
Types in `src/shared/types.ts` are canonical. Workspace validation, inheritance,
argument generation and share encoding live in `src/shared`.

## Management endpoints

Machine settings accept optional `anthropicMode: "passthrough" | "openai"`.
Absent values retain passthrough behavior. With `"openai"`, only
`POST /v1/messages` is translated to upstream `/v1/chat/completions`; the client
still receives Anthropic JSON or SSE. Streaming translation requests
`timings_per_token: true` and usage reports. Native upstream measurements are
observed before response conversion, so token accounting does not depend on
the Anthropic protocol exposing per-token usage.

Management endpoints remain localhost and same-origin only. The inference proxy at `/v1`
allows all browser origins without credentialed CORS, handles `OPTIONS`
preflights locally, and permits requested API headers (including `Authorization`,
`x-api-key`, and `anthropic-version`). Its CORS policy also applies to upstream
errors and streaming responses. Upstream CORS headers do not override MCM's
policy. Cross-origin cookies are not supported.
Proxy requests also accept container-facing Host headers; those hostnames do not
grant access to management routes or change the server's loopback network binding.

- `GET /api/bootstrap` -> `Bootstrap` (hfToken NEVER returned)
- `PUT /api/workspace`, Workspace body -> validated saved Workspace
- `PUT /api/settings`, partial LocalSettings body, optional `clearHfToken: boolean` -> PublicSettings. Blank/absent hfToken preserves token. modelBindings maps model ID to relative path inside modelsDirectory.
- `GET /api/models` -> `{ models: ModelFile[] }`. Missing/unreadable directory returns an error, not an empty success.
- `POST /api/capabilities` -> `Capabilities`; runs configured executable with --help (bounded/time-limited). No arbitrary executable in the request.
- `POST /api/preview`, `{ modelId }` -> `{ executable: string, args: string[] }`. Resolve configuration and local model binding; no capability probe required.
- `POST /api/launch`, `{ modelId }` -> ServerStatus
- `POST /api/stop` -> ServerStatus
- `POST /api/restart` -> ServerStatus
- `GET /api/events`: SSE JSON ManagerEvent, initial status + buffered logs, heartbeat. No CPU/GPU telemetry.
- `POST /api/hf/push`, `{ repo?: string }` -> `{ url: string }`; saves portable workspace as mcm/workspace.json in an existing HF dataset repo. Uses configured token server-side only.
- `POST /api/hf/pull`, `{ repo?: string }` -> `{ workspace: Workspace }`; preview only, client explicitly PUTs after review. Public repo works without token.
- `GET|POST /v1/*`: protocol-aware streaming passthrough, /v1/messages is Anthropic; other /v1 routes OpenAI. Preserve paths, request headers relevant to API, status, SSE bytes, cancellation and backpressure. Upstream is settings.upstreamUrl if provided, else http://127.0.0.1:settings.serverPort.

`src/server/index.ts` binds only loopback, with `MCM_PORT` defaulting to 7838 and
`MCM_DATA_DIR` defaulting to `.mcm`. Development uses Vite middleware on the same
origin; production serves `dist/client`.

## Workspace example

Pricing uses the regular configuration value maps at every level:

```json
{
  "values": {
    "inputUsdPerMillion": 1.5,
    "outputUsdPerMillion": 6
  }
}
```

Set these keys in `base`, `groups[].values`, or `models[].values`. Each price
is optional and inherits independently through Model > Group > Base > defaults.
Rates must be finite numbers between 0 and 1,000,000. Zero is a valid override.
Defaults are `inputUsdPerMillion: 0.25` and `outputUsdPerMillion: 2`.
Pricing values are catalog-driven but have no CLI flags.

Legacy `basePricing` and `models[].pricing` objects are accepted on load/import
and migrated into the corresponding value maps. Explicit new-style values win
if both formats are present. Exported/saved workspaces use only the value maps.

## Usage accounting

Bootstrap includes a `usage` snapshot, also delivered in `usage` event envelopes.
`GET /api/usage` returns the same snapshot. New SSE connections receive the latest
snapshot even without a replay cursor.
It contains `allTime` and `session` totals with input/output counts, `costUsd`
(null when no priced usage is recorded), `unpricedTokens`, `requestCount`, and
`missingUsageRequests`. `sessionId`/`sessionStartedAt` identify this MCM backend
run; `trackingStartedAt` identifies the beginning of persistent accounting.
An optional `error` surfaces an accounting failure rather than claiming the
displayed history is fully saved.

All-time totals include the current session. Clients must replace their displayed
snapshot on each event, not add the event counts together. Browser refreshes and
event replay do not create new usage.
Accounting is finalized once per inference request on completion or failure.
Usage snapshots include the latest reported contribution of each active request;
repeated cumulative streaming usage messages replace that contribution, not add
to it. Completion moves it into persistent totals without counting it twice.
Active requests are not labeled incomplete merely because generation is ongoing.
Partial or missing
counts are flagged; data that was never reported cannot be reconstructed.
`costUsd` represents estimated token value, not an actual charge. Model-specific
prices take precedence; unknown, ambiguous or unpriced models use snapshotted
Base pricing. Pricing edits do not retroactively change recorded history.

## Complete workspace

```json
{
  "version": 1,
  "base": { "temperature": 0.7, "contextSize": 8192 },
  "groups": [
    { "id": "coding", "name": "Coding", "values": { "temperature": 0.2 } }
  ],
  "models": [
    {
      "id": "coder",
      "name": "Local coder",
      "model": { "filename": "coder-Q4_K_M.gguf", "repo": "owner/coder-GGUF" },
      "groupId": "coding",
      "values": { "topK": 0 }
    }
  ]
}
```

Unknown settings, invalid types/ranges, unknown schema versions, duplicate IDs,
dangling group references and machine-specific paths in model identities are
rejected. Model/group values are sparse override maps; deleting a key restores
inheritance. PUT replaces the workspace as one validated document.

## Links and imports

Deep-links use `#config=<payload>` with a schema-valid workspace snapshot: either
all models or a selected model plus its base settings and assigned group.
`POST /api/hf/push` accepts optional `modelId` alongside `repo` to upload the
same selected-model snapshot; omitting `modelId` retains full-workspace uploads.
Missing model IDs are rejected. Import must be
reviewed and confirmed; it never auto-launches. The separate HF shortcut
`#hf=<owner/repo>` fetches a preview and likewise never auto-imports.

The fragment is base64url-encoded UTF-8 JSON. Use the shared encoder/decoder,
which enforce schema validation and a 48 KB decoded size limit. Links do not
contain machine settings or authentication credentials.

## Local bindings

`settings.draftModelBindings` is an optional map of target model configuration IDs
to discovered relative draft-GGUF paths. It follows the same directory containment
and symlink rules as `modelBindings`, but is independent: a target model binding
can never accidentally serve as its draft binding. Omitted entries resolve the
effective `draftModel` filename uniquely. Missing/ambiguous files are errors.

## Speculation values

`values.speculation` is a comma-separated string of distinct supported
methods, or `"none"` for disabled. Existing single-method strings need no migration.
The list overrides its ancestor as a whole. For example:

```json
{
  "speculation": "ngram-mod,draft-simple",
  "draftModel": "small-draft.gguf",
  "draftGpuLayers": 0,
  "draftMax": 8,
  "draftCacheTypeK": "q8_0",
  "draftCacheTypeV": "f16"
}
```

These fields are available at base/group/model levels. Draft paths are resolved
locally for preview and launch. Portable exports never contain the resolved
absolute path. Inactive parameters are not emitted. An active external draft
method requires a draft model; draft-mtp does not. Minimum n-gram tokens must
not exceed the maximum while ngram-mod is active.

**Standard llama.cpp chooses runtime priority internally**, ignoring list order.
MCM exposes method selection only, not execution-order controls.

## Target-model bindings

Set `modelBindings[modelId]` to a discovered relative GGUF path through the
machine settings endpoint. Bindings resolve inside `modelsDirectory`.
This lets two recipients use the same portable configuration with different
folder layouts. Without a binding, the backend resolves a unique matching
filename; missing and ambiguous matches are errors.

## Event stream

`GET /api/events` uses Server-Sent Events with JSON payloads matching
`ManagerEvent`. Status, logs and throughput use explicit event types:

```ts
type ManagerEvent =
  | { type: 'status'; data: ServerStatus }
  | { type: 'log'; data: LogEntry }
  | { type: 'throughput'; data: Throughput };
```

Clients should reconnect after a connection failure and display connection
state separately from the last known process state. Throughput values can be
`null`; null means unavailable, not zero. Log buffers are bounded.

`Throughput.measurement` differentiates request-local `timings` from server-level
`prometheus` observations. Prometheus rates may include concurrent inference
requests and should not be presented as an isolated request's speed.

## Trusted interceptor modules

`src/server/interceptors.ts` exports `Interceptor`, `RequestContext`,
`OutboundRequest` and `ResponseContext`. A trusted TypeScript or JavaScript module
can default-export one interceptor or an array, or export a named `interceptors`
array. Set `MCM_INTERCEPTOR_MODULE` to its absolute path.

```ts
import type { Interceptor } from './src/server/interceptors';

const tag: Interceptor = {
  beforeRequest(context, outbound) {
    outbound.headers['x-mcm-request-id'] = context.requestId;
  },
  onResponse(context, response) {
    console.log(context.requestId, response.status);
  },
};

export default [tag];
```

The import path in the example is relative to a module placed in the project
root; `examples/request-tag.ts` provides a ready-to-run version.

| Hook | Purpose |
|---|---|
| `beforeRequest(context, outbound)` | Modify outgoing request headers or deliberately replace its body |
| `onRequest(context)` | Observe request metadata |
| `onOutboundRequest(context, headers)` | Observe final outgoing headers after request-modifying hooks |
| `onRequestChunk(context, bytes)` | Observe a copy of an outgoing request chunk |
| `onRequestEnd(context)` | Observe completion of the outgoing request body |
| `onResponse(context, response)` | Observe upstream response status and headers |
| `onResponseChunk(context, bytes)` | Observe a copy of an incoming response chunk |
| `onComplete(context)` | Observe successful completion |
| `onError(context, error)` | Observe failure/cancellation |

Hooks may return promises. `context.signal` indicates cancellation.
`beforeRequest` failures prevent forwarding and return an error. Observation
hook exceptions are logged without substituting or altering the protocol data.
Observation hooks must complete promptly because they participate in stream
backpressure.

By default the request body streams without whole-body buffering. A modifying
interceptor can explicitly call `await outbound.readBody()` to inspect up to
2 MiB of original request data. This read is cached. Leaving `outbound.body`
undefined replays the original bytes; assigning a string or `Uint8Array`
deliberately replaces the body and updates its content length. Body-reading
limits and preparation timeouts fail closed. Larger upload requests should use
streaming observation rather than whole-body transformation.

The built-in throughput interceptor is always registered. Custom interceptors
are additional local code, never part of a shared workspace.

## Embedding the backend

```ts
import { createApp } from './src/server/app';

const runtime = await createApp({ dataDir: '/absolute/local/data', interceptors: [] });
const server = runtime.app.listen(7838, '127.0.0.1');
// On shutdown: stop accepting connections, await runtime.close(), then close
// remaining HTTP connections. The normal entrypoint manages this lifecycle.
```

The factory returns `app`, `store`, `manager`, `events`, `usage`, and `close`.
It does not bind a port or initialize Vite, which keeps API tests isolated.

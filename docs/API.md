# API reference

All management endpoints return JSON; errors are `{ error: string }` with a non-2xx status.
Types in `src/shared/types.ts` are canonical. Workspace validation, inheritance,
argument generation and share encoding live in `src/shared`.

## Management endpoints

- `POST /api/version`, `{ "executablePath": "/absolute/path/to/llama-server" }`
  runs a bounded `--version` probe and returns `{ executablePath, version }`.
  The supplied path may be an unsaved form value; this operation does not save it.
- `POST /api/capabilities` accepts optional `{ scope: { kind: "base" } }`,
  `{ scope: { kind: "group", id } }`, or `{ scope: { kind: "model", id } }`.
  It resolves that scope's machine-local executable and returns supported flags,
  help, and available version/compatibility warning information.

`settings.executableOverrides` optionally contains `base`, `groups`, and `models`.
`base` is a path string; `groups`/`models` map configuration IDs to path strings.
Model > Group > Base > `settings.executablePath` determines the selected executable.
Removing the corresponding override restores inheritance.

Portable `llamaVersion` metadata can be attached to the workspace (base),
individual groups, and models. Expectations inherit model > group > base and are
compared to the local executable. `Capabilities.compatibilityWarning` and
`ServerStatus.compatibilityWarning` expose non-blocking version warnings.
All path overrides remain outside workspace exports and deep-links.

Machine settings accept optional `anthropicMode: "passthrough" | "openai"`.
Absent values retain passthrough behavior. With `"openai"`, only
`POST /v1/messages` is translated to upstream `/v1/chat/completions`; the client
still receives Anthropic JSON or SSE. Streaming translation requests
`timings_per_token: true` and usage reports. Native upstream measurements are
observed before response conversion, so token accounting does not depend on
the Anthropic protocol exposing per-token usage.

Machine settings also accept `theme` with one of these stable IDs:
`dark-plus`, `light-plus`, `dracula`, `one-dark-pro`, `github-dark`,
`github-light`, `nord`, `tokyo-night`, `solarized-dark`, or `monokai`.
`PUT /api/settings` persists the choice; `GET /api/bootstrap` returns it in
`settings.theme`. Older settings files without a theme default to `light-plus`.
Omitting `theme` from an update preserves the saved choice. Unknown IDs are
rejected (HTTP 400), and invalid persisted IDs fail validation rather than
silently resetting. Themes are machine-local and excluded from every workspace
export and Hugging Face transfer. No theme import endpoint is provided.

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
- `GET /api/interceptors` -> `InterceptorPipeline`, including locked telemetry and optional environment entries.
- `PUT /api/interceptors`, `{ entries: CustomInterceptorEntry[], trustedCodeAcknowledged: true }` -> saved `InterceptorPipeline`. Replaces only editable local modules; see [pipeline management](#pipeline-management-api) for validation and execution guarantees.
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
array. Add its absolute local path through the sidebar **Interceptors** dialog,
or set `MCM_INTERCEPTOR_MODULE` for a locked environment-managed entry.

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

The locked **Token and cost telemetry** entry always includes both throughput
and persisted usage accounting. Execution order for each hook is: these two
built-ins, environment/embedding interceptors in their supplied order, then
editable modules in saved order (arrays are flattened without changing order).
`onRequest` runs before `beforeRequest`; `onOutboundRequest` observes the final
outgoing headers. Every request snapshots the chain at entry, including all
completion/error hooks; removal and reordering only affect later requests.
Custom code is trusted, not sandboxed, and must complete hooks promptly.

### Pipeline management API

These endpoints use the same localhost Host and same-origin browser guards as
other management APIs. Proxy CORS does not grant access to management routes.

`GET /api/interceptors` returns `{ entries: InterceptorEntry[] }`, in execution order:

```json
{
  "entries": [
    { "id": "builtin-telemetry", "name": "Token and cost telemetry", "source": "builtin", "locked": true },
    { "id": "environment-interceptors", "name": "Environment-configured interceptors", "source": "environment", "locked": true },
    { "id": "custom-request-tag", "name": "Request tag", "modulePath": "/absolute/path/request-tag.ts", "source": "local", "locked": false }
  ]
}
```

The environment entry is omitted when no environment/embedding interceptors are
configured. Its module path and code are not exposed. Custom paths are only
returned by this local management API, not bootstrap/workspace exports.

`PUT /api/interceptors` replaces **only the editable list**, not the locked entries:

```json
{
  "entries": [
    { "id": "custom-request-tag", "name": "Request tag", "modulePath": "/absolute/path/request-tag.ts" }
  ],
  "trustedCodeAcknowledged": true
}
```

An empty `entries` list removes all editable modules but retains both built-ins
and the environment entry. Changing list order changes actual hook order.
Returns the same shape as GET after persistence and activation. The explicit
acknowledgment means the caller trusts the files to execute with MCM permissions;
it is not a sandbox or authentication mechanism.

Strict validation rejects unknown fields (including `enabled`, `locked`, or
`source` in PUT), locked IDs, duplicate IDs/paths, relative paths, URLs, and control
characters. Up to 32 editable modules are accepted. IDs must start with `custom-`
followed by 1–93 ASCII letters, digits, `_`, or `-`. Names are trimmed, nonempty,
at most 100 characters; host-native absolute file paths are at most 4096
characters. Each module must export 1–64 objects, each with at least one recognized
hook; supplied recognized hooks must be functions. Metadata properties are
allowed. Windows absolute paths are supported on Windows, not reinterpreted on
other operating systems.

Updates are serialized. Every module loads and validates before atomic,
owner-only `interceptors.json` persistence, and the active chain changes only
after a successful write. Validation/module failures return 400; filesystem
write failures return 500, leaving the previous active chain unchanged. Failed
startup loading of persisted configuration is fatal, never silently replaced
with an empty pipeline. Concurrent complete-list updates are last-successful-write
wins; refresh/reopen before editing changes from another client.

Importing modules executes trusted code even when a later module/write fails;
import side effects cannot be rolled back. No remote code, uploads, or workspace
code are loaded. Node's module cache is retained: restart MCM to reload edited
files or retry a failed import after fixing its code. Removing an entry does not
unload the module or clean up module-created resources; there is no `onClose`
hook. Custom interceptors are additional local code, never shared workspace data.

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

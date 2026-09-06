# MCM - Model Config Manager

A local-first, TypeScript 7 application for configuring and running llama.cpp.
MCM keeps model configuration portable, machine settings private, and inference
traffic observable without CPU/GPU dashboards.

## Run

Requires Node.js 22.12 or newer and an existing `llama-server` executable.

```sh
npm ci
npm run dev
```

Open **http://localhost:7838**. Development uses Vite middleware and the backend
on the same origin. MCM does not download a model or launch a server until you
configure it and explicitly choose Launch.

For a production frontend:

```sh
npm run build
NODE_ENV=production npm start
```

On PowerShell, set `$env:NODE_ENV = "production"` before `npm start`.
The backend runs TypeScript with `tsx`; the client is bundled into `dist/client`.
`npm run typecheck` uses the native TypeScript 7 compiler (`tsgo`). Its exact
preview build is pinned in `package.json` and the lockfile; the frontend bundler
is not the type checker.

## First launch

1. Open **Machine settings** and enter the executable path and local models directory.
2. Set the llama-server port. This is separate from MCM's HTTP port.
3. Add a model configuration by selecting a discovered GGUF model from the
   dropdown. Its configuration name is filled automatically and can be customized.
   Optionally add an upstream Hugging Face model repository identifier.
4. Assign the model to an optional group and set only the overrides it needs.
5. Map its portable identity to a local GGUF file if its filename is ambiguous
   or differs on your machine.
6. Save, inspect the command, and launch. Status distinguishes process startup
   from a model that is ready to serve requests.

Run the executable capability probe after changing your llama.cpp build.
MCM exposes a curated settings catalog, not every flag from `--help`.
Flag presence is not proof that a particular enum value is supported by a
fork; for example, KVarN cache types require a compatible build.
Unsupported explicitly configured flags prevent launch with an explanation.
Unsupported implicit catalog defaults are omitted with a log warning, allowing
the executable's own default to apply. An unprobed command preview shows the
intended settings before this capability filtering.

## Configuration hierarchy

```text
Catalog defaults < Base configuration < Optional group < Model overrides
```

Base settings apply to every model. A model with no group inherits directly
from base. A value such as `false` or `0` is an explicit override; removing the
override restores inheritance. Groups do not nest.

The editor displays effective values and their source. Settings are grouped
into Compute, Sampling, Memory & context, and Advanced. Dependency rules are
evaluated against the effective configuration, including inherited values.

Model configurations contain a display name, GGUF **filename** and optional
model repository identifier. MCM does not automatically download or guess a
replacement model when a shared filename cannot be resolved locally.

## Portable sharing and local privacy

There are two distinct documents:

| Document | Contents | Shared? |
|---|---|---|
| Workspace | Base, groups, model identities and overrides, schema version | Yes |
| Machine settings | Executable path, model directory/bindings, ports, upstream URL, HF destination/token | No |

Share links include the **complete workspace** in a URL fragment:
`http://localhost:7838/#config=...`. A recipient reviews the workspace and
explicitly confirms replacement. Importing does not launch anything or change
machine settings. Browser fragments are not sent in the HTTP request.

The receiving machine must be running MCM at that origin. If it uses another
host or port, replace the origin while keeping the fragment intact, or import
the exported JSON. A localhost link is not a hosted MCM service.

Links use URL-safe base64, **not encryption**. Anyone with the link can read its
configuration. The share schema rejects machine settings and absolute model
paths. Do not put secrets inside free-text configuration values such as
chat-template options. Very large workspaces should use JSON or Hugging Face
instead of a URL.

## Hugging Face storage

Create a **dataset repository** on Hugging Face, then configure its `owner/name`
and a token with permission to write to that repository. MCM stores portable
configuration at `mcm/workspace.json`.

- **Push** explicitly uploads the current saved workspace.
- **Pull** fetches a preview; it does not overwrite local work until confirmed.
- Public repositories can be read without a token. Private repositories require
  the recipient's own authorized token.
- An MCM `#hf=owner/repository` link opens the corresponding pull preview.
- Local model paths, server locations, ports and authentication tokens are never
  included in the uploaded workspace.

The HF token is stored locally by the backend and is never returned to the
browser. Blank token input preserves the stored token; use the explicit clear
action to remove it. Local storage is not an OS keychain: protect the data
directory and its backups. Network credentials are used only for the explicitly
requested Hugging Face operation.

## Streaming inference gateway

The `/v1` proxy accepts cross-origin browser requests, including `OPTIONS`
preflights and OpenAI/Anthropic authentication headers. Configure browser clients
with `credentials: 'omit'` (or the default `same-origin`); cross-origin cookies
and credentialed CORS are not supported. Management endpoints under `/api`
remain same-origin only. Any website can make inference requests to this local
proxy if the browser permits local-network access, so avoid leaving it running
while browsing untrusted sites. Browser local-network permission prompts and
HTTPS/mixed-content restrictions still apply; CORS does not bypass them.

Point API clients at `http://localhost:7838/v1`. The destination defaults to
the managed llama-server at `http://127.0.0.1:<serverPort>`. Machine settings may
select a different HTTP(S) upstream.
Changing the saved server port applies on the next launch/restart; proxy traffic
continues to use the current managed process's port until it stops.

| Client standard | Example endpoint | Behavior |
|---|---|---|
| OpenAI | `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings` | Protocol-preserving forwarding |
| Anthropic | `/v1/messages` | Protocol-preserving forwarding |

The upstream must implement the requested endpoint and protocol. MCM does
**not** translate Anthropic messages into OpenAI requests, emulate missing
endpoints, or replace upstream errors with success responses.

The gateway preserves streaming output, API-relevant headers, status codes,
backpressure and cancellation. Use your API client's normal authentication
headers for an upstream that requires them. The local Hugging Face storage
token is unrelated and is never injected into inference traffic.

### Throughput, not hardware graphs

The default interceptor observes llama.cpp timing data and available native
Prometheus metrics. The UI displays:

- **PP**: measured prompt-processing tokens per second, when supplied.
- **TG**: measured token-generation tokens per second, when supplied.

Unsupported or missing data is **Unavailable**, not zero, a random value, or an
estimate made by counting SSE chunks. Some upstream builds only report timing
at completion, and some protocols do not carry llama.cpp timing extensions;
the UI can only update when the upstream releases real measurements. Native
Prometheus rates are server-level observations, not necessarily isolated to one
request when clients run concurrently.

### Custom interceptors

The backend exposes typed, trusted-code interceptor hooks. Configure
`MCM_INTERCEPTOR_MODULE` with an absolute local module path to extend request
preparation and response observation. Interceptors are not loaded from shared configuration, URLs or API
request bodies. A module has the same privileges as the MCM process; do not load
untrusted code. See [the API and extension reference](docs/API.md).

An executable TypeScript example is included in `examples/request-tag.ts`:

```sh
MCM_INTERCEPTOR_MODULE="$PWD/examples/request-tag.ts" npm run dev
```

## Architecture

```text
src/shared/   JSON catalog, domain types, validation, inheritance, CLI and links
src/server/   Persistence, discovery, process lifecycle, proxy, metrics, HF, HTTP
src/client/   React UI, React Hook Form editors, local settings, events and sharing
tests/unit/  Shared domain and portability tests
tests/e2e/   Browser workflows and isolated mock llama-server
```

React Hook Form manages forms; a shared Zod schema validates workspace data at
the persistence and import boundaries. Launch arguments are arrays passed to
`spawn`, not commands interpolated into a shell.

MCM is a separate project from `llama-cpp-manager`. It does not modify the old
application or automatically import its localStorage. Its MCP server is
intentionally deferred.

### Extend the settings catalog

Edit `src/shared/catalog.json` and restart development or rebuild production.
Each field declares its key, section, control, default, validation metadata,
optional CLI flag/aliases, optional dependency, and values to omit.

```json
{
  "key": "exampleLimit",
  "label": "Example limit",
  "section": "advanced",
  "control": "number",
  "flag": "--example-limit",
  "default": 4,
  "min": 1,
  "max": 256,
  "integer": true,
  "dependsOn": { "key": "jinja", "equals": true }
}
```

Available controls are `number`, `select`, `toggle`, `text`, and `json`.
`options` defines select choices. A field with no `flag` can act as a UI-only
dependency switch. Both editor rendering and argument generation use this
catalog; no duplicate launch serializer is needed.

Changing an existing key or removing a field may invalidate stored workspaces.
Keep schema compatibility or implement an explicit version migration rather
than silently dropping settings.

## Development and automated coverage

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit/integration tests cover hierarchy, zero/false overrides, catalog rules,
portable links, backend persistence/lifecycle, proxying and metrics.
Playwright covers browser workflows at desktop and mobile sizes. Browser tests
use an isolated data directory and a deliberately fake llama-server: no model
download, GPU, HF account or live inference endpoint is needed.

CI runs the same typecheck, tests, build and browser suite.

## Runtime configuration and deployment boundary

| Variable | Default | Purpose |
|---|---|---|
| `MCM_PORT` | `7838` | Manager UI/API and inference proxy port |
| `MCM_DATA_DIR` | `.mcm` | Local persistent data directory |
| `NODE_ENV` | development behavior | Set `production` to serve the built frontend |
| `MCM_INTERCEPTOR_MODULE` | unset | Trusted local interceptor module |

MCM binds to loopback and is designed for use by the local machine's user.
It is not a multi-user hosted service. Do not expose it through a public reverse
proxy without adding authentication, TLS and an explicit access-control design.
The UI adapts to mobile-sized screens, but remote-device access is not enabled
merely by resizing the interface.

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

### Speculative decoding

The **Speculative decoding** section supports multiple methods through the
**Speculation** checklist. Clear every selection to disable speculation. Selected
methods are passed as a comma-separated `--spec-type` argument and inherit as
one setting; individual draft and n-gram controls inherit normally.

**Standard llama.cpp currently uses its own hardcoded execution priority, not the
order of `--spec-type`.** MCM therefore does not expose ordering controls.
The upstream order is ngram-simple,
ngram-map-k, ngram-map-k4v, ngram-mod, ngram-cache, then draft-simple, draft-eagle3,
draft-mtp, draft-dflash, draft-dspark (only enabled/available methods run).
See [llama.cpp's implementation](https://github.com/ggml-org/llama.cpp/blob/master/common/speculative.cpp).
Controlling actual execution priority requires an upstream implementation change.

Selecting draft-simple, draft-eagle3, draft-dflash, or draft-dspark reveals
**Draft model**, draft GPU layers, CPU threads, KV cache types and maximum draft
tokens. Choose a compatible GGUF from the configured models directory. For
draft-mtp, the model's own MTP head is used, so no external file is required.
Draft methods share one draft-file configuration; selecting multiple methods
does not make incompatible models or combinations compatible.

Selecting ngram-mod reveals its match/minimum/maximum token controls. Inactive
controls are hidden and omitted from launch arguments without deleting saved
overrides. Missing required draft files and unsupported explicit flags fail with
an explanation. Capability probing checks flags; supported method names and
model architectures still depend on your llama.cpp build.

Draft file identities remain portable filenames. For duplicate filenames or
different local layouts, use **Machine settings → Draft file for [model]**.
These per-target-model bindings stay local and are never shared. Existing
single-method settings such as `draft-mtp` and `none` continue to load unchanged.

### Token pricing

The **Token pricing** section appears in Base, Group and Model configurations,
using the same input cards, inheritance badges and **Override / Reset** controls
as other settings. Input and output prices inherit independently:
**Model > Group > Base > defaults**. Defaults are **$0.25 per million input
tokens** and **$2.00 per million output tokens**.

Zero is a valid explicit override; Reset restores the parent's price. Use
**Save changes** to save pricing with the rest of the configuration. Prices
are included when sharing, but never sent as llama-server command-line flags.
Older `basePricing` and model `pricing` metadata are automatically migrated to
standard configuration overrides. Pricing is no longer edited in Edit details.

Model configurations contain a display name, GGUF **filename** and optional
model repository identifier. MCM does not automatically download or guess a
replacement model when a shared filename cannot be resolved locally.

## Portable sharing and local privacy

There are two distinct documents:

| Document | Contents | Shared? |
|---|---|---|
| Workspace | Base, groups, model identities and overrides, schema version | Yes |
| Machine settings | Executable path, model directory/bindings, ports, upstream URL, HF destination/token | No |

When a model is selected, sharing defaults to **Selected model only**, including
its base settings and assigned group so inheritance is preserved. Choose
**All model configurations** to share the complete workspace. This scope applies
to links, JSON downloads and Hugging Face pushes. From Base or a group, sharing
defaults to the whole workspace because no model is selected.

Share links include the chosen configuration snapshot in a URL fragment:
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

In the default passthrough mode, the upstream must implement the requested
endpoint and protocol. MCM does not emulate missing endpoints or replace
upstream errors with success responses.

### Optional Anthropic-to-OpenAI mode

Choose **Machine settings → Anthropic proxy mode → Translate Anthropic to OpenAI**
to route `/v1/messages` through the upstream `/v1/chat/completions` endpoint.
Your client still sends Anthropic requests and receives Anthropic responses.
The default remains **Passthrough**. This is a machine-local setting, not a
shared model option.

This mode addresses a llama.cpp protocol limitation: its native Anthropic stream
does not include per-token timings, and reports output usage only near the end.
Translation requests native timing updates on the OpenAI-compatible path, observes
them for the Inference card, and converts the response back to Anthropic events.
Both streaming and non-streaming messages are supported.

Live PP/TG and token totals still require an upstream that supplies native
measurements, such as a compatible llama.cpp build. Enabling translation does
not manufacture live counts for a provider that only reports usage at completion.
The `/v1/messages/count_tokens` endpoint remains passthrough.

The adapter supports text, base64/URL images, function tools and tool results,
and enabled/disabled/adaptive thinking. Adaptive requests enable the model's
thinking mode without imposing a fixed token budget; the underlying model and
server control reasoning behavior, rather than emulating Anthropic's proprietary
adaptive policy. Unsupported provider-specific content or options
(such as hosted tools or document blocks) return an explicit
error; use passthrough for those features. Cache-control hints, provider metadata,
and thinking signatures are not carried into the local OpenAI prompt. Translation
buffers JSON requests up to 2 MiB, but responses stream with bounded event buffers.
Upstream authentication headers are preserved unchanged; translation does not
convert an `x-api-key` header into a Bearer token.

Docker/container clients may address the inference proxy using a reachable
container-facing hostname such as `host.docker.internal:7838` or `mcm:7838`.
The `/v1` routes accept these Host headers; management APIs and the UI still
require localhost and same-origin access. This does not change MCM's loopback
binding or configure Docker routing: your container must already have a network
path or port forward to MCM. A `403` saying “MCM accepts only localhost requests”
comes from the management Host guard, not a client login requirement.

The gateway preserves streaming output, API-relevant headers, status codes,
backpressure and cancellation. Use your API client's normal authentication
headers for an upstream that requires them. The local Hugging Face storage
token is unrelated and is never injected into inference traffic.

### Throughput, not hardware graphs

The Inference card also includes **All-time** and **Current session** usage:
input tokens, output tokens, their combined total, and **Estimated token value**
in USD. This is the worth of the consumed tokens, not an actual bill, regardless
of whether inference is local or remote. The same rows appear in picture-in-picture.

- A session is one MCM backend run, not one browser tab or model launch.
  Reloading the page, reopening PiP, or restarting llama-server does not reset it.
- All-time totals persist locally across MCM restarts and include the current
  session. Tracking begins when this feature is first used; prior traffic cannot
  be reconstructed.
- Only inference traffic through MCM is counted. Counts come from reported
  response usage/timings, not token estimates, chunk counts, or PP/TG rates.
  Requests with missing usage are flagged; unreported tokens cannot be counted.
  Totals and token value update live as streaming usage/timing reports arrive.
  Repeated cumulative reports replace the current request's contribution rather
  than being counted again. On cancellation or failure, only usage
  already reported by the upstream is retained and marked incomplete.
- Prices are captured per request. Cost is
  `(inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1,000,000`.
  Changing a model's price affects future requests, not historical totals.
- Traffic without identifiable model pricing uses Base configuration prices.
  Older usage recorded before this fallback existed can remain unpriced; those
  tokens are shown explicitly and excluded from the recorded value. The result
  uses flat input/output rates, not a provider invoice.
- Usage history is machine-local and separate from shared configurations.
  Sharing, importing or deleting a configuration does not export or erase it.
  It is stored in `usage.json` inside `MCM_DATA_DIR`.

In-flight usage is shown in both rows and is persisted once the request ends.
An upstream that reports usage only at completion cannot provide live counts.
For OpenAI-style llama.cpp streaming requests, request `timings_per_token: true`
when supported to receive native timing/count updates during generation. For
Anthropic clients, enable the optional translation mode described above; the
native Anthropic endpoint does not forward that option. MCM never treats a
text chunk as a token or invents counts for upstreams that omit them.

For managed inference, costs use the active model configuration. With an external
upstream, the outgoing request's `model` must unambiguously match a configuration's
ID, display name, GGUF filename, or model repository to use model-specific pricing.
Unknown or ambiguous models use Base configuration pricing. Explicit API usage takes precedence over native timing
counts, which may describe only evaluated tokens. Anthropic cache-read and
cache-creation input counts are included once and use the same configured input
rate; separate cache pricing tiers are not modeled.

An explicit Upstream URL pointing to the managed server's current HTTP port at
`localhost` or `127.0.0.1` also uses the active model's pricing. A different
upstream still requires an unambiguous model match to override Base pricing.
Historical **Unpriced** values do not mean the tokens were free.

Request-specific timings take precedence over server-wide polling once available.
Partial timing events retain previously measured rates for that request; zero-token
timing placeholders do not replace them. The card follows the most recently started
inference request, rather than alternating between concurrent requests or model-list
requests. A new inference request starts with unavailable timings until measured.

Choose **Picture-in-picture** above the Inference card to move its live throughput
and token counts into an always-on-top window. Executable controls and server logs
stay on the main page. Close the PiP window or use **Restore inference card**
on the main page to restore it. Keep the main MCM tab open: it owns the event
The PiP window opens at a compact 280-pixel width, sized to the current card
content with a 32-pixel buffer if the request input/output row has not appeared yet. Unpriced-token explanations and the session footnote stay on the main
page. Browsers require a user gesture for subsequent window resizing; if later
content needs more space, resize the window or reopen PiP. Keep the main MCM tab open: it owns the event
stream. Native Document Picture-in-Picture requires a supporting browser and
a secure context (localhost qualifies). Other browsers use a floating panel
inside the current tab, not an always-on-top OS window.

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

Available controls are `number`, `select`, `toggle`, `text`, `json`,
`multi-select`, and `model-file`.
`options` defines select choices. A field with no `flag` can act as a UI-only
dependency switch. Both editor rendering and argument generation use this
catalog; no duplicate launch serializer is needed.

A `multi-select` stores comma-separated method names, or `none`
for an empty selection. Its `options` exclude the `none` sentinel. `model-file` stores
a GGUF filename and requires server-side local resolution before argv generation.
Use `dependsOn: { "key": "speculation", "containsAny": ["draft-simple", "draft-dflash"] }`
for list membership dependencies, and `hideWhenDisabled: true` to hide inactive
controls. `required: true` enforces a value before launch when its dependency is active.

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
